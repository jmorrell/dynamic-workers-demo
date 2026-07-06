import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import type { RunErrorKind, RunRequestBody, UserWorker } from './runtime/types';
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

	const { url, worker, turnstileToken } = body as Partial<Record<keyof RunRequestBody, unknown>>;

	// GATE 1: Rate limit by client IP
	const clientIp = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
	const rateLimitResult = await env.RATE_LIMITER.limit({ key: clientIp });
	if (!rateLimitResult.success) {
		return jsonError(429, 'rate_limited', 'Too many runs, please wait and try again.');
	}

	// GATE 2: Verify Turnstile token.
	// Bypassed in local dev (ENVIRONMENT=development via .dev.vars) so the run
	// endpoint works without the browser widget loading. Always enforced on
	// deploy, where ENVIRONMENT is "production" (wrangler.jsonc vars).
	if (env.ENVIRONMENT !== 'development') {
		const turnstileVerifyResult = await turnstileVerifier(
			typeof turnstileToken === 'string' ? turnstileToken : undefined,
			env.TURNSTILE_SECRET,
			clientIp,
		);
		if (!turnstileVerifyResult.ok) {
			return jsonError(403, 'turnstile_failed', 'Verification failed.');
		}
	}

	// Validate url
	if (typeof url !== 'string') {
		return jsonError(400, 'bad_request', 'url must be a string');
	}

	// Validate worker
	if (typeof worker !== 'object' || worker === null) {
		return jsonError(400, 'bad_request', 'Missing required field: worker');
	}

	const { type: workerType, exampleId, customCode } = worker as Partial<
		{ type?: unknown } & Record<'exampleId' | 'customCode', unknown>
	>;

	let userWorker: UserWorker;
	if (workerType === 'example') {
		if (typeof exampleId !== 'string') {
			return jsonError(400, 'bad_request', 'exampleId must be a string');
		}
		userWorker = { type: 'example', exampleId };
	} else if (workerType === 'custom') {
		if (typeof customCode !== 'string') {
			return jsonError(400, 'bad_request', 'customCode must be a string');
		}
		userWorker = { type: 'custom', customCode };
	} else {
		return jsonError(400, 'bad_request', 'worker.type must be "example" or "custom"');
	}

	// Resolve code from the worker union
	let code: string;
	// Saved examples pin their own compat date; custom code falls back to
	// runInLoader's default (see src/runtime/loader.ts DEFAULT_COMPAT_DATE).
	let compatDate: string | undefined;

	if (userWorker.type === 'example') {
		const example = getExample(userWorker.exampleId);
		if (!example) {
			return jsonError(404, 'bad_request', `Unknown example: ${userWorker.exampleId}`);
		}

		code = example.code;
		compatDate = example.compatDate;
	} else {
		code = userWorker.customCode;
	}

	// Fetch target URL
	const fetchOutcome = await fetchTarget(url);

	if (fetchOutcome.type !== 'success') {
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
	const result = await runInLoader(env, fetchOutcome.input, code, runId, ctx, compatDate);
	const timingMs = Math.round(performance.now() - startTime);

	// Read logs from LogSession
	const logs = await env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId)).getLogs(LOG_READ_TIMEOUT_MS);

	return new Response(
		JSON.stringify({
			ok: result.type === 'success',
			result: result.type === 'success' ? result.value : null,
			error: result.type === 'failure' ? result.error : null,
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
