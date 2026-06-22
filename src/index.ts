// pattern: Imperative Shell

import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import type { RunErrorKind } from './runtime/types';
import { listExamples, getExample } from './examples/manifest';
import { LogSession } from './runtime/log-session';
import { LogTailer } from './runtime/log-tailer';
import { LOG_MAX_LINES, LOG_MAX_BYTES } from './runtime/log-types';
import { verifyTurnstile } from './runtime/turnstile';

/** Timeout (ms) for reading logs from LogSession after run completes */
const LOG_READ_TIMEOUT_MS = 500;

/**
 * Build a uniform JSON error response. Every error path returns the same shape
 * — `{ ok: false, error: { kind, message } }` — so a consumer can branch on
 * `body.ok` and `body.error.kind` regardless of which gate/validation rejected.
 */
function jsonError(status: number, kind: RunErrorKind, message: string): Response {
	return new Response(JSON.stringify({ ok: false, error: { kind, message } }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Seam for injecting a Turnstile verifier in tests.
 * Production uses the real verifyTurnstile function.
 * Tests can override this to force deterministic pass/fail behavior.
 */
let turnstileVerifier = verifyTurnstile;

async function handleExamples(request: Request): Promise<Response> {
	// Only GET allowed
	if (request.method !== 'GET') {
		return jsonError(405, 'bad_request', 'Method not allowed');
	}

	const examples = listExamples();
	return new Response(JSON.stringify(examples), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function handleConfig(request: Request, env: Env): Promise<Response> {
	// Only GET allowed
	if (request.method !== 'GET') {
		return jsonError(405, 'bad_request', 'Method not allowed');
	}

	// Return only the public site key, never the secret
	return new Response(JSON.stringify({ turnstileSitekey: env.TURNSTILE_SITEKEY }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

async function handleRun(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// Validate method
	if (request.method !== 'POST') {
		return jsonError(405, 'bad_request', 'Method not allowed');
	}

	// Parse JSON body
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonError(400, 'bad_request', 'Invalid JSON body');
	}

	// Validate request shape
	if (typeof body !== 'object' || body === null || !('url' in body)) {
		return jsonError(400, 'bad_request', 'Missing required field: url');
	}

	const { exampleId, customCode, url, turnstileToken } = body as {
		exampleId: unknown;
		customCode: unknown;
		url: unknown;
		turnstileToken?: unknown;
	};

	// GATE 1: Rate limit by client IP
	const clientIp = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	const rateLimitResult = await env.RATE_LIMITER.limit({ key: clientIp });
	if (!rateLimitResult.success) {
		return jsonError(429, 'rate_limited', 'Too many runs, please wait and try again.');
	}

	// GATE 2: Verify Turnstile token
	const turnstileVerifyResult = await turnstileVerifier(
		typeof turnstileToken === 'string' ? turnstileToken : undefined,
		env.TURNSTILE_SECRET,
		clientIp,
	);
	if (!turnstileVerifyResult.ok) {
		return jsonError(403, 'turnstile_failed', 'Verification failed.');
	}

	// Validate url
	if (typeof url !== 'string') {
		return jsonError(400, 'bad_request', 'url must be a string');
	}

	// Resolve code: either from exampleId or customCode, but not both
	let code: string;

	if (exampleId !== undefined) {
		// exampleId provided - look it up
		if (customCode !== undefined) {
			return jsonError(400, 'bad_request', 'Cannot specify both exampleId and customCode - provide exactly one');
		}

		if (typeof exampleId !== 'string') {
			return jsonError(400, 'bad_request', 'exampleId must be a string');
		}

		const example = getExample(exampleId);
		if (!example) {
			return jsonError(404, 'bad_request', `Unknown example: ${exampleId}`);
		}

		code = example.code;
	} else if (customCode !== undefined) {
		// customCode provided
		if (typeof customCode !== 'string') {
			return jsonError(400, 'bad_request', 'customCode must be a string');
		}

		code = customCode;
	} else {
		// Neither provided
		return jsonError(400, 'bad_request', 'Must provide either exampleId or customCode');
	}

	// Fetch target URL
	const fetchOutcome = await fetchTarget(url);

	if (!fetchOutcome.ok) {
		// Fetch failed - return error without invoking loader
		return new Response(
			JSON.stringify({
				ok: false,
				error: fetchOutcome.error,
				logs: [],
				logsTruncated: false,
				timingMs: 0,
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}

	// Generate unique run ID for this execution
	const runId = crypto.randomUUID();

	// Run code in loader
	const startTime = performance.now();
	const result = await runInLoader(env, fetchOutcome.input, code, runId, ctx);
	const timingMs = Math.round(performance.now() - startTime);

	// Read logs from LogSession
	const logs = await env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId)).getLogs(LOG_READ_TIMEOUT_MS);

	return new Response(
		JSON.stringify({
			ok: result.ok,
			result: result.ok ? result.value : null,
			error: !result.ok ? result.error : null,
			logs: logs.lines,
			logsTruncated: logs.truncated,
			timingMs,
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

export { LogSession } from './runtime/log-session';
export { LogTailer } from './runtime/log-tailer';

/**
 * Override the Turnstile verifier for testing.
 * In tests, call this to inject a mock/stub verifier that always passes or fails.
 * @internal Used only in tests
 */
export function setTurnstileVerifier(verifier: typeof verifyTurnstile): void {
	turnstileVerifier = verifier;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Route GET /api/examples
		if (url.pathname === '/api/examples') {
			return handleExamples(request);
		}

		// Route GET /api/config
		if (url.pathname === '/api/config') {
			return handleConfig(request, env);
		}

		// Route POST /api/run
		if (url.pathname === '/api/run') {
			return handleRun(request, env, ctx);
		}

		// Unknown path
		return jsonError(404, 'bad_request', 'Not found');
	},
} satisfies ExportedHandler<Env>;
