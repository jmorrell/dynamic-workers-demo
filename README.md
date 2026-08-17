# Dynamic Workers Demo

A runnable companion to [Extensible Software in the Age of LLMs](https://jeremymorrell.dev/blog/extensible-software-in-the-age-of-llms/) and the guide [Working with Dynamic Workers](/guides/working-with-dynamic-workers). It fetches a URL, runs an editable TypeScript transform inside a sandboxed Cloudflare Dynamic Worker, and displays its output, captured logs, and I/O trace.

The playground includes all 13 examples from the article, including arXiv PDF parsing, multi-page citation digests, image perceptual hashing with WebAssembly, RSS crawling through resource capabilities, and a small private SQLite database.

## Run locally

```sh
npm install
npm run build
npm run dev
```

Open the URL printed by Wrangler. Turnstile is bypassed in local development by `.dev.vars`.

The `CPU Spin` example is intentionally disabled locally because workerd does not enforce Dynamic Worker CPU limits during local development. It demonstrates the platform limit when deployed.

## Test

```sh
npm test
```

## How transforms work

Each transform receives `(env, input)`. `input` is the page the host already fetched. `env` contains only the capabilities granted to that example:

- `env.resources` is a map of URLs discovered in the page to target-bound capabilities. A capability has a zero-argument `read()` method; knowing another URL does not grant access to it.
- Text reads can return another `resources` map, allowing explicitly bounded crawling.
- `env.DB` is an optional private SQLite database for the script. The demo caps it at 128 KiB.
- There is no ambient network access from transform code.

See [`src/runtime/AGENTS.md`](src/runtime/AGENTS.md) for the detailed runtime and security contracts.

## Commands

- `npm run dev` — run locally with Wrangler
- `npm run build` — bundle examples and the frontend
- `npm test` — run the workerd-backed test suite
- `npm run deploy` — build and deploy to Cloudflare
- `npm run cf-typegen` — regenerate Worker binding types
