# Dynamic Workers Demo Design

## Summary

This project is a live, embeddable demo of Cloudflare's Dynamic Workers capability —
the platform feature that lets a trusted Worker load and execute arbitrary code
strings in isolated, resource-constrained sub-workers. The demo is designed to be
embedded as an `<iframe>` widget on a blog or documentation page, where a visitor can
pick from a curated set of content-transform scripts (extracting article text,
OpenGraph metadata, Reddit or Hacker News comments) or write their own, point it at
any URL, and watch it run in real time.

The high-level approach is a single Cloudflare Worker (the "trusted host") that owns
all capabilities — network access, secrets, rate limiting — and hands untrusted code
only a pre-fetched, size-capped snapshot of the target URL's contents via `env.INPUT`.
Every run, whether a built-in example or user-supplied code, goes through the same
loader path: code is passed to `env.LOADER`, which creates a fresh isolate with
`globalOutbound: null` (no outbound network) and an explicit CPU budget, then calls a
`transform(input)` function over RPC and returns a structured result. Curated examples
are bundled at build time with esbuild so their npm dependencies (like `defuddle` for
article extraction) are inlined and need no runtime compilation. Logs emitted during a
run are captured through the platform's tail-worker mechanism and forwarded back to
the response via a `LogSession` Durable Object, giving visitors a complete picture of
what their code did — including when the platform kills it.

## Definition of Done

A deployed Cloudflare Worker that takes a URL, fetches its contents in the trusted
host, and runs **either a curated example script or arbitrary user-supplied code**
against those contents inside a Dynamic Worker (`env.LOADER`) with
`globalOutbound: null` — proving untrusted code runs safely.

**v1 ships with:**

- **Example scripts (all run through the loader):**
  - Content transforms: Readability/markdown (defuddle), OpenGraph tags, Reddit
    top comments, Hacker News top comments. (YouTube transcript deferred to v2 —
    it needs a second network hop that conflicts with `globalOutbound: null`.)
  - Safety demos: `while(true)` CPU spin gets killed by platform limits; a blocked
    `fetch()`.
- **Custom code editor + any-URL input**, available alongside every example.
- **Embeddable iframe widget**: dropdown of examples (each with suggested URLs +
  free URL input), syntax-highlighted code view, the run's return value, surfaced
  errors, and forwarded logs (with a hard byte cap).
- **Debuggability:** a tail worker captures the run's logs and forwards them to the
  browser.
- **Safety/abuse:** all rendered output is safely escaped; Turnstile gate + per-IP
  rate limiting on runs.

**Build approach:** example scripts are **pre-built/bundled at build time** (esbuild,
needed for npm deps like `defuddle`) and embedded as module strings, rather than
compiled at request time. No runtime bundler in v1. (`@cloudflare/worker-bundler` is
the official runtime-bundling option, reserved for the v2 "import npm packages" path;
note the package the user named, `workers-builder`, is not the official one.) The
codebase should stay as simple and approachable as possible.

**Explicitly out of scope for v1 (deferred to v2):**

- Controlled/constrained fetch binding (only URLs found in the source doc, with a
  hard limit).
- AI image captioning.
- Durable Object facet storage with per-user quotas.
- PDF → markdown.
- WASM execution.

**Success looks like:** From the embedded widget, a visitor picks "Reddit top
comments," runs it on a thread URL, and sees structured output + logs; switches to
"CPU spin," runs it, and sees the platform kill it with a clear error rather than
hanging the app; writes their own `fetch()` and sees it blocked — all without
affecting the host.

## Acceptance Criteria

### dynamic-workers-demo.AC1: Untrusted code runs against a URL through the loader
- **dynamic-workers-demo.AC1.1 Success:** Posting custom `transform(input)` code + a URL fetches the URL host-side and returns the function's value.
- **dynamic-workers-demo.AC1.2 Success:** `input` exposes `{ url, finalUrl, status, contentType, body }` from the host fetch.
- **dynamic-workers-demo.AC1.3 Success:** The return value round-trips as structured data (object/array/string) over RPC.
- **dynamic-workers-demo.AC1.4 Failure:** Code that throws inside `transform` returns a structured `error` (message surfaced, no host crash).
- **dynamic-workers-demo.AC1.5 Failure:** A target URL that fails to fetch (DNS/timeout/non-200) returns a clear fetch error without invoking the loader pointlessly.
- **dynamic-workers-demo.AC1.6 Edge:** A target response over the size cap is truncated and `input.truncated` is true.

### dynamic-workers-demo.AC2: Curated content-transform examples produce expected output
- **dynamic-workers-demo.AC2.1 Success:** `markdown` (defuddle) returns markdown/clean text for an article URL.
- **dynamic-workers-demo.AC2.2 Success:** `opengraph` returns the OpenGraph tags found in the document.
- **dynamic-workers-demo.AC2.3 Success:** `reddit` returns top comments parsed from a thread's `.json`.
- **dynamic-workers-demo.AC2.4 Success:** `hackernews` returns top comments for an HN thread.
- **dynamic-workers-demo.AC2.5 Failure:** An example run against an unsuitable URL (e.g. no OG tags) returns an empty/structured result, not an unhandled crash.
- **dynamic-workers-demo.AC2.6 Edge:** `npm run build` regenerates the example manifest with bundled code strings (deps inlined).

### dynamic-workers-demo.AC3: Logs are captured and forwarded, byte-capped
- **dynamic-workers-demo.AC3.1 Success:** A `transform` that calls `console.log` N times yields those N lines in the response.
- **dynamic-workers-demo.AC3.2 Success:** An exception thrown by the loaded worker appears in the returned logs.
- **dynamic-workers-demo.AC3.3 Failure/Edge:** Log output beyond the byte/line cap is truncated and a `truncated` flag is set.
- **dynamic-workers-demo.AC3.4 Edge:** A run that emits no logs returns an empty log list (not an error).

### dynamic-workers-demo.AC4: The embeddable widget lets a visitor run examples and custom code
- **dynamic-workers-demo.AC4.1 Success:** The example dropdown is populated and selecting one shows its code and suggested URLs.
- **dynamic-workers-demo.AC4.2 Success:** A visitor can run a suggested URL or enter an arbitrary URL for any example.
- **dynamic-workers-demo.AC4.3 Success:** A visitor can switch to custom code, edit it (syntax-highlighted), and run it.
- **dynamic-workers-demo.AC4.4 Success:** The results pane shows return value, logs, errors, and timing for a run.
- **dynamic-workers-demo.AC4.5 Edge:** The widget renders correctly when embedded via `<iframe>`.

### dynamic-workers-demo.AC5: The platform contains hostile code without affecting the host
- **dynamic-workers-demo.AC5.1 Success:** `cpu-spin` (`while(true)`) is killed by the CPU limit in well under a second and returns a `cpu_exceeded` error; the host serves a concurrent request normally.
- **dynamic-workers-demo.AC5.2 Success:** `blocked-fetch` (a `fetch()` call) is blocked by `globalOutbound: null` and returns a friendly network-blocked error.
- **dynamic-workers-demo.AC5.3 Failure:** Loaded code cannot reach host secrets or bindings not placed in its `env`.

### dynamic-workers-demo.AC6: Output is safe and the public endpoint is protected
- **dynamic-workers-demo.AC6.1 Success:** Run output/fetched content containing HTML or `<script>` is rendered inert (escaped), not executed.
- **dynamic-workers-demo.AC6.2 Failure:** A run request without a valid Turnstile token is rejected and does not invoke the loader.
- **dynamic-workers-demo.AC6.3 Failure:** Exceeding the per-IP rate limit returns 429 with a clear message and does not invoke the loader.

## Glossary

- **Dynamic Workers**: A Cloudflare Workers platform feature that allows a running Worker to load and execute a code string as a new, isolated Worker at runtime, configured with its own environment, resource limits, and network policy.
- **`env.LOADER`**: The Dynamic Workers binding configured in `wrangler.jsonc` that the host Worker calls to create and invoke a loaded Worker.
- **trusted host**: The single Cloudflare Worker (`src/index.ts`) that owns all capabilities — network, secrets, bindings — and orchestrates every run. Untrusted code never runs here.
- **`globalOutbound: null`**: A Dynamic Workers configuration option that disables all outbound network access inside the loaded isolate, making `fetch()` calls throw rather than reaching the internet.
- **`limits.cpuMs`**: A Dynamic Workers option that sets a hard CPU time budget for the loaded worker, causing it to be killed deterministically if it exceeds the threshold (demonstrated by the `cpu-spin` example).
- **harness** (`src/runtime/harness.ts`): A thin `WorkerEntrypoint` module that acts as the loaded worker's entry point. It reads `env.INPUT`, imports the user or example module, calls its `transform(input)` function, wraps the call in try/catch, and returns a structured result over RPC.
- **`transform(input)`**: The contract that every example and custom code must satisfy — a default-exported function that receives the pre-fetched page data and returns a structured value.
- **`INPUT`**: The structured object (`{ url, finalUrl, status, contentType, body, truncated }`) produced by the host's fetch of the target URL and passed into the loaded isolate via `env.INPUT`.
- **`WorkerEntrypoint`**: A Cloudflare Workers class that exposes named RPC methods callable from other Workers or from the platform itself (used here for both the harness and the `LogTailer`).
- **Durable Object (DO)**: A Cloudflare Workers primitive providing a single-instance, stateful object with strongly consistent storage. Used here for `LogSession` to rendezvous log data between the async tail worker and the synchronous request handler.
- **`LogSession`**: The `LogSession` Durable Object instance (keyed by `runId`) that stores captured log lines for a single run, enforces byte/line caps, and serves them back to the request handler after the run completes.
- **`LogTailer`**: A `WorkerEntrypoint` attached via the `tails` array of a loaded worker. The platform invokes it after the loaded worker finishes, passing collected `console.log` and exception events, which it then writes into the corresponding `LogSession`.
- **tail worker**: A Cloudflare Workers feature where a secondary Worker receives telemetry events (logs, exceptions, lifecycle info) from a primary Worker after it finishes executing. Used here to capture `console.log` calls from inside the loaded isolate.
- **`ctx.exports`**: The mechanism by which a Worker exposes named `WorkerEntrypoint` and Durable Object classes to bindings and to the Dynamic Workers `tails` array without a separate Worker deployment.
- **defuddle**: An npm library used by the `markdown` example to strip boilerplate from article HTML and return clean readable text or Markdown.
- **esbuild**: A fast JavaScript/TypeScript bundler used at build time to compile each example module and inline its npm dependencies into a self-contained module string.
- **example manifest**: The build-time-generated artifact (`src/examples/manifest.ts`) that contains each curated example's `id`, `title`, `description`, `suggestedUrls`, and bundled `code` string.
- **Turnstile**: Cloudflare's CAPTCHA-alternative bot-detection widget. A Turnstile token is submitted with each `/api/run` request and verified server-side before the loader is invoked.
- **`codeHash`**: A content-derived identifier for a code string, used as the cache key when calling `env.LOADER.get(...)` so that identical code reuses a warm isolate.
- **functional-core/imperative-shell**: An architectural pattern where pure, side-effect-free logic (parsing, transforms, escaping) is kept separate from code with I/O side effects (network, DO, loader calls). Applied here to keep example `transform` functions and helpers testable in isolation.
- **`@cloudflare/vitest-pool-workers`**: A Vitest plugin that runs tests inside the real Cloudflare Workers runtime, so bindings like `env.LOADER`, Durable Objects, and resource limits behave as they do in production.
- **RPC (Remote Procedure Call)**: The mechanism used to invoke `WorkerEntrypoint` methods across Worker boundaries. Here, `stub.getEntrypoint().run()` calls the harness's `run()` method and returns its structured-clone-serializable return value.

## Architecture

The system is one Cloudflare Worker that acts as the **trusted host** plus the
**untrusted Dynamic Workers** it loads. The host owns every capability; loaded code
gets only what the host hands it. The same loader path runs curated examples and
arbitrary user code — that sameness is the demo's whole point.

### Request flow (`POST /api/run`)

```
browser (iframe widget)
  │  { exampleId | customCode, url, turnstileToken }
  ▼
host Worker  ── verify Turnstile ── rate-limit by IP
  │
  ├─ fetch target URL (host-side, trusted; size + time capped) ─► INPUT
  │      INPUT = { url, finalUrl, status, contentType, body, truncated }
  │
  ├─ resolve code: pre-bundled example string  OR  user code wrapped in harness
  │
  ├─ create LogSession DO (keyed by runId), begin waiting for logs
  │
  ├─ env.LOADER.get(codeHash, () => ({
  │       compatibilityDate, mainModule: "harness.js",
  │       modules: { "harness.js", "user.js" },
  │       env: { INPUT },                 // structured data only
  │       globalOutbound: null,           // no network
  │       limits: { cpuMs, subRequests }, // deterministic kill for CPU spin
  │       tails: [ctx.exports.LogTailer({ props: { runId } })],
  │   }))
  │
  ├─ result = await stub.getEntrypoint().run()   // RPC, structured-clone return
  ├─ logs   = await logSession.getLogs(timeout)  // capped bytes/lines
  ▼
  { ok, result, logs, error, timingMs }  ─► browser renders (all escaped)
```

### Trust boundary and components

**Host Worker** (`src/index.ts`) — router and orchestration: Turnstile verification,
rate limiting, target fetch, code resolution, loader invocation, response assembly.
This is the only code with network and secret access.

**Harness module** (`src/runtime/harness.ts`, bundled into each loaded worker as
`harness.js`) — the loaded worker's `mainModule`. Exports a `WorkerEntrypoint` whose
`run()` method: reads `env.INPUT`, imports the user/example module, calls its default
`transform(input)` export, and returns the value over RPC. It wraps the call in
try/catch so a thrown `fetch()` (blocked by `globalOutbound: null`) or other error
becomes a structured, friendly result rather than an opaque crash.

**Example modules** (`src/examples/*.ts`) — each default-exports
`function transform(input)`. Built at build time (esbuild) into self-contained module
strings (with deps like `defuddle` inlined) and collected into a manifest with `id`,
`title`, `description`, and `suggestedUrls`. v1 set: `markdown`, `opengraph`,
`reddit`, `hackernews`, `cpu-spin`, `blocked-fetch`.

**`LogTailer`** (`WorkerEntrypoint` in the host, referenced via `ctx.exports`) —
attached through the `tails` array. After the loaded worker finishes, it receives the
collected `console.log`/exception events and writes them into the `LogSession` DO
keyed by `runId`.

**`LogSession` Durable Object** — the shared rendezvous between the async tail and the
synchronous request handler. The handler registers a session before the run and reads
logs back (with a short timeout) after; the tailer writes them in between. Enforces
the log byte/line cap on write.

**Rate limiter** — per-IP request limiting on `/api/run`, gating loader runs.

**Frontend widget** (`public/`, vanilla TS bundled to one asset) — example dropdown,
URL input, editable + syntax-highlighted code view, Run button (Turnstile), and a
results pane showing return value, logs, errors, and timing. Served by the host and
embedded via `<iframe>`. All dynamic values rendered via safe escaping / `textContent`.

### Why these mechanisms

- **`env.INPUT` for arguments, RPC for return:** `env` carries structured-cloneable
  data into the isolate; a `WorkerEntrypoint.run()` returns a structured value back.
  Cleaner and safer than serializing through `Request`/`Response`.
- **`limits.cpuMs` for the spin demo:** an explicit low CPU budget kills `while(true)`
  in milliseconds, deterministically, instead of waiting on the 30s/5-min defaults.
- **Tail + DO for logs:** this is the official real-time log-forwarding pattern; tails
  run after the response is sent, so the DO is the only way to fold them back in.

## Existing Patterns

Investigation found a fresh `create-cloudflare` TypeScript scaffold: a module Worker
at `src/index.ts`, `wrangler.jsonc` (compat date `2026-06-22`, `nodejs_compat`,
`observability.enabled = true`), `@cloudflare/vitest-pool-workers` configured in
`vitest.config.mts` with a `test/` directory, and `tsconfig.json` in strict mode.
There is no application code yet, so this design establishes the initial patterns:

- Single Worker entry at `src/index.ts` using `satisfies ExportedHandler<Env>`
  (matches the scaffold and the official Dynamic Workers starter).
- Tests via `@cloudflare/vitest-pool-workers` in `test/`, exercising the host through
  the Workers runtime (so `env.LOADER`, the DO, and limits behave realistically).
- `WorkerEntrypoint` + Durable Object classes co-located in the host Worker and wired
  through `ctx.exports`, following the official Observability and Egress-control docs.

The design follows functional-core/imperative-shell separation: pure parsing/escaping
helpers and the example `transform` functions are side-effect-free; the host's fetch,
loader, DO, and Turnstile/rate-limit calls form the imperative shell.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Loader Skeleton + Harness Contract
**Goal:** End-to-end "run code against a URL" through a Dynamic Worker with `globalOutbound: null`, returning a structured result.

**Components:**
- `wrangler.jsonc` — add the Worker Loader binding (`LOADER`) and a `worker_loaders` entry; keep `observability.enabled`.
- `src/runtime/harness.ts` — `WorkerEntrypoint.run()` that reads `env.INPUT`, imports the user module, calls `transform(input)`, try/catches, returns a structured `{ ok, value | error }`.
- `src/runtime/loader.ts` — wraps `env.LOADER.get(codeHash, …)`: builds `modules` (harness + supplied code), sets `env.INPUT`, `globalOutbound: null`, `limits`, runs via `getEntrypoint().run()`.
- `src/index.ts` — `POST /api/run` accepting `{ customCode, url }` (Turnstile/rate-limit added later); host-side target fetch with size/time cap producing `INPUT`.

**Dependencies:** None (first phase).

**Done when:** A request with trivial `transform` code returns its value; a `transform` that calls `fetch()` returns a friendly blocked-network error; tests covering `dynamic-workers-demo.AC1.*` and `dynamic-workers-demo.AC5.2` pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Resource Limits + Safety Demos
**Goal:** Prove the platform contains hostile code — CPU spin and blocked fetch — without affecting the host.

**Components:**
- `src/runtime/loader.ts` — apply `limits: { cpuMs, subRequests }`; map limit-exceeded exceptions to a clear `error` shape (`cpu_exceeded`).
- `src/examples/cpu-spin.ts` — `transform` containing `while(true){}`.
- `src/examples/blocked-fetch.ts` — `transform` that attempts `fetch(...)`.

**Dependencies:** Phase 1.

**Done when:** Running `cpu-spin` returns a `cpu_exceeded` error in well under a second and the host stays responsive to a concurrent request; `blocked-fetch` returns a network-blocked error; tests covering `dynamic-workers-demo.AC5.1` and `dynamic-workers-demo.AC5.2` pass.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Example Library + Build-Time Bundling
**Goal:** The curated content-transform examples, bundled and exposed as a manifest.

**Components:**
- `src/examples/{markdown,opengraph,reddit,hackernews}.ts` — each default-exports `transform(input)`; `markdown` depends on `defuddle`, `reddit`/`hackernews` parse the `.json` document the host fetched.
- `scripts/build-examples.ts` — esbuild step that bundles each example (deps inlined) into a module string and emits a generated manifest (`id`, `title`, `description`, `suggestedUrls`, `code`).
- `src/examples/manifest.ts` — typed accessor over the generated manifest; `GET /api/examples` exposes it (without code or with code, per widget need).
- `src/index.ts` — `/api/run` resolves `exampleId` to bundled code.

**Dependencies:** Phase 1.

**Done when:** Each example run against a suggested URL returns expected structured output; `npm run build` regenerates the manifest; tests covering `dynamic-workers-demo.AC2.*` pass.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Log Capture + Real-Time Forwarding
**Goal:** Surface a run's `console.log` output and exceptions in the response, byte-capped.

**Components:**
- `src/runtime/log-session.ts` — `LogSession` Durable Object: register session, append (enforcing byte/line cap), read with timeout.
- `src/runtime/log-tailer.ts` — `LogTailer` `WorkerEntrypoint.tail()` that writes events into `LogSession` by `runId` (from `ctx.props`).
- `src/runtime/loader.ts` — attach `tails: [ctx.exports.LogTailer({ props: { runId } })]`.
- `src/index.ts` — create session before the run, read logs after, include `logs` + `truncated` flag in the response.
- `wrangler.jsonc` — Durable Object binding + migration for `LogSession`.

**Dependencies:** Phases 1–3.

**Done when:** A `transform` that logs N lines yields those lines in the response; output beyond the cap is truncated with a flag; exceptions appear in logs; tests covering `dynamic-workers-demo.AC3.*` pass.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Embeddable Widget UI
**Goal:** The iframe widget: pick an example or write code, run a URL, see escaped results.

**Components:**
- `public/` — `index.html` + vanilla TS bundled to one JS asset; example dropdown (populated from `/api/examples`), suggested-URL chips + free URL input, editable syntax-highlighted code view (lightweight highlighter), Run button, results pane (return value, logs, errors, timing).
- Escaping helpers — render all dynamic values via `textContent`/escape; no `innerHTML` with run output.
- `wrangler.jsonc` — `assets` binding to serve `public/`.

**Dependencies:** Phases 3–4.

**Done when:** From the rendered widget a visitor selects an example, runs a suggested and a custom URL, switches to custom code, and sees return value + logs + errors; output containing HTML/script is shown inert (escaped); tests covering `dynamic-workers-demo.AC4.*` and `dynamic-workers-demo.AC6.1` pass.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Abuse Controls (Turnstile + Rate Limiting)
**Goal:** Make the public endpoint safe to expose on an open blog.

**Components:**
- `src/index.ts` — verify Turnstile token (server-side siteverify) before running; reject missing/invalid tokens.
- Rate limiting — per-IP limit on `/api/run` (rate-limiting binding or DO counter); return 429 when exceeded.
- `public/` — Turnstile widget; include token in the run request.
- `wrangler.jsonc` + secrets — Turnstile keys, rate-limit binding.

**Dependencies:** Phases 1, 5.

**Done when:** Runs without a valid Turnstile token are rejected; exceeding the per-IP limit returns 429 with a clear message and does not invoke the loader; tests covering `dynamic-workers-demo.AC6.*` pass.
<!-- END_PHASE_6 -->

## Additional Considerations

**Output safety:** the threat isn't only the sandbox — fetched page content and run
output can contain HTML/JS. The widget renders every dynamic value via
`textContent`/escaping, never `innerHTML`. This is itself an acceptance criterion
(`dynamic-workers-demo.AC6.1`).

**Caps as first-class:** target-fetch size/time, `limits.cpuMs`/`subRequests`, and the
log byte/line cap are all explicit and surfaced in the UI (e.g. "output truncated").
The caps are part of the lesson, not hidden guards.

**Loader caching:** examples use `get(codeHash, …)` so identical code stays warm;
custom code hashes to its own id. Same code → same id is required for correct caching.

**v2 groundwork:** the `INPUT`/`transform` contract and the host-owned-capability model
extend cleanly to v2 (constrained-fetch binding via an `HttpGateway` `WorkerEntrypoint`
on `globalOutbound`, AI captioning as a rate-limited binding, DO facet storage). No
architectural change required to add them.
