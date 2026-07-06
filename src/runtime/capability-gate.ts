import { WorkerEntrypoint } from 'cloudflare:workers';
import { guardFetchUrl, truncateBody } from './core';
import type { FetchFileResult, FetchTextResult } from './types';

/** Per-run total cap on gate fetches (mirrors the loaded worker's limits.subRequests). */
export const GATE_MAX_FETCHES = 5;
/** Timeout for a single gate fetch (matches fetchTarget). */
const GATE_TIMEOUT_MS = 8000;
/** Body cap for fetchText (UTF-8-boundary truncation, like fetchTarget). */
const GATE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Byte cap for fetchFile. */
const GATE_FILE_MAX_BYTES = 20 * 1024 * 1024;

type GateProps = {
	runId: string;
	allowedUrls: ReadonlyArray<string>;
};

// Per-run fetch tally. workerd instantiates a fresh WorkerEntrypoint per RPC
// call, so instance fields would reset each call — the count must live at module
// scope, keyed by runId, to survive across a run's gate calls (same trade-off as
// LogSession's in-memory state). The sandbox's own limits.subRequests caps this
// from the other side in production; this host-side tally is the enforced,
// locally-testable half.
const fetchCounts = new Map<string, number>();

/**
 * Host-side loopback the sandbox reaches for permitted outbound fetches. Reached
 * from the loaded worker via `ctx.exports.CapabilityGate({ props })` attached as
 * `env.GATE`. All policy lives here: the sandbox holds no bindings and never sees
 * host secrets — only the plain data these methods return.
 *
 * Both methods enforce, in order: an exact-match allowlist (the URL must appear
 * in the originally fetched page's links), the SSRF host guard, a per-run fetch
 * count cap, an 8s timeout, and a size cap.
 */
export class CapabilityGate extends WorkerEntrypoint<Env> {
	private props(): GateProps {
		return this.ctx.props as GateProps;
	}

	private authorize(url: string): URL {
		const guarded = guardFetchUrl(url);
		if (!guarded.ok) {
			throw new Error(`env.fetch denied: ${guarded.reason}`);
		}

		const normalized = guarded.url.toString();
		const { runId, allowedUrls } = this.props();
		if (!allowedUrls.includes(normalized)) {
			throw new Error(`env.fetch denied: ${normalized} is not referenced by the fetched page`);
		}

		const used = fetchCounts.get(runId) ?? 0;
		if (used >= GATE_MAX_FETCHES) {
			throw new Error(`env.fetch denied: exceeded the ${GATE_MAX_FETCHES}-fetch limit for this run`);
		}
		fetchCounts.set(runId, used + 1);

		return guarded.url;
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

	async fetchText(url: string): Promise<FetchTextResult> {
		const target = this.authorize(url);
		const response = await this.doFetch(target);
		const contentType = response.headers.get('content-type') ?? 'text/plain';
		const raw = await response.text();
		const { body, truncated } = truncateBody(raw, GATE_TEXT_MAX_BYTES);
		return { status: response.status, contentType, body, truncated };
	}

	async fetchFile(url: string): Promise<FetchFileResult> {
		const target = this.authorize(url);
		const response = await this.doFetch(target);
		const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
		const full = new Uint8Array(await response.arrayBuffer());
		const truncated = full.byteLength > GATE_FILE_MAX_BYTES;
		const bytes = truncated ? full.slice(0, GATE_FILE_MAX_BYTES) : full;
		return { status: response.status, contentType, bytes, truncated };
	}
}
