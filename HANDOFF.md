# Handoff: dynamic-workers-demo

## Session log (2026-07-06, trace-view session)
- `868ff85` Per-invocation trace capture: every run-shaped `/api/run` response
  now carries `trace: { traceId, totalMs, spans }` (inline only, nothing
  stored). Root `run` span + `target_fetch`/`loader`/`logs_read` phases + one
  span per gate call, denials included as ~0ms error spans. Gate drafts live in
  a module-scoped per-runId map (drained by `collectGateSpans`, cleared by
  `releaseGateRun`); the host normalizes absolute `performance.now()` pairs to
  run-start. New `src/runtime/trace.ts` (types + `Tracer`).
- `9277be9` Widget waterfall: `buildTraceLayout` (pure, `render.ts`) →
  indented rows with clamped percentage bars (min 0.5% sliver for ~0ms spans),
  rendered as a closed-by-default `<details>` under results in `main.ts` —
  textContent/title only (attrs carry untrusted URLs/messages). Live-verified
  under wrangler dev: arxiv-digest shows abs→pdf gate fetches serializing per
  paper; a non-allowlisted `env.fetch` shows as a red denied span.
- Implementation caveat confirmed as designed: workerd advances timers at I/O
  boundaries, so pure-CPU stretches read ~0ms — the waterfall shows I/O shape,
  not CPU attribution.

## Session log (2026-07-06, earlier session)
- `59c602e` Example wasm modules are static assets under `public/modules/`
  (`assetPath` in the manifest, no base64 anywhere). `/api/examples` 8.55 MB →
  ~24 KB; worker upload 5.34 MB → 1.65 MB gzipped. Frontend lazy-fetches module
  bytes per example; example runs fetch host-side via `env.ASSETS`.
- `1455c0f` `fetchDepth` permission (clamp [1,3], default 1): the gate grows
  the allowlist from pages the run has successfully text-fetched, up to the
  granted depth. `releaseGateRun(runId)` cleans per-run gate state (also fixed
  the pre-existing fetchCounts leak). Live-verified with a depth-2 chain.
- `14f01cc` Two new examples: `rss-digest` (feed → Defuddle markdown digest,
  depth 1 on purpose) and `arxiv-digest` (any page citing arXiv → abs pages →
  PDFs via liteparse; first user of `fetchDepth: 2`). Build dedupes identical
  module binaries across examples (liteparse binary ships once).
- `9cfb819` `maxFetches` permission — per-run gate fetch budget, default 5,
  clamp [1, 100]; loader mirrors it into `limits.subRequests` under a
  page-links grant; digests bumped to 6 items / 3 papers with `maxFetches: 6`.
  NOTE for grants near 100: gate fetches spend the HOST request's subrequest
  budget (50 on Workers free plan, 1000 paid) — the clamp deliberately does not
  second-guess the plan limit.

## NEXT UP (planned, not started): user-data storage capability via DO facets

User proposal (2026-07-06): let a transform store its own data across runs.
Durable Object facets are designed for exactly this — build a storage
capability + an example on top of them.

### Facets API (verified against current docs, 2026-07-06)
Docs: developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
(+ blog.cloudflare.com/durable-object-facets-dynamic-workers/). Beta,
**Workers Paid plan**.
- A supervisor DO calls `ctx.facets.get(name, cb)` → stub (fetch + RPC). The
  callback returns `{ class, id? }` where `class` comes from
  `worker.getDurableObjectClass('ClassName')` on a Worker-Loader-loaded worker
  (`this.env.LOADER` — the binding we already have works inside DOs).
- Each facet gets its OWN isolated SQLite DB via standard `ctx.storage`
  (`.kv`/`.sql`); it cannot read the supervisor's DB and the supervisor cannot
  read the facet's. This is the whole security story: hostile code can only
  trash its own facet.
- `ctx.facets.abort(name, reason)` (stop, keep storage — enables code swap on
  next get), `ctx.facets.delete(name)` (drop the facet's DB permanently).

### Proposed architecture
- New permission: `storage?: 'scoped' | 'none'` (default none), same
  declare-and-clamp conventions as fetch/cpuMs/fetchDepth/maxFetches.
  `formatPermissions` shows `storage scoped`.
- New supervisor DO `StorageHost` (SQLite migration, exported from
  src/index.ts). A storage-granted run routes `handleRun → StorageHost RPC`
  instead of calling `runInLoader` directly; the DO loads the SAME
  harness+user workerCode via its `env.LOADER`, but instead of
  `getEntrypoint().run(input)` it mounts the worker's facet-harness DO class:
  `ctx.facets.get(storeKey, cb)` with
  `{ class: worker.getDurableObjectClass('StorageHarness') }`, then RPCs
  `run(input)` on the facet stub. Non-storage runs keep the existing path
  untouched.
- `HARNESS_SOURCE` grows a second export: `StorageHarness` (a DO class) whose
  `run(input)` does exactly what the current entrypoint does, plus builds
  `env.storage = { get, put, delete, list }` over `this.ctx.storage.kv` for
  the transform. The facet's storage IS the isolation boundary, so even
  bypassing our wrapper only reaches the run's own facet DB. Wrapper enforces
  advisory caps (see quotas) and returns plain data only.
- **Store identity (scoping key)**: recommend an anonymous `storeId` minted by
  the widget (`crypto.randomUUID()` persisted in localStorage), sent in the
  run request (validated: uuid shape), combined server-side with the worker
  identity: facet name = `${storeId}:${exampleId}` for pristine examples,
  `${storeId}:custom:${hash(code)}` for custom runs (edited code = different
  store; prevents cross-script reads through a shared store). Supervisor DO id
  = `idFromName(storeId)` so one DO hosts all of a visitor's facets.
- **Quotas — layered, with a HARD byte cap** (user requirement 2026-07-06: no
  one fills 10 GB SQLite DBs for fun; paid plan is a given, DO SQLite limit is
  10 GB, so caps must be ours):
  1. **Hard cap (the backstop)**: the facet harness checks
     `this.ctx.storage.sql.databaseSize` (verified current API — read-only
     byte size of the facet's OWN SQLite DB) on every `env.storage.put`;
     size ≥ STORE_MAX_BYTES (e.g. 5 MiB) → reject the write with a structured
     quota error. Authoritative — includes SQLite overhead, immune to our
     bookkeeping drifting. SPIKE: confirm `databaseSize` inside a facet
     reports the facet DB (expected — facet ctx.storage targets its own DB).
  2. **Per-op caps** in the same wrapper: key ≤ 256 B, value ≤ 8 KiB,
     ≤ 200 keys — keeps logical data (~1.6 MiB) well under the hard cap so
     honest scripts never see the backstop fire.
  3. **Facet-count cap per store**: supervisor tracks its facet names +
     last-used in ITS OWN DB; cap ~8 facets per storeId, LRU-evicted via
     `ctx.facets.delete`.
  4. **Store-count cap per IP**: storeIds are client-minted (localStorage), so
     unlimited-minting is the real abuse vector — a small registry (one DO, or
     a table in a singleton accounting DO) maps clientIp → active storeIds,
     cap ~5, LRU delete of the oldest store's supervisor (which
     `ctx.facets.delete`s its facets).
  5. **Self-destruct alarm (user decision 2026-07-06)**: every storage run
     resets the supervisor's alarm to now + 1 h (sliding). On fire, the
     supervisor `ctx.facets.delete`s all its facets, clears its registry
     entry, then `ctx.storage.deleteAll()` + `deleteAlarm()` on itself — a DO
     with no storage and no alarm ceases to exist and stops billing. Stores
     are ephemeral BY DESIGN: data survives ~1 h past the last run, then the
     whole DO evaporates. (Demo UX consequence: feed-watcher etc. should say
     "remembers for about an hour" in their descriptions. Registry rows get
     the same 1 h expiry.) SPIKE: confirm alarms coexist with facets on the
     same DO (expected; alarms are supervisor-level).
  6. Existing per-IP run rate limit (10/min) bounds creation velocity.
  Worst-case adversarial ceiling per IP becomes calculable AND transient:
  5 stores × 8 facets × 5 MiB = 200 MiB, gone within ~1 h of the abuse
  stopping — vs effectively unbounded without layers 1/4/5.
- **Gate/tails interplay** (spike items — verify empirically before building):
  1. `ctx.exports.CapabilityGate/LogTailer` loopbacks from INSIDE the
     supervisor DO (they're worker-level, should work — verify), so
     storage+fetch grants compose and logs still capture.
  2. `limits.cpuMs`/`globalOutbound: null` semantics for a facet-mounted
     class from a loader worker (assumed same as entrypoint path — verify).
  3. Local support: do facets work under `wrangler dev` / the vitest workers
     pool at all? (Beta + paid-plan feature — may be deploy-only like CPU
     enforcement. If vitest lacks facets, tests isolate the harness logic and
     the supervisor's bookkeeping; facet e2e becomes a wrangler-dev/deploy
     verification, documented in the local-vs-deploy gotchas.)
- **Reset UX**: `DELETE /api/store` (storeId → supervisor drops that store's
  facets) + a small "clear stored data" affordance in the widget when the
  selected example has the storage grant.

### Example to build on it: `feed-watcher`
"What's new since I last ran this?" — input: an RSS/Atom feed (reuses
rss-digest's parsing helpers); stores seen item GUIDs/links in env.storage;
returns only items not seen before + `firstRun`/`newCount`/`seenTotal`
counters. Permissions: `{ storage: 'scoped' }` and NOTHING else — a
storage-only grant makes a clean demo (no network needed beyond the input
snapshot; run twice → second run reports "no new items" until the feed
changes). Registry + tests + live verify like the other examples.

### Resolved by user (2026-07-06)
- Workers Paid plan is a given (facets beta OK).
- Storage MUST be hard-capped per user — see the layered quota design above
  (databaseSize backstop + per-IP store cap are the load-bearing layers).
- **Scoping**: per-browser (anonymous localStorage storeId) × per-script, as
  proposed — no communal stores.
- **Quotas**: blessed as proposed — 5 MiB hard cap / 8 KiB values / 256 B keys
  / 200 keys / 8 facets per store / 5 stores per IP (+ the 1 h sliding
  self-destruct alarm decided earlier).
- **DO detour**: fine — storage runs go through the StorageHost supervisor DO;
  non-storage runs keep the direct path untouched.

No remaining open user questions — the spikes listed above (facets under
wrangler dev/vitest, databaseSize inside a facet, alarms+facets coexistence,
ctx.exports loopbacks from inside a DO, limits semantics for a facet-mounted
class) are the gating work before building.

## Other open items (carried over, unassigned)
1. **Deploy verification**: CPU budgets (`cpuMs`) are enforced only in
   production. image-hash + arxiv-pdf (+ now the digests) verified under
   `wrangler dev` only — a deploy smoke test is pending. Also re-check the
   worker upload size on deploy (dry-run says 2.3 MB gzip after the manifest
   grew with the digests' bundled JS).
2. **Wasm magic-number validation**: custom wasm tab with valid-base64-of-
   non-wasm fails at instantiate time with workerd's raw CompileError
   (structured `loader_failed`, not a crash). Could validate the `00 61 73 6d`
   magic server-side in `validateCustomModules` for a friendlier `bad_request`.
   User's call.
3. **GitHub API is unauthenticated** (60 req/hr/IP) — fine locally, may
   throttle on deploy; a host-side token would fix it (out of scope so far).
4. **manifest.generated.ts is ~6.7 MB source** (bundled example JS: Defuddle/
   linkedom/liteparse glue × several examples) — parsed at worker cold start.
   Not shipped to clients and gzips fine (2.3 MB total upload), but if cold
   starts matter it could move to lazy per-example code assets like the wasm
   did. Low priority.
