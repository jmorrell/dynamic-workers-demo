# Dynamic Workers Demo

Last verified: 2026-06-22

A Cloudflare Worker that runs untrusted user/example transform code against a
fetched URL inside a sandboxed Dynamic Worker (the `LOADER` `worker_loaders`
binding), with CPU/network containment, captured logs, a curated example
library, and an embeddable widget.

## Tech Stack
- TypeScript on Cloudflare Workers (`nodejs_compat`)
- Dynamic Workers via `LOADER` (worker_loaders binding)
- Durable Object `LogSession` (SQLite migration) + tail worker `LogTailer`
- esbuild build pipeline; vanilla-TS frontend (CodeJar + Prism)
- Testing: `@cloudflare/vitest-pool-workers` (workerd-backed)

## Commands
- `npm run dev` / `npm start` - local dev (`wrangler dev`)
- `npm test` - vitest (workers pool)
- `npm run build` - generate `src/examples/manifest.generated.ts` + `public/app.js`
- `npm run deploy` - `wrangler deploy` (`predeploy` runs `build` first)
- `npm run cf-typegen` - regenerate `worker-configuration.d.ts` after binding changes

## Project Structure
- `src/index.ts` - HTTP entrypoint; routes `/api/examples`, `/api/config`, `/api/run`; abuse gates
- `src/runtime/` - sandbox harness, loader, fetch, log capture, turnstile (see runtime AGENTS.md)
- `src/examples/` - example transforms + registry; manifest generated at build time
- `frontend/` - embeddable widget source, bundled to `public/app.js`
- `public/` - static assets served by `ASSETS`; `app.js` is generated-but-committed
- `scripts/` - esbuild build scripts (`build-examples.mjs`, `build-frontend.mjs`)

## Conventions
- Functional Core / Imperative Shell: every `src/` module starts with a
  `// pattern: Functional Core` or `// pattern: Imperative Shell` marker comment.
- Pure logic (hashing, truncation, error classification, render formatting) lives
  in Functional Core files; I/O and bindings live in Imperative Shell files.

## Generated artifacts (committed, do not hand-edit)
- `src/examples/manifest.generated.ts` - from `scripts/build-examples.mjs` (single
  source of truth is `src/examples/registry.ts`). Regenerate via `npm run build`.
- `public/app.js` - from `scripts/build-frontend.mjs`.
- `worker-configuration.d.ts` - from `wrangler types`.

## Local vitest vs deploy gotchas
The workerd test runtime does NOT reproduce production containment. These are
deploy-verified only:
- CPU limits (`cpuMs`) are NOT enforced locally — `cpu-spin` only fails on deploy.
- Tail events are NOT delivered locally — `LogTailer` → `LogSession` log capture
  is exercised by other means in tests, not via real tail.
- `RATE_LIMITER` is a no-op stub locally (always succeeds).
- `LOADER_COMPAT_DATE` (prod `2026-06-22`) is overridden to a loadable date in
  `vitest.config.mts` because local workerd hard-errors loading future-dated
  Dynamic Workers.

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
