// pattern: Imperative Shell

import { hashCode } from './core';
import type { RunInput, RunResult } from './types';
import { HARNESS_SOURCE } from './harness-source';

// The Dynamic Worker's compatibility date must match the host's compat date
// (wrangler.jsonc) so loaded code runs against the same runtime APIs and the
// globalOutbound: null block error text stays consistent. The local
// vitest/wrangler runtime supports an older max date and automatically falls
// back with a harmless warning; production uses this exact date.
const COMPAT_DATE = '2026-06-22';

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
): Promise<RunResult> {
  try {
    // 1. Hash the code for cache key (identical code → same isolate)
    const id = await hashCode(code);

    // 2. Get or create the worker via the loader
    const worker = await env.LOADER.get(id, async () => ({
      compatibilityDate: COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'harness.js',
      modules: {
        'harness.js': HARNESS_SOURCE,
        'user.js': code,
      },
      env: {
        INPUT: input,
      },
      globalOutbound: null, // Block all outbound fetch
    }));

    // 3. Invoke the harness via RPC
    // @ts-expect-error worker entrypoint has run() method dynamically
    const entrypoint = worker.getEntrypoint() as { run(): Promise<RunResult> };
    const result = await entrypoint.run();
    return result;
  } catch (err) {
    // Loader-level failure (RPC, initialization, etc.)
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        kind: 'loader_failed',
        message,
      },
    };
  }
}
