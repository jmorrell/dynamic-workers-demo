// pattern: Imperative Shell

import { classifyLoaderError, hashCode } from './core';
import type { RunInput, RunResult } from './types';
import { HARNESS_SOURCE } from './harness-source';

/** CPU limit for sandboxed worker code execution (in milliseconds) */
export const CPU_LIMIT_MS = 50;

// The Dynamic Worker's compatibility date comes from the LOADER_COMPAT_DATE
// var (wrangler.jsonc), which mirrors the host's compat date so loaded code
// runs against the same runtime APIs and the globalOutbound: null block error
// text stays consistent. Production uses 2026-06-22; the vitest config
// overrides the var to a date the local workerd binary can load (it hard-errors
// on future dates for loaded workers, unlike the host which falls back).

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
export async function runInLoader(env: Env, input: RunInput, code: string): Promise<RunResult> {
	try {
		// 1. Hash the code for cache key (identical code → same isolate)
		const id = await hashCode(code);

		// 2. Get or create the worker via the loader
		const worker = await env.LOADER.get(id, async () => ({
			compatibilityDate: env.LOADER_COMPAT_DATE,
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
		}));

		// 3. Invoke the harness via RPC, passing INPUT per call (see note above).
		// @ts-expect-error worker entrypoint has run() method dynamically
		const entrypoint = worker.getEntrypoint() as { run(input: RunInput): Promise<RunResult> };
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
