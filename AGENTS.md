# Dynamic Workers Demo

Last verified: 2026-06-22

A Cloudflare Worker that runs untrusted user/example transform code against a
fetched URL inside a sandboxed Dynamic Worker (the `LOADER` `worker_loaders`
binding), with CPU/network containment, captured logs, a curated example
library, and an embeddable widget.

## Capabilities model
Transforms are `(env, input) => …`: `env` is an explicit capability object (its
FIRST argument, mirroring how Workers hand bindings to code), `input` is the page
snapshot. By default `env` is `{}` and the sandbox is fully network-blocked. A
permission grant (`{ fetch: 'page-links' | 'none'; cpuMs?; fetchDepth?; maxFetches?;
storage? }`)
can unlock `env.fetch(url)` / `env.fetchFile(url)`, but they may ONLY reach URLs
that the originally fetched page references (parsed from the payload — no
arbitrary spidering), unless `fetchDepth` (default 1, clamped `[1,3]`) is raised:
at depth N, URLs referenced by pages the run has successfully text-fetched become
fetchable too, transitively, up to N-1 hops out. `maxFetches` (default 5, clamped
`[1,100]`) raises or lowers the per-run cap on `env.fetch`/`env.fetchFile` calls.
`storage: 'scoped'` unlocks `env.storage` (get/put/delete/list), a per-visitor
(`storeId` uuid in the run request, required under the grant) × per-script
key/value store backed by a Durable Object facet's own isolated SQLite DB,
routed through the `StorageHost` supervisor DO; capped (256 B keys / 8 KiB
values / 200 keys / 5 MiB hard `databaseSize` backstop / 8 facets per store / 5
stores per IP) and ephemeral by design — a sliding 1 h self-destruct alarm
deletes the whole store after the last run. All policy (allowlist, SSRF/IP
guards, size/timeout/count caps) lives host-side
in the `CapabilityGate`, which
the sandbox reaches through a `ctx.exports` loopback attached as the loaded
worker's `env.GATE`. Examples run with their registered `permissions`; custom
runs supply their own (validated, `cpuMs` clamped to `[1,5000]`). See
`src/runtime/AGENTS.md` for the gate/extraction/storage contracts.

## Multi-file examples (wasm modules)
An example (`ExampleMeta` in `src/examples/registry.ts`) may declare
`modules: [{ name, kind: 'wasm', file }]` — non-JS modules its entry imports by
relative specifier (e.g. `import mod from './add.wasm'`). `file` is a
repo-relative path to a binary (e.g. `src/examples/add.wasm`, the 41-byte
`wasm-add` example's module) — either committed under `src/examples/` or
package-shipped under `node_modules/` (version pinned by the lockfile, e.g.
`image-hash`'s `@cf-wasm/photon` binary); the build copies it to
`public/modules/<exampleId>/<name>` (a static asset served by `ASSETS`,
generated-but-committed like `public/app.js`) and records the URL path as
`assetPath` in the manifest entry — no base64 in the manifest.
`scripts/build-examples.mjs` bundles such an example with esbuild `external:
['*.wasm']` so the relative import survives verbatim into `code` (esbuild never
tries to load the binary itself — the loader injects the real module at Dynamic
Worker load time). The frontend editor renders one tab per module alongside the
script tab, lazily fetching `assetPath` (directly from the CDN — asset routing
covers everything outside `run_worker_first: ["/api/*"]`) and base64-encoding
the bytes client-side for tab content / a dirty custom-run payload (see
`frontend/lib/render.ts`'s `bytesToBase64`); `src/index.ts` fetches the same
`assetPath` host-side via the `ASSETS` binding for example runs and injects the
bytes via `runInLoader`'s `wasmModules` (see `src/runtime/AGENTS.md`).

## Tech Stack
- TypeScript on Cloudflare Workers (`nodejs_compat`)
- Dynamic Workers via `LOADER` (worker_loaders binding)
- Durable Object `LogSession` (SQLite migration) + tail worker `LogTailer`
- esbuild build pipeline; vanilla-TS frontend (CodeMirror 6, always-editable)
- Testing: `@cloudflare/vitest-pool-workers` (workerd-backed)

## Commands
- `npm run dev` / `npm start` - local dev (`wrangler dev`)
- `npm test` - vitest (workers pool)
- `npm run build` - generate `src/examples/manifest.generated.ts` + `public/app.js`
- `npm run deploy` - `wrangler deploy` (`predeploy` runs `build` first)
- `npm run cf-typegen` - regenerate `worker-configuration.d.ts` after binding changes

## Project Structure
- `src/index.ts` - HTTP entrypoint; routes `/api/examples`, `/api/config`, `/api/run`; abuse gates; exports `LogSession`/`LogTailer`/`CapabilityGate`
- `src/runtime/` - sandbox harness, loader, fetch, log capture, turnstile, capability gate + URL extraction (see runtime AGENTS.md)
- `src/examples/` - example transforms + registry; manifest generated at build time
- `frontend/` - embeddable widget source, bundled to `public/app.js`
- `public/` - static assets served by `ASSETS`; `app.js` is generated-but-committed
- `scripts/` - esbuild build scripts (`build-examples.mjs`, `build-frontend.mjs`)

## Conventions
- Functional Core / Imperative Shell: pure logic (hashing, truncation, error
  classification, render formatting) is kept separate from I/O and bindings,
  without marker comments.

## Generated artifacts (committed, do not hand-edit)
- `src/examples/manifest.generated.ts` - from `scripts/build-examples.mjs` (single
  source of truth is `src/examples/registry.ts`). Regenerate via `npm run build`.
- `src/examples/deps.generated.ts` - from `scripts/build-examples.mjs`; bundled ESM
  source for each shared dependency an edited example imports (see
  `SHARED_DEP_SPECIFIERS` in `src/examples/registry.ts`), keyed by import specifier.
- `public/modules/<exampleId>/<name>` - from `scripts/build-examples.mjs`; raw wasm
  binaries copied from each example's registered `modules[].file` (the dir is
  cleaned first so removed/renamed modules don't leave orphans). Deduped by
  resolved source file: if two examples declare the identical binary (e.g.
  arxiv-digest and arxiv-pdf both use liteparse's wasm), it is copied once and
  the later example's manifest entry just points its `assetPath` into the
  earlier example's directory instead of copying again.
- `public/app.js` - from `scripts/build-frontend.mjs`.
- `worker-configuration.d.ts` - from `wrangler types`.

## Custom code pipeline
Edited/custom code arrives from the frontend as TypeScript (the editor never
distinguishes TS from JS) and is transpiled server-side with `sucrase`
(`src/runtime/transpile.ts`, `transpileUserCode`) before it reaches the loader.
A pristine (unedited) example instead runs by `exampleId`, using its pre-bundled
`manifest.generated.ts` code — no transpile step, no injected deps needed. See
`src/runtime/AGENTS.md` for how edited-example imports (`linkedom`,
`defuddle/node`, the markdown DOM polyfill) get resolved.

## Local vitest vs deploy gotchas
The workerd test runtime does NOT reproduce production containment. These are
deploy-verified only:
- CPU limits (`cpuMs`) are NOT enforced locally — `cpu-spin` only fails on deploy.
- Tail events ARE delivered under `wrangler dev` (verified 2026-07-05) — `LogTailer`
  → `LogSession` log capture works end-to-end there. They are NOT delivered in the
  vitest workers pool; tests exercise log capture by other means, not via real tail.
- `RATE_LIMITER` is a no-op stub locally (always succeeds).
- Turnstile gate (GATE 2 in `src/index.ts`) is bypassed when `ENVIRONMENT=development`
  (set in `.dev.vars`, so only during `wrangler dev`). Deploy uses `ENVIRONMENT=production`
  from wrangler.jsonc vars and enforces the gate. vitest pins `ENVIRONMENT=test` so gate
  tests stay valid.
- Dynamic Worker compat dates are hard-coded in source (`DEFAULT_COMPAT_DATE` in
  `src/runtime/loader.ts`; per-example `compatDate` in `src/examples/registry.ts`),
  not read from a wrangler var. `LOADER_COMPAT_DATE` only exists as a test-only
  override (set in `vitest.config.mts`, active when `ENVIRONMENT=test`) because
  local workerd hard-errors loading future-dated Dynamic Workers.
- Durable Object facets (the `storage` capability's isolation mechanism) WORK
  under `wrangler dev` (workerd 1.20260617) but DO NOT EXIST in the vitest
  workers pool (workerd 1.20260310 predates them): `ctx.facets` is `undefined`
  there, so a storage-granted run in the pool returns a structured
  `loader_failed` ("facets are unavailable") instead of persisting. Facet e2e is
  wrangler-dev/deploy-verified only; pool tests cover the pure logic, the
  supervisor's bookkeeping, and pin the absence
  (`test/runtime/storage-host.spec.ts`). See `src/runtime/AGENTS.md` gotchas for
  the facet-delete/deleteAll quirks.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
