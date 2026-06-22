# Runtime Sandbox

Last verified: 2026-06-22

## Purpose
Runs untrusted transform code against a pre-fetched page snapshot inside an
isolated Dynamic Worker, with containment (no outbound network, capped CPU/
subrequests) and structured results that never throw at the host. Also fetches
the target URL, captures the sandbox's logs, and enforces abuse gates.

## Contracts
- **Exposes**: `runInLoader(env, input, code, runId?, ctx?) → RunResult`;
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
- **`LOADER_COMPAT_DATE`** drives the Dynamic Worker's compat date (mirrors host
  compat date). vitest overrides it to a loadable date (local workerd hard-errors
  on future-dated loaded workers); production uses the wrangler.jsonc value.
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
- `harness.ts` / `harness-source.ts` - in-sandbox entrypoint; source string actually loaded
- `core.ts` - pure helpers: `hashCode`, `truncateBody`, error classifiers
- `fetch-target.ts` - target fetch + RunInput snapshot
- `log-session.ts` / `log-tailer.ts` / `log-cap.ts` / `log-types.ts` - log capture
- `turnstile.ts` - Turnstile siteverify
- `types.ts` - `RunInput`, `RunResult`, `RunError`, `FetchOutcome`

## Gotchas
- Locally: CPU limits not enforced, tail not delivered, RATE_LIMITER is a no-op
  stub — see root AGENTS.md. These behaviors are deploy-verified only.
- `harness.ts`'s `import userModule from './user.js'` only resolves inside the
  loaded worker (injected by the loader), not at host compile time.
