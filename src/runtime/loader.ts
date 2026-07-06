import { classifyLoaderError, hashCode } from './core';
import type { RunInput, RunResult } from './types';
import { HARNESS_SOURCE } from './harness-source';

/** CPU limit for sandboxed worker code execution (in milliseconds) */
export const CPU_LIMIT_MS = 50;

// Default compatibility date for Dynamic Workers running arbitrary (non-example)
// code. Mirrors wrangler.jsonc's compatibility_date. Saved examples pin their own
// compatDate (see src/examples/registry.ts) so bumping this default doesn't
// silently change the runtime behavior of already-verified examples.
export const DEFAULT_COMPAT_DATE = '2026-06-22';

/**
 * Runs untrusted code against a URL in a sandboxed dynamic worker.
 *
 * Steps:
 * 1. Derive a per-run loader id from the code hash + runId
 * 2. Get/create worker via env.LOADER with WorkerCode containing harness + user code
 * 3. Invoke worker.getEntrypoint().run() with RPC call
 * 4. Handle loader-level failures (RPC errors, etc.)
 *
 * The harness handles transform-level failures and always returns structured result.
 */
export async function runInLoader(
	env: Env,
	input: RunInput,
	code: string,
	runId: string,
	ctx: ExecutionContext,
	compatDate: string = DEFAULT_COMPAT_DATE,
	extraModules?: Readonly<Record<string, string>>,
): Promise<RunResult> {
	try {
		// 1. Scope the loader id to this run, not just the code. The tail worker
		// binding (below) is attached at isolate creation time, so an id shared
		// across runs of identical code would keep serving the FIRST run's tail
		// binding — its logs would forward to a runId no host is polling anymore.
		// Including runId forces a fresh isolate per run; input is still passed
		// per-call (see below) since that's orthogonal, independently-good hygiene.
		const id = `${await hashCode(code)}:${runId}`;

		// 2. Get or create the worker via the loader
		const worker = env.LOADER.get(id, async () => {
			// LOADER_COMPAT_DATE is a test-only override (set in vitest.config.mts):
			// the local workerd binary hard-errors loading a Dynamic Worker dated
			// past its supported compat date, so tests pin an older, loadable date
			// regardless of what compatDate the caller resolved for production.
			const compatibilityDate = env.ENVIRONMENT === 'test' && env.LOADER_COMPAT_DATE ? env.LOADER_COMPAT_DATE : compatDate;

			const modules: Record<string, string | { js: string }> = {
				'harness.js': HARNESS_SOURCE,
				'user.js': code,
			};

			// Extra modules (e.g. shared deps for edited example code — see
			// src/index.ts) are injected as the typed `{ js }` form, keyed by
			// exact import specifier (no automatic '.js' suffix resolution).
			// Never let a caller-supplied key shadow the harness or user module.
			if (extraModules) {
				for (const [specifier, source] of Object.entries(extraModules)) {
					if (specifier === 'harness.js' || specifier === 'user.js') continue;
					modules[specifier] = { js: source };
				}
			}

			const workerCode: WorkerLoaderWorkerCode = {
				compatibilityDate,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: 'harness.js',
				modules,
				// No per-request data here: INPUT is passed to run() per invocation
				// (see step 3). Keeping env empty also guarantees no host
				// bindings/secrets leak into the sandboxed isolate.
				env: {},
				globalOutbound: null, // Block all outbound fetch
				limits: {
					cpuMs: CPU_LIMIT_MS,
					subRequests: 5,
				},
			};

			// ctx.exports is typed {} until GlobalProps is generated; narrow the loopback binding.
			const exports = ctx.exports as { LogTailer: (o: { props: { runId: string } }) => Fetcher };
			workerCode.tails = [exports.LogTailer({ props: { runId } })];

			return workerCode;
		});

		// 3. Invoke the harness via RPC, passing INPUT per call (see step 1 note).
		// getEntrypoint() is opaquely typed; the loaded mainModule (HARNESS_SOURCE)
		// exposes run(input). Narrow via unknown since the types don't overlap.
		const entrypoint = worker.getEntrypoint() as unknown as { run(input: RunInput): Promise<RunResult> };
		const result = await entrypoint.run(input);
		return result;
	} catch (err) {
		// Loader-level failure (RPC, initialization, CPU/resource limits, etc.)
		const message = err instanceof Error ? err.message : String(err);
		const kind = classifyLoaderError(message);
		return {
			type: 'failure',
			error: {
				kind,
				message,
			},
		};
	}
}
