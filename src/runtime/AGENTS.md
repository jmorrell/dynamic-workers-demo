# Runtime Sandbox

Last verified: 2026-06-22

## Purpose
Runs untrusted transform code against a pre-fetched page snapshot inside an
isolated Dynamic Worker, with containment (no outbound network, capped CPU/
subrequests) and structured results that never throw at the host. Also fetches
the target URL, captures the sandbox's logs, and enforces abuse gates.

## Contracts
- **Exposes**: `runInLoader(env, input, code, runId, ctx, opts?) → RunResult`
  (trailing optionals consolidated into one `RunOptions` object:
  `{ compatDate?, extraModules?, wasmModules?, permissions?, allowedUrls? }`); `fetchTarget(url,
  opts?) → FetchOutcome`; `verifyTurnstile(...)`; `transpileUserCode(source) →
  TranspileResult`; `extractLinkedUrls(body, contentType, baseUrl) → string[]`;
  DO `LogSession`; tail worker `LogTailer`; loopback gate `CapabilityGate`; types
  in `types.ts` / `log-types.ts`.
- **Transform signature**: the default export is `(env, input) => …`. `env` is a
  capability object (its FIRST argument, mirroring how Workers hand bindings to
  code), `input` is the page snapshot. INPUT is passed PER INVOCATION as the RPC
  argument — NOT via the loaded worker's `env`.
- **run() contract**: the harness exposes `run(input: RunInput): Promise<RunResult>`
  and internally calls `transform(userEnv, input)`. `userEnv` is `{}` under the
  default no-network grant; with fetch permission it is
  `{ fetch(url), fetchFile(url) }`, both proxying to the host `CapabilityGate`.
- **Permissions**: `type Permissions = { fetch: 'page-links' | 'none'; cpuMs? }`.
  Default `{ fetch: 'none' }`; `cpuMs` defaults to `CPU_LIMIT_MS` (50) and is
  clamped to `[1, 5000]` (`clampCpuMs` in core). Example runs use the example's
  registered permissions (request-supplied ignored); custom runs use the
  request's, validated/clamped (bad shape → 400).
- **Gate contract**: `CapabilityGate` (WorkerEntrypoint, reached via
  `ctx.exports.CapabilityGate({ props: { runId, allowedUrls } })`, attached as the
  loaded worker's `env.GATE`). `fetchText(url) → { status, contentType, body,
  truncated }` (2 MiB, UTF-8-boundary truncation); `fetchFile(url) → { status,
  contentType, bytes, truncated }` (20 MiB, byte truncation). Both require the
  normalized URL to be an EXACT member of `props.allowedUrls` (URLs referenced by
  the fetched page — no arbitrary spidering), pass the SSRF host guard
  (`guardFetchUrl`), obey an 8s timeout, and share a per-run 5-fetch cap.
- **URL extraction**: `extractLinkedUrls` (pure, `extract-urls.ts`) parses HTML
  (linkedom, host-side) URL-bearing attributes (incl. `srcset` candidates and
  absolute-URL `meta[content]`) or, for JSON/text, regex-matches absolute http(s)
  URLs including JSON-escaped `https:\/\/` forms; resolves against the base,
  http/https only, dedupes, caps at 2000, returns normalized `URL.toString()`.
- **Guarantees**: `RunResult` is always structured; host never sees a thrown
  transform error. A gate rejection surfaces as a normal `transform_threw` unless
  the transform catches it. Ambient outbound `fetch` from the sandbox is blocked
  (`globalOutbound: null` ALWAYS); permitted fetch only flows through the gate.
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
- **`runInLoader`'s `wasmModules`** (`Record<string, Uint8Array>`) are injected
  using the typed `{ wasm: ArrayBuffer }` form (`WorkerLoaderModule.wasm` is
  typed `ArrayBuffer`, not `Uint8Array` — the loader copies each view out via
  `.slice().buffer`), keyed the same way as `extraModules` and with the same
  never-override-harness/user guard. `WebAssembly.instantiate(bytes)` /
  compile-from-bytes is FORBIDDEN in workerd ("Wasm code generation disallowed
  by embedder") at the host level AND inside Dynamic Workers — verified
  empirically. Injecting a wasm binary straight into the modules map is the
  sanctioned path: `import mod from './add.wasm'` inside the loaded worker
  yields a `WebAssembly.Module`, and `WebAssembly.instantiate(mod)` (the Module
  overload) works with no runtime compilation step. `src/index.ts` decodes
  base64 module content (validated: at most 4 modules, `.wasm` name matching
  `/^[A-Za-z0-9._-]+\.wasm$/`, not `harness.js`/`user.js`, 8 MiB decoded cap per
  module — see `validateCustomModules`/`decodeBase64` in `core.ts`) for both
  custom runs (request-supplied) and example runs (the example's manifest
  modules — the bundled example code retains its relative wasm import, so it
  needs the same injection a custom run would).
- **Log capture via tail**: `LogTailer` (loopback `ctx.exports`, attached as the
  loaded worker's `tails`) forwards trace logs to `LogSession` DO, keyed by
  `runId`; the host polls `getLogs(timeoutMs)`. `LogSession` state is in-memory
  only (no `ctx.storage`) — a deliberate trade for the short single-request rendezvous.
- **Capability gate via env-loopback**: a `ctx.exports.CapabilityGate({ props })`
  loopback attached in the LOADED worker's `env` (not just as a `tails` binding)
  is callable via RPC from inside the Dynamic Worker — verified empirically in the
  local workerd pool (`test/runtime/capability-gate.spec.ts`). The gate is a
  service binding, so `globalOutbound: null` stays in force alongside it. All
  policy (allowlist, SSRF guard, size/timeout/count caps) lives host-side; the
  sandbox only ever receives plain return data.
- **Gate fetch counter is module-scoped, not instance state**: workerd
  instantiates a fresh `WorkerEntrypoint` per RPC call, so a per-instance counter
  would reset each `env.fetch`. The gate keeps a module-level `Map<runId, count>`
  (same in-memory trade as `LogSession`). The sandbox's `limits.subRequests: 5`
  caps this from the other side in production; the host tally is the locally
  testable half.
- **SYNC PARTNER**: `harness-source.ts` inlines `classifyTransformError` as a
  string; `core.ts` is canonical. Change both together.

## Invariants
- Loaded worker `env` carries at most the `CapabilityGate` loopback (`{ GATE }`,
  only under a page-links grant); otherwise it stays `{}`. Never pass host
  bindings/secrets in. The gate returns only plain data — no bindings reach the
  sandbox through it.
- Containment limits: `CPU_LIMIT_MS = 50` (overridable per-run via clamped
  `permissions.cpuMs`), `subRequests: 5`, `globalOutbound: null` (always).
- Gate fetch caps: `fetchText` 2 MiB (UTF-8-boundary), `fetchFile` 20 MiB (byte),
  8s timeout, 5 gate fetches per run (host-side tally keyed by runId — workerd
  instantiates a fresh entrypoint per RPC, so this cannot be instance state).
- `guardFetchUrl` (core, pure) blocks non-http(s) and private/loopback/link-local
  IP literals + localhost; used by the gate AND by `fetchTarget` (pre-fetch on
  the requested URL, and again post-fetch on `response.url` if it differs —
  `fetch` follows redirects transparently, so the final URL must be re-checked).
- `fetchTarget` caps body (default 2 MiB) and timeout (default 8s), truncating
  at a UTF-8 boundary; sets `truncated`.
- The gate's outbound fetch (`doFetch`) uses `redirect: 'manual'` — an
  allowlisted URL that 302s to a private address must not be silently followed
  past the guard; the transform instead sees a plain `{ status: 3xx, ... }`.

## Key Files
- `loader.ts` - load/cache/invoke the Dynamic Worker (shell)
- `harness-source.ts` - in-sandbox entrypoint as a module string (the `HARNESS_SOURCE` actually loaded into the Dynamic Worker)
- `core.ts` - pure helpers: `hashCode`, `truncateBody`, `guardFetchUrl`,
  `clampCpuMs`, `isValidPermissions`, error classifiers
- `capability-gate.ts` - `CapabilityGate` loopback entrypoint (host-side fetch
  policy for the sandbox); exported from `src/index.ts` for `ctx.exports`
- `extract-urls.ts` - pure `extractLinkedUrls` (allowlist derivation from a page)
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
