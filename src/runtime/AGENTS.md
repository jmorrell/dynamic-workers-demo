# Runtime Sandbox

Last verified: 2026-06-22

## Purpose
Runs untrusted transform code against a pre-fetched page snapshot inside an
isolated Dynamic Worker, with containment (no outbound network, capped CPU/
subrequests) and structured results that never throw at the host. Also fetches
the target URL, captures the sandbox's logs, and enforces abuse gates.

## Contracts
- **Exposes**: `runInLoader(env, input, code, runId, ctx, compatDate?) → RunResult`;
  `fetchTarget(url, opts?) → FetchOutcome`; `verifyTurnstile(...)`; DO `LogSession`;
  tail worker `LogTailer`; types in `types.ts` / `log-types.ts`.
- **run() contract**: the harness exposes `run(input: RunInput): Promise<RunResult>`.
  INPUT is passed PER INVOCATION as the RPC argument — NOT via `env`. The loaded
  worker's `env` is intentionally `{}` (no host bindings/secrets leak in).
- **Guarantees**: `RunResult` is always structured (`{ok:true,value}` or
  `{ok:false,error:{kind,message}}`); host never sees a thrown transform error.
  Outbound `fetch` from sandbox is blocked (`globalOutbound: null`).
- **Expects**: `code` is a self-contained ESM string with a default-export
  transform function. `RunInput` is a plain snapshot (url/finalUrl/status/
  contentType/body/truncated).

## Key Decisions
- **Loader caches by code hash** (`hashCode`, SHA-256): identical code reuses a
  warm isolate. This is WHY input must be a per-call RPC arg — baking it into
  `env` would serve stale input on a cache hit.
- **Compat date is hard-coded, not env-driven**: `DEFAULT_COMPAT_DATE` (`loader.ts`)
  is used for arbitrary/custom code; saved examples pin their own `compatDate`
  (`src/examples/registry.ts`) so bumping the default doesn't silently change an
  already-verified example. `env.LOADER_COMPAT_DATE` is a test-only override,
  applied only when `ENVIRONMENT=test` (vitest.config.mts), because local workerd
  hard-errors loading future-dated Dynamic Workers.
- **`runInLoader`'s `runId`/`ctx` are required, not optional**: the tail worker is
  always attached in production (the sole caller, `src/index.ts`, always has both).
  Tests that don't care about tail delivery (which never delivers locally anyway)
  still pass a real `runId` and `createExecutionContext()` rather than the loader
  branching on their absence.
- **Injectable turnstileVerifier seam** lives in `src/index.ts`
  (`setTurnstileVerifier`) for deterministic tests; production uses `verifyTurnstile`.
- **Log capture via tail**: `LogTailer` (loopback `ctx.exports`, attached as the
  loaded worker's `tails`) forwards trace logs to `LogSession` DO, keyed by
  `runId`; the host polls `getLogs(timeoutMs)`. `LogSession` state is in-memory
  only (no `ctx.storage`) — a deliberate trade for the short single-request rendezvous.
- **SYNC PARTNER**: `harness-source.ts` inlines `classifyTransformError` as a
  string; `core.ts` is canonical. Change both together.

## Invariants
- Loaded worker `env` stays `{}`; never pass host bindings/secrets in.
- Containment limits: `CPU_LIMIT_MS = 50`, `subRequests: 5`, `globalOutbound: null`.
- `fetchTarget` caps body (default 256 KiB) and timeout (default 8s), truncating
  at a UTF-8 boundary; sets `truncated`.

## Key Files
- `loader.ts` - load/cache/invoke the Dynamic Worker (shell)
- `harness-source.ts` - in-sandbox entrypoint as a module string (the `HARNESS_SOURCE` actually loaded into the Dynamic Worker)
- `core.ts` - pure helpers: `hashCode`, `truncateBody`, error classifiers
- `fetch-target.ts` - target fetch + RunInput snapshot
- `log-session.ts` / `log-tailer.ts` / `log-cap.ts` / `log-types.ts` - log capture
- `turnstile.ts` - Turnstile siteverify
- `types.ts` - `RunInput`, `RunResult`, `RunError`, `FetchOutcome`

## Gotchas
- Locally: CPU limits not enforced, tail not delivered, RATE_LIMITER is a no-op
  stub — see root AGENTS.md. These behaviors are deploy-verified only.
- `HARNESS_SOURCE`'s `import userModule from './user.js'` only resolves inside the
  loaded worker (the loader injects `user.js` into the `modules` map), not at host
  compile time.
