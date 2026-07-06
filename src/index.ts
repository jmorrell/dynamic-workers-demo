import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import { transpileUserCode, selectReferencedDeps } from './runtime/transpile';
import { extractLinkedUrls } from './runtime/extract-urls';
import { isValidPermissions, validateCustomModules, decodeBase64 } from './runtime/core';
import type { Permissions, RunErrorKind, RunRequestBody, UserWorker } from './runtime/types';
import { listExamples, getExample } from './examples/manifest';
import { SHARED_DEP_SPECIFIERS } from './examples/registry';
import { GENERATED_DEP_MODULES } from './examples/deps.generated';
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

	const { url, worker, turnstileToken, permissions: requestPermissions } = body as Partial<Record<keyof RunRequestBody, unknown>>;

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

	const { type: workerType, exampleId, customCode, modules: workerModules } = worker as Partial<
		{ type?: unknown } & Record<'exampleId' | 'customCode', unknown> & Record<'modules', unknown>
	>;

	let userWorker: UserWorker;
	// Only populated for a custom run whose request declares wasm modules
	// (validated/decoded here so a bad request 400s before any fetch/loader work).
	let requestWasmModules: Record<string, Uint8Array> | undefined;
	if (workerType === 'example') {
		if (typeof exampleId !== 'string') {
			return jsonError(400, 'bad_request', 'exampleId must be a string');
		}
		userWorker = { type: 'example', exampleId };
	} else if (workerType === 'custom') {
		if (typeof customCode !== 'string') {
			return jsonError(400, 'bad_request', 'customCode must be a string');
		}
		if (workerModules !== undefined) {
			const validated = validateCustomModules(workerModules);
			if (!validated.ok) {
				return jsonError(400, 'bad_request', validated.message);
			}
			requestWasmModules = validated.modules;
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
	// Only populated for edited/custom code (see below) — the shared deps its
	// imports need, since a pristine example's deps are already baked into
	// example.code by the build (scripts/build-examples.mjs).
	let extraModules: Record<string, string> | undefined;
	// Wasm modules to inject alongside the code (see src/runtime/loader.ts
	// wasmModules) — from the example's manifest for example runs, or from the
	// validated request for custom runs (requestWasmModules, decoded above).
	let wasmModules: Record<string, Uint8Array> | undefined;
	// Effective capability grant. For examples, the registered permissions win
	// (request-supplied ones are ignored). For custom runs, the request supplies
	// them (validated below). Absent → default no-network grant in the loader.
	let permissions: Permissions | undefined;

	if (userWorker.type === 'example') {
		const example = getExample(userWorker.exampleId);
		if (!example) {
			return jsonError(404, 'bad_request', `Unknown example: ${userWorker.exampleId}`);
		}

		code = example.code;
		compatDate = example.compatDate;
		// The example's registered permissions win; request-supplied ones are ignored.
		permissions = example.permissions;
		// The bundled example code retains its relative wasm import (e.g.
		// './add.wasm' — see scripts/build-examples.mjs external:['*.wasm']), so an
		// example run needs the same module injection a custom run would.
		if (example.modules?.length) {
			wasmModules = {};
			for (const m of example.modules) {
				const bytes = decodeBase64(m.base64);
				if (bytes) wasmModules[m.name] = bytes;
			}
		}
	} else {
		// Custom runs may declare their own permissions; reject a malformed shape.
		if (requestPermissions !== undefined) {
			if (!isValidPermissions(requestPermissions)) {
				return jsonError(400, 'bad_request', 'Invalid permissions shape');
			}
			permissions = requestPermissions;
		}

		// Custom/edited code arrives as TypeScript (the editor never distinguishes
		// TS from JS); transpile before handing it to the loader.
		const transpiled = transpileUserCode(userWorker.customCode);
		if (transpiled.type === 'failure') {
			return new Response(
				JSON.stringify({
					ok: false,
					error: transpiled.error,
					logs: [],
					logsTruncated: false,
					timingMs: 0,
					inputTruncated: false,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}

		code = transpiled.code;

		const referencedDeps = selectReferencedDeps(code, SHARED_DEP_SPECIFIERS);
		if (referencedDeps.length > 0) {
			extraModules = {};
			for (const dep of referencedDeps) {
				extraModules[dep.specifier] = (GENERATED_DEP_MODULES as Record<string, string>)[dep.specifier];
			}
		}

		wasmModules = requestWasmModules;
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
				inputTruncated: false,
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}

	// Generate unique run ID for this execution
	const runId = crypto.randomUUID();

	// With fetch permission, the allowlist is exactly the URLs referenced by the
	// fetched page — the gate rejects anything else (no arbitrary spidering).
	const allowedUrls =
		permissions?.fetch === 'page-links'
			? extractLinkedUrls(
					fetchOutcome.input.body,
					fetchOutcome.input.contentType,
					fetchOutcome.input.finalUrl || fetchOutcome.input.url,
				)
			: undefined;

	// Run code in loader
	const startTime = performance.now();
	const result = await runInLoader(env, fetchOutcome.input, code, runId, ctx, {
		compatDate,
		extraModules,
		wasmModules,
		permissions,
		allowedUrls,
	});
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
			inputTruncated: fetchOutcome.input.truncated,
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

export { LogSession } from './runtime/log-session';
export { LogTailer } from './runtime/log-tailer';
export { CapabilityGate } from './runtime/capability-gate';

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
