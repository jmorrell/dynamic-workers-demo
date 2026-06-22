# Human Test Plan — Dynamic Workers Demo

Generated from the implementation plan `docs/implementation-plans/2026-06-21-dynamic-workers-demo/`
after final code review. Coverage validation: **PASS** — all 30 acceptance criteria
(AC1.1–AC6.3) have automated tests that verify real behavior; the items below cover the
parts local `vitest` cannot fully exercise (interactive UI + behaviors enforced only on
deployed Cloudflare infra).

Automated baseline before manual testing: `npm test` → 15 files, 189 passed | 2 skipped
(the 2 skips are the deploy-verified AC3.1/AC3.2 tail tests); `npx tsc --noEmit` (root +
`frontend/tsconfig.json`) clean.

## Prerequisites
- Node + npm; repo at the project root.
- A Cloudflare account on a plan with Dynamic Worker loaders, Durable Objects, tail
  workers, and the Rate Limiting binding (for the deploy-verified items).
- Production Turnstile sitekey (config var) + secret (`wrangler secret put TURNSTILE_SECRET`) for AC6.2.
- Two terminals (`npm run dev` locally; `npm run deploy` + the `*.workers.dev` URL for deploy items).
- A browser with devtools (Console + Network).

"The run endpoint" = `POST /api/run` with JSON `{ exampleId | customCode, url, turnstileToken }`.

## Phase 5 — Widget UI (local, `npm run dev`)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | `npm run dev`, open `http://localhost:8787/` | Widget loads: example dropdown, code editor, URL field, Run button, empty results pane |
| 5.2 | Open the dropdown | Exactly 6 options: Markdown, OpenGraph Tags, Reddit, Hacker News, CPU Spin, Blocked Fetch (AC4.1) |
| 5.3 | Select "OpenGraph Tags" | Editor fills with the opengraph source; suggested-URL chips appear (AC4.1) |
| 5.4 | Click a suggested URL chip, then Run | Results pane shows a return value (OG tag object) + `timingMs`, no error (AC4.2, AC4.4) |
| 5.5 | Clear the URL, paste an arbitrary article URL, Run | Runs against the entered URL; result reflects that page (AC4.2) |
| 5.6 | Switch to custom code (e.g. `export default (input) => ({ len: input.body.length })`) and edit a line | Syntax highlighting updates live as you type (AC4.3) |
| 5.7 | Run the edited custom code | Results pane shows the returned value + timing (AC4.3, AC4.4) |
| 5.8 | Run a thrower: `export default () => { throw new Error("boom") }` | Error tone with kind + message "boom"; timing still present (AC4.4) |
| 5.9 | Open `/embed-example.html` in the browser | Widget renders correctly inside the `<iframe>`; dropdown, editor, Run all work (AC4.5) |

## Phase 6 — Output safety (local browser)

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | Custom code: `export default () => "<script>alert('xss')</script>"`, Run | Results pane shows the literal text `<script>alert('xss')</script>`; NO alert fires; no script execution in Console (AC6.1) |
| 6.2 | Custom code: `export default () => ({ html: "<img src=x onerror=alert(1)>" })`, Run | Tag shown as inert escaped text; no `onerror` fires (AC6.1) |

## End-to-end (local)
Validates the full AC1 pipeline + AC6.1 in one flow:
1. `npm run dev`, open `/`.
2. Select Markdown, pick a suggested article URL, Run.
3. Network tab: `POST /api/run` returns 200; JSON has `ok:true`, non-empty `result.markdown`, numeric `timingMs`.
4. Rendered markdown matches the article and executes no script.

## Deploy-verified items (after `npm run deploy`)

### AC5.1 — CPU-limit kill + host responsiveness
1. Select "CPU Spin", Run.
2. Expect a response within ~1s: `ok:false`, `error.kind === "cpu_exceeded"` (platform enforces `limits.cpuMs: 50`).
3. During/just after a spin run, issue a concurrent trivial run (second tab or `curl`).
4. The concurrent request completes normally (200, `ok:true`) — the host isn't blocked.

### AC3.1 / AC3.2 / AC3.3 / AC3.4 — Log forwarding via tail worker
1. AC3.1: `export default () => { console.log("a"); console.log("b"); console.log("c"); return 1 }` → response `logs` contains 3 lines a/b/c.
2. AC3.2: `export default () => { throw new Error("kaboom") }` → `logs` includes an `error`-level line containing `Error: kaboom`.
3. AC3.3: log >200 lines or >16 KB → `logsTruncated: true`, lines capped.
4. AC3.4 regression: a silent transform → `logs` empty, `ok:true` (not an error).

### AC6.2 — Turnstile enforcement (production keys)
1. Attempt a run without solving the challenge (POST `/api/run` with no/invalid `turnstileToken`).
2. Expect HTTP 403, `error.kind === "turnstile_failed"`, no `result`/`timingMs`/`logs` (loader not invoked).
3. Solve the challenge in the UI and Run → normal (non-403) response.

### AC6.3 — Real per-IP rate limiting
1. Issue >10 runs from the same IP within 60s (loop the Run button or a `curl` loop with a valid token).
2. The 11th+ within the window → HTTP 429, `error.kind === "rate_limited"`, message contains "Too many runs", no run fields.
3. After the window resets, runs succeed again.

### AC2.1 (optional smoke)
Run Markdown against a real news/blog article URL; confirm non-empty readable markdown.

## Traceability

| AC | Automated | Manual |
|----|-----------|--------|
| AC1.1–AC1.6 | loader/fetch-target/core/index specs | E2E, Steps 5.4–5.8 |
| AC2.1 | examples.spec.ts | Optional deploy smoke |
| AC2.2–AC2.6 | parse/examples/manifest specs | Steps 5.3–5.4 |
| AC3.1 | logs.spec.ts (skip), log-tailer.spec.ts | Deploy AC3.1 |
| AC3.2 | log-tailer.spec.ts | Deploy AC3.2 |
| AC3.3 | log-cap/log-session/logs specs | Deploy AC3.3 |
| AC3.4 | logs/log-session specs | Deploy AC3.4 |
| AC4.1 | render.spec.ts (`exampleOptions`) | Steps 5.2–5.3 |
| AC4.2 | — | Steps 5.4–5.5 |
| AC4.3 | — | Steps 5.6–5.7 |
| AC4.4 | render.spec.ts (`formatRunResponse`) | Step 5.8 |
| AC4.5 | — | Step 5.9 |
| AC5.1 | core.spec.ts (`classifyLoaderError`), safety.spec.ts | Deploy AC5.1 |
| AC5.2 | loader/safety/examples specs | — |
| AC5.3 | loader.spec.ts | — |
| AC6.1 | render.spec.ts (`escapeHtml`), index.spec.ts | Steps 6.1–6.2 |
| AC6.2 | turnstile.spec.ts, abuse.spec.ts | Deploy AC6.2 |
| AC6.3 | abuse.spec.ts | Deploy AC6.3 |
