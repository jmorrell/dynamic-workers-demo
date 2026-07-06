# Runtime Sandbox

Last verified: 2026-06-22

## Purpose
Runs untrusted transform code against a pre-fetched page snapshot inside an
isolated Dynamic Worker, with containment (no outbound network, capped CPU/
subrequests) and structured results that never throw at the host. Also fetches
the target URL, captures the sandbox's logs, and enforces abuse gates.

## Contracts
- **Exposes**: `runInLoader(env, input, code, runId, ctx, compatDate?, extraModules?) →
  RunResult`; `fetchTarget(url, opts?) → FetchOutcome`; `verifyTurnstile(...)`;
  `transpileUserCode(source) → TranspileResult`; DO `LogSession`; tail worker
  `LogTailer`; types in `types.ts` / `log-types.ts`.
- **run() contract**: the harness exposes `run(input: RunInput): Promise<RunResult>`.
  INPUT is passed PER INVOCATION as the RPC argument — NOT via `env`. The loaded
  worker's `env` is intentionally `{}` (no host bindings/secrets leak in).
- **Guarantees**: `RunResult` is always structured (`{type:'success',value}` or
  `{type:'failure',error:{kind,message}}`); host never sees a thrown transform
  error. Outbound `fetch` from sandbox is blocked (`globalOutbound: null`).
- **Expects**: `code` is a self-contained ESM string with a default-export
  transform function. `RunInput` is a plain snapshot (url/finalUrl/status/
  contentType/responseHeaders/body/truncated).

## Key Decisions
- **Loader id is per-run, not just per-code-hash**: `runInLoader` keys
  `env.LOADER.get` on `` `${hashCode(code)}:${runId}` ``, not the code hash alone.
  The tail worker binding (`workerCode.tails`) is created inside the
  cache-miss callback and closes over `runId` — it binds at isolate creation,
  not per-call. If the id were just the code hash, a warm isolate from
  identical code would keep forwarding logs to the FIRST run's `runId`
  forever, so reruns of the same code would attribute logs to a dead
  `LogSession` and the host would see `logs: []`. Per-call RPC input (below)
  remains good hygiene independent of this — it stops a same-isolate reuse
  from serving stale input — but it does not by itself fix log attribution.
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
- **Custom-code pipeline**: `src/index.ts`'s custom path runs edited/custom code
  through `transpileUserCode` (sucrase, TS→JS only, ESM preserved) before handing
  it to `runInLoader`; a transpile failure short-circuits with `compile_failed`
  and never reaches the loader. It then picks which shared dep modules
  (`SHARED_DEP_SPECIFIERS` in `src/examples/registry.ts`) the transpiled code
  references (`selectReferencedDeps`, a simple substring check — false positives
  just inject an unused module) and passes those as `runInLoader`'s
  `extraModules`, sourced from `src/examples/deps.generated.ts`. A pristine
  (unedited) example instead runs by `exampleId` using its pre-bundled
  `manifest.generated.ts` code, so it needs neither step.
- **`runInLoader`'s `extraModules`** are injected into the loaded worker's
  `modules` map using the typed `{ js: source }` form, keyed by the exact import
  specifier the code uses (e.g. `'linkedom'`, `'defuddle/node'`,
  `'markdown-dom-polyfill'` for a relative `import './markdown-dom-polyfill'` —
  no `./` prefix, no extension). There is no automatic `.js` suffix resolution
  for bare/subpath specifiers; a module key must either end in `.js` or use this
  typed form. Callers cannot override `'harness.js'` or `'user.js'` this way —
  the loader silently skips those keys if present in `extraModules`.
- **Log capture via tail**: `LogTailer` (loopback `ctx.exports`, attached as the
  loaded worker's `tails`) forwards trace logs to `LogSession` DO, keyed by
  `runId`; the host polls `getLogs(timeoutMs)`. `LogSession` state is in-memory
  only (no `ctx.storage`) — a deliberate trade for the short single-request rendezvous.
- **SYNC PARTNER**: `harness-source.ts` inlines `classifyTransformError` as a
  string; `core.ts` is canonical. Change both together.

## Invariants
- Loaded worker `env` stays `{}`; never pass host bindings/secrets in.
- Containment limits: `CPU_LIMIT_MS = 50`, `subRequests: 5`, `globalOutbound: null`.
- `fetchTarget` caps body (default 2 MiB) and timeout (default 8s), truncating
  at a UTF-8 boundary; sets `truncated`.

## Key Files
- `loader.ts` - load/cache/invoke the Dynamic Worker (shell)
- `harness-source.ts` - in-sandbox entrypoint as a module string (the `HARNESS_SOURCE` actually loaded into the Dynamic Worker)
- `core.ts` - pure helpers: `hashCode`, `truncateBody`, error classifiers
- `transpile.ts` - pure: `transpileUserCode` (sucrase TS→JS), `selectReferencedDeps`
- `fetch-target.ts` - target fetch + RunInput snapshot
- `log-session.ts` / `log-tailer.ts` / `log-cap.ts` / `log-types.ts` - log capture
- `turnstile.ts` - Turnstile siteverify
- `types.ts` - `RunInput`, `RunResult`, `RunError`, `FetchOutcome`

## Gotchas
- Locally: CPU limits not enforced, RATE_LIMITER is a no-op stub — see root
  AGENTS.md. These behaviors are deploy-verified only. Tail delivery DOES work
  under `wrangler dev` (verified 2026-07-05); it does NOT work in the vitest
  workers pool, so log-forwarding assertions there stay integration-shaped
  (assert the tail binding is attached) rather than asserting delivery.
- `HARNESS_SOURCE`'s `import userModule from './user.js'` only resolves inside the
  loaded worker (the loader injects `user.js` into the `modules` map), not at host
  compile time.
