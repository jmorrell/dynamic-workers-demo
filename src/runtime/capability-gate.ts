import { WorkerEntrypoint } from 'cloudflare:workers';
import { clampFetchDepth, clampMaxFetches, DEFAULT_MAX_FETCHES, guardFetchUrl, truncateBody } from './core';
import { extractLinkedResources } from './extract-urls';
import type { GateResourceResult, ResourceGrant } from './types';
import type { GateSpanDraft } from './trace';

/**
 * Default per-run total cap on resource reads, when a run doesn't override it via
 * `permissions.maxFetches` (mirrors the loaded worker's `limits.subRequests` in
 * that case). Re-exported from `core.ts`'s `DEFAULT_MAX_FETCHES` — the canonical
 * constant, also used by `clampMaxFetches` — so existing tests/imports that
 * reference `GATE_MAX_FETCHES` keep working. The actual enforced cap per run is
 * `clampMaxFetches(props.maxFetches)`, not this constant.
 */
export const GATE_MAX_FETCHES = DEFAULT_MAX_FETCHES;
/** Timeout for a single resource read (matches fetchTarget). */
const GATE_TIMEOUT_MS = 8000;
/** Body cap for textual resources (UTF-8-boundary truncation, like fetchTarget). */
const GATE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Byte cap for binary resources. */
const GATE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Per-run cap on how many child capabilities (from transitive fetchDepth
 * expansion) can accumulate. This bounds memory only — it is generous relative
 * to the real reachability bound, which is the run's granted `maxFetches`
 * (clamped to [1,100] — see `clampMaxFetches` in core.ts): only that many gate
 * fetches can ever happen per run, so at most that many pages can ever
 * contribute grown URLs.
 */
export const GATE_MAX_GROWN_URLS = 5000;

type GateProps = {
	runId: string;
	initialResources: ReadonlyArray<ResourceGrant>;
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

type GrownResource = ResourceGrant & { depth: number };

// Child capabilities minted from successfully read text resources. Opaque id
// -> its host-owned URL/source/depth. A fresh WorkerEntrypoint is created per RPC
// call, so this must share the same module-scoped lifetime as the fetch counter.
const grownResources = new Map<string, Map<string, GrownResource>>();
const grownResourceIdsByUrl = new Map<string, Map<string, string>>();

// Per-run gate-call spans (one draft per resource read, including
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
 * Best-effort in-memory hygiene: clears a run's fetchCounts, child resources,
 * and gate-span entries. Call after a run finishes reading its logs (and, for
 * spans, after the host has drained them via collectGateSpans). The loopback
 * shares module scope across runs in practice (workerd may reuse the isolate),
 * so skipping this would leak entries indefinitely, but correctness never
 * depends on it running — a runId is never reused, so stale entries just sit
 * unused until released.
 */
export function releaseGateRun(runId: string): void {
	fetchCounts.delete(runId);
	grownResources.delete(runId);
	grownResourceIdsByUrl.delete(runId);
	gateSpans.delete(runId);
}

/**
 * Host-side loopback the sandbox reaches for permitted outbound fetches. Reached
 * from the loaded worker via `ctx.exports.CapabilityGate({ props })` attached as
 * `env.GATE`. All policy lives here: the sandbox holds no bindings and never sees
 * host secrets — only the plain data these methods return.
 *
 * `readResource` first resolves an opaque id to host-owned authority, then
 * enforces the SSRF guard, per-run read cap, timeout, and response-size cap.
 */
export class CapabilityGate extends WorkerEntrypoint<Env> {
	private props(): GateProps {
		return this.ctx.props as GateProps;
	}

	private resolveResource(id: string): GrownResource | undefined {
		const { runId, initialResources } = this.props();
		const initial = initialResources.find((resource) => resource.id === id);
		if (initial) return { ...initial, depth: 1 };
		return grownResources.get(runId)?.get(id);
	}

	// Resolves opaque authority before applying the usual URL and budget guards.
	private authorize(id: string): { resource: GrownResource; url: URL } {
		const { runId } = this.props();
		const startAbsMs = performance.now();
		const resource = this.resolveResource(id);
		const displayUrl = resource?.url ?? '<unknown capability>';

		// Records a ~0-duration error span for a denial.
		const recordDenial = (reason: string): void => {
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'error',
				attrs: { name: 'resource.read', kind: 'gate_resource_read', url: displayUrl, denied: reason },
			});
		};

		if (!resource) {
			const reason = 'unknown or forged resource capability';
			recordDenial(reason);
			throw new Error(`resource.read denied: ${reason}`);
		}

		const guarded = guardFetchUrl(resource.url);
		if (!guarded.ok) {
			recordDenial(guarded.reason);
			throw new Error(`resource.read denied: ${guarded.reason}`);
		}

		const { maxFetches } = this.props();
		const grantedMaxFetches = clampMaxFetches(maxFetches);
		const used = fetchCounts.get(runId) ?? 0;
		if (used >= grantedMaxFetches) {
			const reason = `exceeded the ${grantedMaxFetches}-read limit for this run`;
			recordDenial(reason);
			throw new Error(`resource.read denied: ${reason}`);
		}
		fetchCounts.set(runId, used + 1);

		return { resource, url: guarded.url };
	}

	// Mints child capabilities for URLs linked from a successfully read text
	// resource at depth+1, stopping at the granted depth and memory cap. Existing
	// root or child URLs reuse their original opaque grant.
	private mintChildResources(runId: string, fetchedUrl: string, depth: number, body: string, contentType: string): ResourceGrant[] {
		const { fetchDepth, initialResources } = this.props();
		if (depth >= clampFetchDepth(fetchDepth)) return [];

		let grown = grownResources.get(runId);
		if (!grown) {
			grown = new Map<string, GrownResource>();
			grownResources.set(runId, grown);
		}
		let idsByUrl = grownResourceIdsByUrl.get(runId);
		if (!idsByUrl) {
			idsByUrl = new Map<string, string>();
			grownResourceIdsByUrl.set(runId, idsByUrl);
		}

		const nextDepth = depth + 1;
		const grants: ResourceGrant[] = [];
		for (const descriptor of extractLinkedResources(body, contentType, fetchedUrl)) {
			if (grown.size >= GATE_MAX_GROWN_URLS) break;
			const initial = initialResources.find((resource) => resource.url === descriptor.url);
			if (initial) {
				grants.push(initial);
				continue;
			}
			const existingId = idsByUrl.get(descriptor.url);
			const existing = existingId ? grown.get(existingId) : undefined;
			if (existing) {
				grants.push({ id: existing.id, url: existing.url, source: existing.source });
				continue;
			}
			const grant: ResourceGrant = { ...descriptor, id: crypto.randomUUID() };
			grown.set(grant.id, { ...grant, depth: nextDepth });
			idsByUrl.set(grant.url, grant.id);
			grants.push(grant);
		}
		return grants;
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

	async readResource(id: string): Promise<GateResourceResult> {
		const { runId } = this.props();
		const startAbsMs = performance.now();
		const { resource, url: target } = this.authorize(id);
		try {
			const response = await this.doFetch(target);
			const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
			let result: GateResourceResult;
			let byteLength: number;
			if (isTextContentType(contentType)) {
				const raw = await response.text();
				const { body, truncated } = truncateBody(raw, GATE_TEXT_MAX_BYTES);
				const resources = response.ok
					? this.mintChildResources(runId, target.toString(), resource.depth, body, contentType)
					: [];
				result = { kind: 'text', status: response.status, contentType, body, truncated, resources };
				byteLength = new TextEncoder().encode(body).byteLength;
			} else {
				const full = new Uint8Array(await response.arrayBuffer());
				const truncated = full.byteLength > GATE_FILE_MAX_BYTES;
				const bytes = truncated ? full.slice(0, GATE_FILE_MAX_BYTES) : full;
				result = { kind: 'bytes', status: response.status, contentType, bytes, truncated };
				byteLength = bytes.byteLength;
			}
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'ok',
				attrs: {
					name: 'resource.read',
					kind: 'gate_resource_read',
					url: resource.url,
					httpStatus: response.status,
					bytes: byteLength,
					truncated: result.truncated,
					depth: resource.depth,
					resourceKind: result.kind,
				},
			});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordGateSpan(runId, {
				startAbsMs,
				endAbsMs: performance.now(),
				status: 'error',
				attrs: { name: 'resource.read', kind: 'gate_resource_read', url: resource.url, error: message, depth: resource.depth },
			});
			throw err;
		}
	}
}

export function isTextContentType(contentType: string): boolean {
	const type = contentType.split(';')[0].trim().toLowerCase();
	return (
		type.startsWith('text/') ||
		type === 'application/json' ||
		type.endsWith('+json') ||
		type === 'application/xml' ||
		type.endsWith('+xml') ||
		type === 'application/javascript' ||
		type === 'application/x-javascript' ||
		type === 'application/x-www-form-urlencoded'
	);
}
