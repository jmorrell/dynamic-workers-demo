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
  in `types.ts` / `log-types.ts`. Tracing: `trace.ts` (`TraceSpan`/`Trace`/
  `Tracer` — the run response's inline `trace` field) and the gate's
  `collectGateSpans(runId)` (drains per-call span drafts, incl. denials, for
  the host to normalize/parent under its loader span).
- **Transform signature**: the default export is `(env, input) => …`. `env` is a
  capability object (its FIRST argument, mirroring how Workers hand bindings to
  code), `input` is the page snapshot. INPUT is passed PER INVOCATION as the RPC
  argument — NOT via the loaded worker's `env`.
- **run() contract**: the harness exposes `run(input: RunInput): Promise<RunResult>`
  and internally calls `transform(userEnv, input)`. `userEnv` is `{}` under the
  default no-network grant; with fetch permission it is
  `{ fetch(url), fetchFile(url) }`, both proxying to the host `CapabilityGate`.
- **Permissions**: `type Permissions = { fetch: 'page-links' | 'none'; cpuMs?;
  fetchDepth?; maxFetches?; storage? }`. Default `{ fetch: 'none' }`; `cpuMs`
  defaults to `CPU_LIMIT_MS` (50) and is clamped to `[1, 5000]` (`clampCpuMs` in
  core); `fetchDepth` (meaningful only with `fetch: 'page-links'`) defaults to 1
  and is clamped to `[1, 3]` (`clampFetchDepth` in core); `maxFetches` (meaningful
  only with `fetch: 'page-links'`) defaults to 5 and is clamped to `[1, 100]`
  (`clampMaxFetches` in core); `storage: 'scoped' | 'none'` (default none)
  unlocks `env.storage` and REQUIRES the run request to carry a uuid `storeId`
  (validated + lowercased by `normalizeStoreId` in core; missing/malformed →
  400). Example runs use the example's registered permissions (request-supplied
  ignored); custom runs use the request's, validated/clamped (bad shape → 400).
- **Storage contract** (`storage: 'scoped'`): a storage-granted run routes
  `handleRun → env.STORAGE_HOST.get(idFromName(storeId)).run(args)` (the
  `StorageHost` supervisor DO, `storage-host.ts`) instead of `runInLoader`;
  non-storage runs keep the direct path untouched. The supervisor loads the SAME
  harness+user worker via `this.env.LOADER` — both paths build the loaded worker
  through `buildWorkerCode` (`loader.ts`), the ONE construction site (modules
  map + injection guards, compat date, limits, `globalOutbound: null`, GATE env
  loopback, LogTailer tail); the only difference is which isolate calls
  `ctx.exports` and which export gets invoked. The supervisor mounts the
  worker's `StorageHarness` DO class as a facet (`ctx.facets.get(storeKey, …)`
  with `worker.getDurableObjectClass('StorageHarness')`) and RPCs `run(input)`.
  The facet name (store key) comes from `deriveStoreKey` (core, pure):
  `exampleId` for pristine example runs, `custom:${hashCode(code)}` for custom
  runs — edited code = different hash = different store (the storeId itself
  picks the supervisor DO). Each facet has its OWN isolated SQLite DB
  (`ctx.storage`) — the actual isolation boundary. `StorageHarness.run` mirrors
  the default entrypoint plus hands the transform
  `env.storage = { get, put, delete, list }` over the facet's `ctx.storage.kv`
  (JSON-encoded plain-data values), enforcing key ≤ 256 B, serialized value ≤
  8 KiB, ≤ 200 keys, and a hard 5 MiB `ctx.storage.sql.databaseSize` backstop on
  every put (constants live in core.ts and are interpolated into
  `HARNESS_SOURCE`; the cap LOGIC is a SYNC PARTNER with core's
  `checkStorageWrite`). A rejected write throws a catchable Error, consistent
  with gate denials. `StorageHost.run` NEVER throws to handleRun —
  facet-mount/RPC failures return as structured `loader_failed`-taxonomy results
  (`StorageRunResult`).
- **Trace drain inside the DO (critical)**: the gate's module-scoped span/count
  maps live in the isolate that CONSTRUCTED the loopback — on the storage path
  that's the StorageHost DO's isolate, not handleRun's. `StorageHost.run` itself
  drains `collectGateSpans(runId)` and calls `releaseGateRun(runId)`, returning
  the drafts in its RPC result (`StorageRunResult.gateSpans`); handleRun folds
  them into its Tracer exactly like the direct path (parented under the
  loader-phase span, which carries `storage: true` on this path).
- **Storage quotas beyond the facet caps**: the supervisor bookkeeps facet names
  + last-used in its own storage; cap `STORE_FACET_CAP` (8) facets per store,
  LRU-evicted via `ctx.facets.delete` — facets are tracked only AFTER a
  successful first RPC and deletes are try/caught (see gotchas). A per-IP
  registry — a reserved `StorageHost` singleton,
  `idFromName(STORE_REGISTRY_NAME = '__registry__')`, guarded from colliding
  with real storeIds because those must be uuids — caps `STORE_CAP_PER_IP` (5)
  active stores per IP (`touchStore`, LRU; an evicted store's supervisor is torn
  down via `selfDestruct()`). Every storage run resets a sliding self-destruct
  alarm (now + 1h, `STORE_TTL_MS`); on fire the supervisor deletes its facets,
  clears its bookkeeping, `deleteAlarm()`, then best-effort `deleteAll()` —
  stores are ephemeral BY DESIGN (~1h past the last run). LRU selection math is
  pure (`selectEvictions`, core).
- **Gate contract**: `CapabilityGate` (WorkerEntrypoint, reached via
  `ctx.exports.CapabilityGate({ props: { runId, allowedUrls, fetchDepth, maxFetches } })`,
  attached as the loaded worker's `env.GATE`). `fetchText(url) → { status,
  contentType, body, truncated }` (2 MiB, UTF-8-boundary truncation); `fetchFile(url)
  → { status, contentType, bytes, truncated }` (20 MiB, byte truncation). Both
  require the normalized URL to be reachable on the allowlist — URLs referenced by
  the fetched page, plus — up to `fetchDepth` — URLs referenced by pages the run has
  successfully text-fetched (no arbitrary spidering beyond that bound) — pass the
  SSRF host guard (`guardFetchUrl`), obey an 8s timeout, and share a per-run fetch
  cap (granted `maxFetches`, default 5, clamp `[1, 100]`). Only `fetchText` grows
  the allowlist on a successful (`response.ok`) fetch, by extracting the served
  body's links at the next depth; `fetchFile` never does (binary responses,
  text-only extraction).
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
  (same in-memory trade as `LogSession`). The sandbox's `limits.subRequests`
  (mirroring the granted `maxFetches`) caps this from the other side in
  production; the host tally is the locally testable half.
- **SYNC PARTNER**: `harness-source.ts` inlines `classifyTransformError` as a
  string, and inlines the `env.storage` cap-check logic mirroring core's
  `checkStorageWrite` (the numeric limits are interpolated from core's
  `STORE_MAX_*` constants, but the check ordering/logic is hand-copied);
  `core.ts` is canonical for both. Change both together.

## Invariants
- Loaded worker `env` carries at most the `CapabilityGate` loopback (`{ GATE }`,
  only under a page-links grant); otherwise it stays `{}`. Never pass host
  bindings/secrets in. The gate returns only plain data — no bindings reach the
  sandbox through it.
- Containment limits: `CPU_LIMIT_MS = 50` (overridable per-run via clamped
  `permissions.cpuMs`), `subRequests: 5` by default, mirroring the granted
  `maxFetches` (clamped `[1, 100]`) under a page-links grant — see the gate
  fetch caps bullet below — `globalOutbound: null` (always).
- Gate fetch caps: `fetchText` 2 MiB (UTF-8-boundary), `fetchFile` 20 MiB (byte),
  8s timeout, `maxFetches` gate fetches per run (default 5, clamped `[1, 100]` —
  host-side tally keyed by runId — workerd instantiates a fresh entrypoint per
  RPC, so this cannot be instance state). The loaded worker's `limits.subRequests`
  mirrors the same granted `maxFetches` value (both sides of the cap must move
  together, same as the fixed 5/5 default before this existed) — except when
  `fetch` isn't `'page-links'`, where there's no gate to mirror and
  `subRequests` stays at the old constant 5. Note: gate fetches execute in the
  HOST worker's own request context, and the Workers platform caps subrequests
  per request (50 free plan, 1000 paid — see `/workers/platform/limits`); a
  `maxFetches` grant near 100 can hit that platform wall before the gate's own
  tally does on a free-plan deployment. Allowlist growth from `fetchDepth` is
  capped at `GATE_MAX_GROWN_URLS` (5000) grown entries per run — a memory bound
  only; the real reachability bound is the granted `maxFetches` (at most that
  many pages can ever contribute grown URLs). `releaseGateRun(runId)` (called
  from `src/index.ts`'s `handleRun` after logs are read and gate spans are
  drained) deletes a run's entries from the fetch-count, grown-allowlist, and
  gate-span maps — best-effort hygiene; correctness never depends on it running.
- Every gate call (fetchText/fetchFile) records a trace span draft — denials
  included, as ~0ms error spans with the deny reason — into a module-scoped
  per-runId map (same fresh-entrypoint-per-RPC reasoning as fetchCounts),
  using absolute `performance.now()` pairs; the HOST normalizes to run-start
  when draining via `collectGateSpans`. Recording never changes
  transform-visible behavior: thrown messages/errors are byte-identical and
  rethrown unchanged.
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
- `storage-host.ts` - `StorageHost` supervisor DO (storage-granted run path:
  loads the worker via `buildWorkerCode`, mounts `StorageHarness` as a facet,
  drains gate spans in-DO; also the per-IP store registry singleton + sliding
  self-destruct alarm); exported from `src/index.ts`, bound as `STORAGE_HOST`
- `trace.ts` - per-invocation trace types + `Tracer` (span ids, absolute→
  run-relative normalization); NOT OTel — the bespoke minimal span shape is the
  contract. workerd advances timers at I/O boundaries, so the waterfall shows
  I/O shape, not CPU attribution
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
- **DO facets exist under `wrangler dev` but NOT in the vitest workers pool**:
  wrangler dev's workerd (1.20260617) has `ctx.facets`; the pool's pinned
  workerd (1.20260310, via @cloudflare/vitest-pool-workers 0.12.x → wrangler
  4.72.0) predates the April 2026 facets launch, so `ctx.facets` is `undefined`
  there. `StorageHost.run` guards this into a structured `loader_failed`
  ("facets are unavailable"), and `test/runtime/storage-host.spec.ts` pins the
  absence. NEVER try to e2e a facet in the pool — facet persistence is
  wrangler-dev/deploy-verified only; pool tests cover pure logic + supervisor
  bookkeeping.
- **`ctx.storage.deleteAll()` throws "internal error" after `ctx.facets.delete()`**
  on local workerd (spike-verified 2026-07-06; deploy re-verification pending).
  `StorageHost._teardown` therefore deletes its bookkeeping rows explicitly,
  then calls `deleteAll()` best-effort in try/catch — a throw leaves only tiny
  idle residue.
- **Deleting a never-RPC'd facet throws "internal error"** — the supervisor only
  tracks a facet AFTER its first successful `run` RPC, and every
  `ctx.facets.delete` is individually try/caught.
