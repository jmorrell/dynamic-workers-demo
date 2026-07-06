import { WorkerEntrypoint } from 'cloudflare:workers';
import { clampFetchDepth, clampMaxFetches, DEFAULT_MAX_FETCHES, guardFetchUrl, truncateBody } from './core';
import { extractLinkedUrls } from './extract-urls';
import type { FetchFileResult, FetchTextResult } from './types';

/**
 * Default per-run total cap on gate fetches, when a run doesn't override it via
 * `permissions.maxFetches` (mirrors the loaded worker's `limits.subRequests` in
 * that case). Re-exported from `core.ts`'s `DEFAULT_MAX_FETCHES` — the canonical
 * constant, also used by `clampMaxFetches` — so existing tests/imports that
 * reference `GATE_MAX_FETCHES` keep working. The actual enforced cap per run is
 * `clampMaxFetches(props.maxFetches)`, not this constant.
 */
export const GATE_MAX_FETCHES = DEFAULT_MAX_FETCHES;
/** Timeout for a single gate fetch (matches fetchTarget). */
const GATE_TIMEOUT_MS = 8000;
/** Body cap for fetchText (UTF-8-boundary truncation, like fetchTarget). */
const GATE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Byte cap for fetchFile. */
const GATE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Per-run cap on how many grown-allowlist entries (from transitive fetchDepth
 * expansion) can accumulate. This bounds memory only — it is generous relative
 * to the real reachability bound, which is the run's granted `maxFetches`
 * (clamped to [1,100] — see `clampMaxFetches` in core.ts): only that many gate
 * fetches can ever happen per run, so at most that many pages can ever
 * contribute grown URLs.
 */
export const GATE_MAX_GROWN_URLS = 5000;

type GateProps = {
	runId: string;
	allowedUrls: ReadonlyArray<string>;
	fetchDepth: number;
	maxFetches: number;
};

// Per-run fetch tally. workerd instantiates a fresh WorkerEntrypoint per RPC
// call, so instance fields would reset each call — the count must live at module
// scope, keyed by runId, to survive across a run's gate calls (same trade-off as
// LogSession's in-memory state). The sandbox's own limits.subRequests caps this
// from the other side in production; this host-side tally is the enforced,
// locally-testable half.
const fetchCounts = new Map<string, number>();

// Per-run allowlist growth from transitive fetchDepth expansion: normalized URL
// -> the depth at which it became reachable. Same module-scope trade-off as
// fetchCounts (a fresh WorkerEntrypoint per RPC call means this can't be instance
// state). Depth 1 entries live in props.allowedUrls, never here.
const grownAllowlists = new Map<string, Map<string, number>>();

/**
 * Best-effort in-memory hygiene: clears a run's fetchCounts and grown-allowlist
 * entries. Call after a run finishes reading its logs. The loopback shares module
 * scope across runs in practice (workerd may reuse the isolate), so skipping this
 * would leak entries indefinitely, but correctness never depends on it running —
 * a runId is never reused, so stale entries just sit unused until released.
 */
export function releaseGateRun(runId: string): void {
	fetchCounts.delete(runId);
	grownAllowlists.delete(runId);
}

/**
 * Host-side loopback the sandbox reaches for permitted outbound fetches. Reached
 * from the loaded worker via `ctx.exports.CapabilityGate({ props })` attached as
 * `env.GATE`. All policy lives here: the sandbox holds no bindings and never sees
 * host secrets — only the plain data these methods return.
 *
 * Both methods enforce, in order: the SSRF host guard, an exact-match allowlist
 * (the URL must be a link from the originally fetched page, or — up to the
 * granted `fetchDepth` — a link from a page the run has since successfully
 * text-fetched), a per-run fetch count cap, an 8s timeout, and a size cap.
 */
export class CapabilityGate extends WorkerEntrypoint<Env> {
	private props(): GateProps {
		return this.ctx.props as GateProps;
	}

	// Resolves the requested URL's depth: 1 if it's in the original allowlist,
	// else its recorded grown depth, else undefined (deny).
	private resolveDepth(normalized: string): number | undefined {
		const { runId, allowedUrls } = this.props();
		if (allowedUrls.includes(normalized)) return 1;
		return grownAllowlists.get(runId)?.get(normalized);
	}

	private authorize(url: string): { url: URL; depth: number } {
		const guarded = guardFetchUrl(url);
		if (!guarded.ok) {
			throw new Error(`env.fetch denied: ${guarded.reason}`);
		}

		const normalized = guarded.url.toString();
		const depth = this.resolveDepth(normalized);
		if (depth === undefined) {
			throw new Error(`env.fetch denied: ${normalized} is not reachable within the granted fetch depth from the fetched page`);
		}

		const { runId, maxFetches } = this.props();
		const grantedMaxFetches = clampMaxFetches(maxFetches);
		const used = fetchCounts.get(runId) ?? 0;
		if (used >= grantedMaxFetches) {
			throw new Error(`env.fetch denied: exceeded the ${grantedMaxFetches}-fetch limit for this run`);
		}
		fetchCounts.set(runId, used + 1);

		return { url: guarded.url, depth };
	}

	// Records URLs linked from a successfully fetched page at depth+1, when the
	// fetched page's own depth is still below the run's granted fetchDepth. Never
	// overwrites an existing entry with a higher depth (a URL reachable at depth 2
	// stays at depth 2 even if also linked from a depth-3 page), skips URLs already
	// in props.allowedUrls (depth 1, no need to track separately), and stops once
	// GATE_MAX_GROWN_URLS total grown entries exist for this run.
	private growAllowlist(runId: string, fetchedUrl: string, depth: number, body: string, contentType: string): void {
		const { fetchDepth, allowedUrls } = this.props();
		if (depth >= clampFetchDepth(fetchDepth)) return;

		let grown = grownAllowlists.get(runId);
		if (!grown) {
			grown = new Map<string, number>();
			grownAllowlists.set(runId, grown);
		}

		const nextDepth = depth + 1;
		for (const linked of extractLinkedUrls(body, contentType, fetchedUrl)) {
			if (grown.size >= GATE_MAX_GROWN_URLS) break;
			if (allowedUrls.includes(linked)) continue;
			const existing = grown.get(linked);
			if (existing === undefined || nextDepth < existing) {
				grown.set(linked, nextDepth);
			}
		}
	}

	private async doFetch(url: URL): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
		try {
			return await fetch(url.toString(), {
				signal: controller.signal,
				// Redirects are intentionally NOT followed: an allowlisted URL could
				// 302 to a private/loopback address, and following it would fetch
				// that address with the allowlist already satisfied, bypassing
				// guardFetchUrl. A 3xx comes back to the transform as a plain
				// { status: 3xx, ... } result instead.
				redirect: 'manual',
				headers: {
					'User-Agent': 'DynamicWorkersDemo/1.0 (+https://github.com/; transform sandbox)',
				},
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// Grows the allowlist on success (see growAllowlist); fetchFile never does —
	// binary responses have no text to extract links from.
	async fetchText(url: string): Promise<FetchTextResult> {
		const { url: target, depth } = this.authorize(url);
		const response = await this.doFetch(target);
		const contentType = response.headers.get('content-type') ?? 'text/plain';
		const raw = await response.text();
		const { body, truncated } = truncateBody(raw, GATE_TEXT_MAX_BYTES);
		if (response.ok) {
			this.growAllowlist(this.props().runId, target.toString(), depth, body, contentType);
		}
		return { status: response.status, contentType, body, truncated };
	}

	// Never grows the allowlist: fetchFile responses are treated as opaque binary
	// data, and link extraction is text-only.
	async fetchFile(url: string): Promise<FetchFileResult> {
		const { url: target } = this.authorize(url);
		const response = await this.doFetch(target);
		const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
		const full = new Uint8Array(await response.arrayBuffer());
		const truncated = full.byteLength > GATE_FILE_MAX_BYTES;
		const bytes = truncated ? full.slice(0, GATE_FILE_MAX_BYTES) : full;
		return { status: response.status, contentType, bytes, truncated };
	}
}
