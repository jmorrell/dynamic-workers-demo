import type { Permissions, RunErrorKind } from './types';

/** Hard bounds for a permission's CPU budget, clamped server-side. */
export const CPU_MS_MIN = 1;
export const CPU_MS_MAX = 5000;

/**
 * Clamps a caller-supplied CPU budget into [CPU_MS_MIN, CPU_MS_MAX]. An absent
 * or non-finite value falls back to `fallback` (the platform default).
 */
export function clampCpuMs(cpuMs: number | undefined, fallback: number): number {
	if (typeof cpuMs !== 'number' || !Number.isFinite(cpuMs)) return fallback;
	return Math.max(CPU_MS_MIN, Math.min(CPU_MS_MAX, Math.round(cpuMs)));
}

/** Hard bounds for a permission's transitive-fetch depth, clamped server-side. */
export const FETCH_DEPTH_MIN = 1;
export const FETCH_DEPTH_MAX = 3;

/**
 * Clamps a caller-supplied fetch depth into [FETCH_DEPTH_MIN, FETCH_DEPTH_MAX]. An
 * absent or non-finite value falls back to 1 (exactly today's page-links behavior).
 */
export function clampFetchDepth(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return FETCH_DEPTH_MIN;
	return Math.max(FETCH_DEPTH_MIN, Math.min(FETCH_DEPTH_MAX, Math.round(value)));
}

/** Narrowing validator for a caller-supplied Permissions object (custom runs). */
export function isValidPermissions(value: unknown): value is Permissions {
	if (typeof value !== 'object' || value === null) return false;
	const fetch = (value as Record<string, unknown>).fetch;
	if (fetch !== 'page-links' && fetch !== 'none') return false;
	const cpuMs = (value as Record<string, unknown>).cpuMs;
	if (cpuMs !== undefined && typeof cpuMs !== 'number') return false;
	const fetchDepth = (value as Record<string, unknown>).fetchDepth;
	if (fetchDepth !== undefined && typeof fetchDepth !== 'number') return false;
	return true;
}

/** Hard bounds for a custom run's declared wasm modules. */
export const MAX_CUSTOM_MODULES = 4;
export const MAX_MODULE_BYTES = 8 * 1024 * 1024; // 8 MiB
const CUSTOM_MODULE_NAME_RE = /^[A-Za-z0-9._-]+\.wasm$/;

/**
 * Decodes a base64 string to bytes, or null if it isn't valid base64. Pure
 * wrapper around the standard atob (available in the Workers runtime).
 */
export function decodeBase64(base64: string): Uint8Array | null {
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/**
 * Validates and decodes a custom run's `worker.modules` field (untrusted
 * request input): at most `MAX_CUSTOM_MODULES` entries, each with a `.wasm`
 * name (not shadowing `harness.js`/`user.js`) matching `CUSTOM_MODULE_NAME_RE`,
 * valid base64, decoding to at most `MAX_MODULE_BYTES`. Returns the decoded
 * bytes keyed by module name, or a human-readable rejection reason.
 */
export function validateCustomModules(value: unknown): { ok: true; modules: Record<string, Uint8Array> } | { ok: false; message: string } {
	if (!Array.isArray(value)) return { ok: false, message: 'modules must be an array' };
	if (value.length > MAX_CUSTOM_MODULES) return { ok: false, message: `modules must contain at most ${MAX_CUSTOM_MODULES} entries` };

	const modules: Record<string, Uint8Array> = {};
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) return { ok: false, message: 'each module must be an object' };
		const { name, kind, base64 } = entry as Record<string, unknown>;

		if (typeof name !== 'string' || !CUSTOM_MODULE_NAME_RE.test(name)) {
			return { ok: false, message: `invalid module name: ${String(name)}` };
		}
		if (name === 'harness.js' || name === 'user.js') {
			return { ok: false, message: `module name may not be "${name}"` };
		}
		if (kind !== 'wasm') {
			return { ok: false, message: `unsupported module kind: ${String(kind)}` };
		}
		if (typeof base64 !== 'string') {
			return { ok: false, message: `module "${name}" is missing base64 content` };
		}

		const bytes = decodeBase64(base64);
		if (!bytes) return { ok: false, message: `module "${name}" has invalid base64 content` };
		if (bytes.byteLength > MAX_MODULE_BYTES) return { ok: false, message: `module "${name}" exceeds the ${MAX_MODULE_BYTES}-byte cap` };

		modules[name] = bytes;
	}

	return { ok: true, modules };
}

/**
 * SSRF guard for outbound fetch targets (the target page fetch and every
 * CapabilityGate fetch). Rejects non-http(s) schemes and hostnames that are
 * loopback/private/link-local IP literals or obvious local names. This is a
 * best-effort literal-host check — it does not resolve DNS (the runtime does
 * that), but it blocks the direct-IP and localhost SSRF paths.
 *
 * Returns the normalized URL on success, or a human-readable reason on rejection.
 */
export function guardFetchUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: `invalid URL: ${rawUrl}` };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: `unsupported protocol: ${url.protocol}` };
	}

	if (isBlockedHost(url.hostname)) {
		return { ok: false, reason: `blocked host (private/loopback/link-local): ${url.hostname}` };
	}

	return { ok: true, url };
}

/** True when a hostname is a loopback/private/link-local IP literal or local name. */
function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase();

	if (host === 'localhost' || host.endsWith('.localhost')) return true;

	// IPv6 literal (URL hostname strips the surrounding brackets).
	if (host.includes(':')) {
		const h = host.replace(/^\[|\]$/g, '');
		if (h === '::1' || h === '::') return true;
		if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
		if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
		// IPv4-mapped IPv6 (::ffff:a.b.c.d)
		const mapped = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
		if (mapped) return isBlockedIpv4(mapped[1]);
		return false;
	}

	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return isBlockedIpv4(host);

	return false;
}

function isBlockedIpv4(ip: string): boolean {
	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10.0.0.0/8 private
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	return false;
}

/**
 * Computes SHA-256 hash of code string for loader cache id.
 * Identical code produces identical hash.
 */
export async function hashCode(code: string): Promise<string> {
	const bytes = new TextEncoder().encode(code);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hexArray = Array.from(new Uint8Array(digest));
	return hexArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Truncates body to maxBytes UTF-8 byte length, respecting character boundaries.
 * Returns the truncated body and a flag indicating if truncation occurred.
 *
 * Efficiently walks back from maxBytes over UTF-8 continuation bytes (0x80-0xBF)
 * to find a safe character boundary, then decodes once.
 */
export function truncateBody(body: string, maxBytes: number): { body: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(body);

	if (encoded.byteLength <= maxBytes) {
		return { body, truncated: false };
	}

	// Walk back from maxBytes to find a safe UTF-8 character boundary.
	// We need to ensure we only include complete, valid UTF-8 sequences.
	//
	// UTF-8 byte structure:
	// - 0x00-0x7F: single-byte character (ASCII)
	// - 0xC0-0xDF: start of 2-byte sequence
	// - 0xE0-0xEF: start of 3-byte sequence
	// - 0xF0-0xF7: start of 4-byte sequence
	// - 0x80-0xBF: continuation byte (never start of character)
	//
	// Strategy: Walk back from maxBytes and find the last complete character.
	let cutPoint = Math.min(maxBytes, encoded.length);

	while (cutPoint > 0) {
		const byte = encoded[cutPoint - 1];

		if (byte < 0x80) {
			// ASCII single-byte character, safe to cut here
			break;
		}

		if (byte >= 0xc0) {
			// Start of multi-byte sequence.
			// Determine how many bytes this sequence should be.
			let seqLen = 1;
			if ((byte & 0xe0) === 0xc0)
				seqLen = 2; // 110xxxxx → 2-byte
			else if ((byte & 0xf0) === 0xe0)
				seqLen = 3; // 1110xxxx → 3-byte
			else if ((byte & 0xf8) === 0xf0) seqLen = 4; // 11110xxx → 4-byte

			// The sequence starts at (cutPoint - 1).
			// Check if all bytes of the sequence are within our buffer.
			const seqEnd = cutPoint - 1 + seqLen;
			if (seqEnd <= maxBytes) {
				// Complete sequence fits within maxBytes, include it
				cutPoint = seqEnd;
			} else {
				// Sequence extends past maxBytes, don't include it
				// Cut before the start byte
				cutPoint = cutPoint - 1;
			}
			break;
		}

		// byte is 0x80-0xBF (continuation byte)
		// We're in the middle of a sequence, keep walking back
		cutPoint--;
	}

	// Decode the valid UTF-8 prefix once
	// fatal: false allows invalid sequences to be replaced with U+FFFD
	const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
	const truncated = encoded.slice(0, cutPoint);
	const decodedBody = decoder.decode(truncated);

	return { body: decodedBody, truncated: true };
}

/**
 * Classifies a thrown error message to determine the error kind.
 * Maps network-blocked messages to "network_blocked", others to "transform_threw".
 *
 * SYNC PARTNER: Keep this function in sync with the inlined copy in src/runtime/harness-source.ts.
 * Both must match exactly. Core.ts is the canonical version (tested in core.spec.ts).
 * Update both locations together if changing matched substrings or logic.
 */
export function classifyTransformError(message: string): RunErrorKind {
	const lower = message.toLowerCase();

	// Match network-blocked signatures (globalOutbound: null, fetch restrictions)
	if (
		lower.includes('disallowed') ||
		lower.includes('not allowed') ||
		lower.includes('globaloutbound') ||
		lower.includes('not permitted to access the internet') ||
		lower.includes('cannot access the internet')
	) {
		return 'network_blocked';
	}

	return 'transform_threw';
}

/**
 * Classifies a loader-level error message to determine the error kind.
 * Maps CPU/time-budget limit-exceeded messages to "cpu_exceeded", others to "loader_failed".
 *
 * Pure function for classifying loader-level exceptions. Intentionally narrow to
 * avoid collisions with sub-request-limit, memory-limit, RPC-timeout, and module-resolution
 * failures (which should map to "loader_failed" for correct containment attribution).
 *
 * Matches CPU/time budget signatures only:
 * - "cpu" (e.g., "exceeded cpu", "cpu time", "cpu limit")
 * - "exceeded cpu" or "cpu exceeded" (explicit CPU context)
 * - Future: finalized against real deploy-captured CPU-exceeded message
 */
export function classifyLoaderError(message: string): RunErrorKind {
	const lower = message.toLowerCase();

	// Match CPU/time-budget signatures only. Drop generic matchers ("limit", "resource", "timeout")
	// to avoid misclassifying sub-request/memory/RPC failures.
	if (lower.includes('cpu') && (lower.includes('exceeded') || lower.includes('limit') || lower.includes('time'))) {
		return 'cpu_exceeded';
	}

	return 'loader_failed';
}
