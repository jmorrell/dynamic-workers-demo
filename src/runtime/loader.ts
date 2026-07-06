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
 * 1. Hash the code for loader cache id (identical code reuses warm isolate)
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
): Promise<RunResult> {
	try {
		// 1. Hash the code for cache key (identical code → same isolate)
		const id = await hashCode(code);

		// 2. Get or create the worker via the loader
		const worker = env.LOADER.get(id, async () => {
			// LOADER_COMPAT_DATE is a test-only override (set in vitest.config.mts):
			// the local workerd binary hard-errors loading a Dynamic Worker dated
			// past its supported compat date, so tests pin an older, loadable date
			// regardless of what compatDate the caller resolved for production.
			const compatibilityDate = env.ENVIRONMENT === 'test' && env.LOADER_COMPAT_DATE ? env.LOADER_COMPAT_DATE : compatDate;

			const workerCode: WorkerLoaderWorkerCode = {
				compatibilityDate,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: 'harness.js',
				modules: {
					'harness.js': HARNESS_SOURCE,
					'user.js': code,
				},
				// No per-request data here: the worker is cached by code hash and
				// reused across inputs, so INPUT is passed to run() per invocation.
				// Keeping env empty also guarantees no host bindings/secrets leak in.
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

		// 3. Invoke the harness via RPC, passing INPUT per call (see note above).
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
			ok: false,
			error: {
				kind,
				message,
			},
		};
	}
}
