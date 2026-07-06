import { classifyLoaderError, clampCpuMs, clampFetchDepth, clampMaxFetches, hashCode } from './core';
import type { Permissions, RunInput, RunResult } from './types';
import { HARNESS_SOURCE } from './harness-source';

/** CPU limit for sandboxed worker code execution (in milliseconds) */
export const CPU_LIMIT_MS = 50;

/**
 * Optional loader inputs. Consolidated into one object because several are
 * independently optional (compat date, injected deps, capability grant).
 * - `compatDate` — override the Dynamic Worker compat date (examples pin theirs).
 * - `extraModules` — shared dep modules injected for edited/custom code.
 * - `wasmModules` — wasm binaries injected alongside the code, keyed by the
 *   exact relative-import specifier's resolved key (e.g. 'add.wasm').
 * - `permissions` — capability grant; drives `limits.cpuMs` and gate attachment.
 * - `allowedUrls` — URLs referenced by the fetched page; required when
 *   `permissions.fetch === 'page-links'`, passed to the gate as props.
 */
export type RunOptions = {
	readonly compatDate?: string;
	readonly extraModules?: Readonly<Record<string, string>>;
	readonly wasmModules?: Readonly<Record<string, Uint8Array>>;
	readonly permissions?: Permissions;
	readonly allowedUrls?: ReadonlyArray<string>;
};

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
	opts: RunOptions = {},
): Promise<RunResult> {
	const { compatDate = DEFAULT_COMPAT_DATE, extraModules, wasmModules, permissions, allowedUrls } = opts;
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

			const modules: Record<string, string | { js: string } | { wasm: ArrayBuffer }> = {
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

			// Wasm modules (e.g. the wasm-add example's './add.wasm') are injected
			// as the typed `{ wasm }` form, keyed the same way — same never-override
			// guard as extraModules above.
			if (wasmModules) {
				for (const [name, bytes] of Object.entries(wasmModules)) {
					if (name === 'harness.js' || name === 'user.js') continue;
					// WorkerLoaderModule.wasm is typed as ArrayBuffer; slice() copies out
					// exactly this view's bytes as a standalone buffer (bytes.buffer alone
					// could be larger/shared if the Uint8Array is itself a view).
					modules[name] = { wasm: bytes.slice().buffer };
				}
			}

			// ctx.exports is typed {} until GlobalProps is generated; narrow the loopback bindings.
			const exports = ctx.exports as {
				LogTailer: (o: { props: { runId: string } }) => Fetcher;
				CapabilityGate: (o: {
					props: { runId: string; allowedUrls: ReadonlyArray<string>; fetchDepth: number; maxFetches: number };
				}) => Fetcher;
			};

			// The loaded worker's env carries at most the CapabilityGate loopback —
			// never host bindings/secrets. It appears only when fetch is permitted;
			// otherwise env stays {} and the sandbox is fully network-blocked.
			// globalOutbound stays null regardless (the gate is a service binding,
			// unaffected by globalOutbound); INPUT is passed to run() per invocation.
			const workerEnv: Record<string, unknown> =
				permissions?.fetch === 'page-links'
					? {
							GATE: exports.CapabilityGate({
								props: {
									runId,
									allowedUrls: allowedUrls ?? [],
									fetchDepth: clampFetchDepth(permissions.fetchDepth),
									maxFetches: clampMaxFetches(permissions.maxFetches),
								},
							}),
						}
					: {};

			// subRequests mirrors the granted maxFetches (host-side tally in the gate
			// and this sandbox-side platform limit must stay in lockstep, same as
			// they always have at the fixed 5/5 default) — but only under a
			// page-links grant. With no fetch permission there's no gate to mirror
			// and no reason to widen a sandbox that has zero network access anyway,
			// so subRequests stays at the old constant 5 in that case.
			const subRequests =
				permissions?.fetch === 'page-links' ? clampMaxFetches(permissions.maxFetches) : 5;

			const workerCode: WorkerLoaderWorkerCode = {
				compatibilityDate,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: 'harness.js',
				modules,
				env: workerEnv,
				globalOutbound: null, // Block all ambient outbound fetch; permitted fetch goes through GATE
				limits: {
					cpuMs: clampCpuMs(permissions?.cpuMs, CPU_LIMIT_MS),
					subRequests,
				},
			};

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
