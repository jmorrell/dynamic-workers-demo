import { WorkerEntrypoint } from 'cloudflare:workers';
import { clampFetchDepth, clampMaxFetches, DEFAULT_MAX_FETCHES, guardFetchUrl, truncateBody } from './core';
import { extractLinkedUrls } from './extract-urls';
import type { FetchFileResult, FetchTextResult } from './types';
import type { GateSpanDraft } from './trace';

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

// Per-run gate-call spans (one draft per env.fetch/env.fetchFile call, including
// denials), recorded for the host's trace assembly. Same module-scope trade-off
// as fetchCounts/grownAllowlists above (a fresh WorkerEntrypoint per RPC call
// means this can't be instance state). The host drains these via
// collectGateSpans after the run completes and normalizes the absolute
// performance.now() timestamps to the run's start (the gate has no notion of
// "run start" — only the host does).
const gateSpans = new Map<string, GateSpanDraft[]>();

function recordGateSpan(runId: string, draft: GateSpanDraft): void {
	let spans = gateSpans.get(runId);
	if (!spans) {
		spans = [];
		gateSpans.set(runId, spans);
	}
	spans.push(draft);
}

/**
 * Drains a run's recorded gate-call span drafts (does NOT clear them — see
 * releaseGateRun for that). Called by the host after the run completes, before
 * releaseGateRun's cleanup, so the host can fold these into its Tracer.
 */
export function collectGateSpans(runId: string): GateSpanDraft[] {
	return gateSpans.get(runId) ?? [];
}

/**
 * Best-effort in-memory hygiene: clears a run's fetchCounts, grown-allowlist,
 * and gate-span entries. Call after a run finishes reading its logs (and, for
 * spans, after the host has drained them via collectGateSpans). The loopback
 * shares module scope across runs in practice (workerd may reuse the isolate),
 * so skipping this would leak entries indefinitely, but correctness never
 * depends on it running — a runId is never reused, so stale entries just sit
 * unused until released.
 */
export function releaseGateRun(runId: string): void {
	fetchCounts.delete(runId);
	grownAllowlists.delete(runId);
	gateSpans.delete(runId);
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

	// callKind identifies which public method is authorizing (fetchText vs
	// fetchFile) purely so a denial span can carry the right name/kind — the
	// thrown message text is unchanged either way (transform-visible behavior
	// must not change).
	private authorize(url: string, callKind: 'gate_fetch_text' | 'gate_fetch_file'): { url: URL; depth: number } {
		const { runId } = this.props();
		const name = callKind === 'gate_fetch_text' ? 'env.fetch' : 'env.fetchFile';
		const startAbsMs = performance.now();

		// Records a ~0-duration error span for a denial. Not routed through a
		// shared "deny and throw" helper: a helper typed to return `never` doesn't
		// narrow the caller's union-typed locals across the call in this codebase's
		// TS config, so each denial site below still throws directly (unchanged
		// message — transform-visible behavior must not change).
		const recordDenial = (reason: string): void => {
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'error',
				attrs: { name, kind: callKind, url, denied: reason },
			});
		};

		const guarded = guardFetchUrl(url);
		if (!guarded.ok) {
			recordDenial(guarded.reason);
			throw new Error(`env.fetch denied: ${guarded.reason}`);
		}

		const normalized = guarded.url.toString();
		const depth = this.resolveDepth(normalized);
		if (depth === undefined) {
			const reason = `${normalized} is not reachable within the granted fetch depth from the fetched page`;
			recordDenial(reason);
			throw new Error(`env.fetch denied: ${reason}`);
		}

		const { maxFetches } = this.props();
		const grantedMaxFetches = clampMaxFetches(maxFetches);
		const used = fetchCounts.get(runId) ?? 0;
		if (used >= grantedMaxFetches) {
			const reason = `exceeded the ${grantedMaxFetches}-fetch limit for this run`;
			recordDenial(reason);
			throw new Error(`env.fetch denied: ${reason}`);
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
		const { runId } = this.props();
		const startAbsMs = performance.now();
		const { url: target, depth } = this.authorize(url, 'gate_fetch_text');
		try {
			const response = await this.doFetch(target);
			const contentType = response.headers.get('content-type') ?? 'text/plain';
			const raw = await response.text();
			const { body, truncated } = truncateBody(raw, GATE_TEXT_MAX_BYTES);
			if (response.ok) {
				this.growAllowlist(runId, target.toString(), depth, body, contentType);
			}
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'ok',
				attrs: { name: 'env.fetch', kind: 'gate_fetch_text', url, httpStatus: response.status, bytes: body.length, truncated, depth },
			});
			return { status: response.status, contentType, body, truncated };
		} catch (err) {
			// Rethrown unchanged (timeout/abort etc.) — only the span records the
			// failure; transform-visible behavior is untouched.
			const message = err instanceof Error ? err.message : String(err);
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'error',
				attrs: { name: 'env.fetch', kind: 'gate_fetch_text', url, error: message, depth },
			});
			throw err;
		}
	}

	// Never grows the allowlist: fetchFile responses are treated as opaque binary
	// data, and link extraction is text-only.
	async fetchFile(url: string): Promise<FetchFileResult> {
		const { runId } = this.props();
		const startAbsMs = performance.now();
		const { url: target, depth } = this.authorize(url, 'gate_fetch_file');
		try {
			const response = await this.doFetch(target);
			const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
			const full = new Uint8Array(await response.arrayBuffer());
			const truncated = full.byteLength > GATE_FILE_MAX_BYTES;
			const bytes = truncated ? full.slice(0, GATE_FILE_MAX_BYTES) : full;
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'ok',
				attrs: { name: 'env.fetchFile', kind: 'gate_fetch_file', url, httpStatus: response.status, bytes: bytes.byteLength, truncated, depth },
			});
			return { status: response.status, contentType, bytes, truncated };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'error',
				attrs: { name: 'env.fetchFile', kind: 'gate_fetch_file', url, error: message, depth },
			});
			throw err;
		}
	}
}
