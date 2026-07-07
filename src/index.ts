import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import { transpileUserCode, selectReferencedDeps } from './runtime/transpile';
import { extractLinkedUrls } from './runtime/extract-urls';
import { isValidPermissions, validateCustomModules } from './runtime/core';
import { releaseGateRun, collectGateSpans } from './runtime/capability-gate';
import { Tracer, type Trace } from './runtime/trace';
import type { Permissions, RunErrorKind, RunRequestBody, UserWorker } from './runtime/types';
import { listExamples, getExample, type ExampleModule } from './examples/manifest';
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

/**
 * Fetches an example's wasm module bytes host-side via the ASSETS binding
 * (public/modules/<id>/<name>, generated-but-committed — see
 * scripts/build-examples.mjs). A dummy origin is required because Fetcher#fetch
 * needs a well-formed absolute URL; only the pathname is meaningful for asset
 * routing. Shouldn't fail for a committed example, but a bad/missing asset
 * fails the run readably (loader_failed) rather than throwing.
 */
async function loadExampleWasmModules(
	env: Env,
	modules: ReadonlyArray<ExampleModule>,
): Promise<{ ok: true; modules: Record<string, Uint8Array> } | { ok: false; error: { kind: RunErrorKind; message: string } }> {
	const wasmModules: Record<string, Uint8Array> = {};
	for (const m of modules) {
		const res = await env.ASSETS.fetch(new URL(m.assetPath, 'https://assets.local'));
		if (!res.ok) {
			return { ok: false, error: { kind: 'loader_failed', message: `Failed to load module asset ${m.assetPath}: HTTP ${res.status}` } };
		}
		wasmModules[m.name] = new Uint8Array(await res.arrayBuffer());
	}
	return { ok: true, modules: wasmModules };
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

	// Trace setup: runId doubles as traceId (spec-fixed — every span of an
	// invocation shares it). Started here, before any of the code-resolution/
	// fetch work below, so every run-shaped response from this point on — even
	// an early-exit failure (wasm module load, transpile, target fetch) — can
	// carry at least a root-only trace.
	const runId = crypto.randomUUID();
	const rootStartAbsMs = performance.now();
	const tracer = new Tracer(runId, rootStartAbsMs);
	const rootSpanId = tracer.newSpanId();
	// Finalizes the root span (status reflects the response's overall ok/fail)
	// and assembles the Trace for a response body. Call exactly once per
	// early-return or final-return path.
	function finishTrace(status: 'ok' | 'error'): Trace {
		tracer.addSpan(rootSpanId, undefined, rootStartAbsMs, performance.now(), status, { name: 'run' });
		return tracer.build(rootSpanId);
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
		// example run needs the same module injection a custom run would. Bytes
		// live as static assets (public/modules/<id>/<name>, generated-but-committed
		// — see scripts/build-examples.mjs) rather than base64 in the manifest.
		if (example.modules?.length) {
			const loaded = await loadExampleWasmModules(env, example.modules);
			if (!loaded.ok) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: loaded.error,
						logs: [],
						logsTruncated: false,
						timingMs: 0,
						inputTruncated: false,
						trace: finishTrace('error'),
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			wasmModules = loaded.modules;
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
					trace: finishTrace('error'),
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
	const targetFetchSpanId = tracer.newSpanId();
	const targetFetchStartAbsMs = performance.now();
	const fetchOutcome = await fetchTarget(url);
	const targetFetchEndAbsMs = performance.now();
	tracer.addSpan(
		targetFetchSpanId,
		rootSpanId,
		targetFetchStartAbsMs,
		targetFetchEndAbsMs,
		fetchOutcome.type === 'success' ? 'ok' : 'error',
		fetchOutcome.type === 'success'
			? { name: 'target_fetch', url, httpStatus: fetchOutcome.input.status, bytes: fetchOutcome.input.body.length, truncated: fetchOutcome.input.truncated }
			: { name: 'target_fetch', url, errorKind: fetchOutcome.error.kind, error: fetchOutcome.error.message },
	);

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
				trace: finishTrace('error'),
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}

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
	const loaderSpanId = tracer.newSpanId();
	const startTime = performance.now();
	const result = await runInLoader(env, fetchOutcome.input, code, runId, ctx, {
		compatDate,
		extraModules,
		wasmModules,
		permissions,
		allowedUrls,
	});
	const loaderEndAbsMs = performance.now();
	const timingMs = Math.round(loaderEndAbsMs - startTime);
	tracer.addSpan(loaderSpanId, rootSpanId, startTime, loaderEndAbsMs, result.type === 'success' ? 'ok' : 'error', {
		name: 'loader',
		...(userWorker.type === 'example' ? { exampleId: userWorker.exampleId } : { custom: true }),
		...(result.type === 'failure' ? { errorKind: result.error.kind, error: result.error.message } : {}),
	});
	// Gate calls (env.fetch/env.fetchFile), including denied attempts, nest
	// under the loader span — they only ever happen during the loader's
	// invocation of the transform.
	tracer.addExternalSpans(collectGateSpans(runId), loaderSpanId);

	// Read logs from LogSession
	const logsReadSpanId = tracer.newSpanId();
	const logsReadStartAbsMs = performance.now();
	const logs = await env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId)).getLogs(LOG_READ_TIMEOUT_MS);
	tracer.addSpan(logsReadSpanId, rootSpanId, logsReadStartAbsMs, performance.now(), 'ok', {
		name: 'logs_read',
		lineCount: logs.lines.length,
		truncated: logs.truncated,
	});

	// Best-effort in-memory hygiene for the gate's module-scoped per-run maps
	// (fetchCounts, grown allowlist, gate spans — already drained above) — see
	// releaseGateRun's doc comment. Runs regardless of result.type so a
	// transform_threw/loader_failed run still releases its entries.
	releaseGateRun(runId);

	return new Response(
		JSON.stringify({
			ok: result.type === 'success',
			result: result.type === 'success' ? result.value : null,
			error: result.type === 'failure' ? result.error : null,
			logs: logs.lines,
			logsTruncated: logs.truncated,
			timingMs,
			trace: finishTrace(result.type === 'success' ? 'ok' : 'error'),
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
