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
permission grant (`{ fetch: 'page-links' | 'none'; cpuMs? }`) can unlock
`env.fetch(url)` / `env.fetchFile(url)`, but they may ONLY reach URLs that the
originally fetched page references (parsed from the payload — no arbitrary
spidering). All policy (allowlist, SSRF/IP guards, size/timeout/count caps) lives
host-side in the `CapabilityGate`, which the sandbox reaches through a
`ctx.exports` loopback attached as the loaded worker's `env.GATE`. Examples run
with their registered `permissions`; custom runs supply their own (validated,
`cpuMs` clamped to `[1,5000]`). See `src/runtime/AGENTS.md` for the gate/extraction
contracts.

## Multi-file examples (wasm modules)
An example (`ExampleMeta` in `src/examples/registry.ts`) may declare
`modules: [{ name, kind: 'wasm', file }]` — non-JS modules its entry imports by
relative specifier (e.g. `import mod from './add.wasm'`). `file` is a
repo-relative path to a binary (e.g. `src/examples/add.wasm`, the 41-byte
`wasm-add` example's module) — either committed under `src/examples/` or
package-shipped under `node_modules/` (version pinned by the lockfile, e.g.
`image-hash`'s `@cf-wasm/photon` binary); the build reads + base64-encodes it
into the manifest entry. `scripts/build-examples.mjs` bundles such an example with
esbuild `external: ['*.wasm']` so the relative import survives verbatim into
`code` (esbuild never tries to load the binary itself — the loader injects the
real module at Dynamic Worker load time). The frontend editor renders one tab
per module (base64 text) alongside the script tab; `src/index.ts` decodes and
injects module base64 for both example and custom runs via `runInLoader`'s
`wasmModules` (see `src/runtime/AGENTS.md`).

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
