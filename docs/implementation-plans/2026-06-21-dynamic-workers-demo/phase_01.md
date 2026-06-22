# Dynamic Workers Demo — Phase 1: Loader Skeleton + Harness Contract

**Goal:** End-to-end "run code against a URL" through a Dynamic Worker with `globalOutbound: null`, returning a structured result.

**Architecture:** A single trusted host Worker (`src/index.ts`) handles `POST /api/run`, fetches the target URL host-side (size/time capped) to build `INPUT`, then loads untrusted code into a Dynamic Worker via `env.LOADER`. The loaded worker's `mainModule` is a harness (`WorkerEntrypoint`) that reads `this.env.INPUT`, imports the supplied `transform`, and returns a structured `{ ok, value | error }` over RPC. Pure helpers (hashing, input shaping, error shaping) live in the functional core; fetch/loader calls form the imperative shell.

**Tech Stack:** TypeScript (strict), Cloudflare Workers, Worker Loader binding (`worker_loaders`), `cloudflare:workers` `WorkerEntrypoint`, `@cloudflare/vitest-pool-workers` (tests run in the real Workers runtime).

**Scope:** Phase 1 of 6.

**Codebase verified:** 2026-06-21. Fresh create-cloudflare scaffold; `src/index.ts` returns "Hello World!"; `wrangler.jsonc` has compat date `2026-06-22`, `nodejs_compat`, `observability.enabled`; no bindings configured yet; `package.json` has no `defuddle`/`esbuild`/`build` script; tests use `cloudflare:test` in `test/`.

**Key API facts (verified from developers.cloudflare.com/dynamic-workers, 2026-06-21):**
- Binding declared in wrangler as `"worker_loaders": [ { "binding": "LOADER" } ]`. No special compat flag required.
- `env.LOADER.get(id, callback)` caches by `id` (callback may be async, returns the WorkerCode); `env.LOADER.load(code)` is the one-shot form.
- WorkerCode fields: `compatibilityDate`, `compatibilityFlags?`, `allowExperimental?`, `mainModule`, `modules` (Record<string,string>), `env` (structured-clonable values + service-binding stubs), `globalOutbound` (`null` blocks all outbound fetch), `limits?` (`{ cpuMs?, subRequests? }`, camelCase), `tails?`.
- Invoke: `worker.getEntrypoint()` returns a stub of the loaded worker's **default** entrypoint; call named RPC methods on it, e.g. `await worker.getEntrypoint().run()`.
- Inside the loaded worker, env is read via `this.env.X` on a default-exported `WorkerEntrypoint` subclass.

**Skills to apply during execution:** `ed3d-plan-and-execute:test-driven-development`, `ed3d-plan-and-execute:writing-good-tests`, `ed3d-house-style:howto-code-in-typescript`, `ed3d-house-style:howto-functional-vs-imperative`. After editing `wrangler.jsonc` bindings, run `npm run cf-typegen` so the `Env` type includes `LOADER`.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### dynamic-workers-demo.AC1: Untrusted code runs against a URL through the loader
- **dynamic-workers-demo.AC1.1 Success:** Posting custom `transform(input)` code + a URL fetches the URL host-side and returns the function's value.
- **dynamic-workers-demo.AC1.2 Success:** `input` exposes `{ url, finalUrl, status, contentType, body }` from the host fetch.
- **dynamic-workers-demo.AC1.3 Success:** The return value round-trips as structured data (object/array/string) over RPC.
- **dynamic-workers-demo.AC1.4 Failure:** Code that throws inside `transform` returns a structured `error` (message surfaced, no host crash).
- **dynamic-workers-demo.AC1.5 Failure:** A target URL that fails to fetch (DNS/timeout/non-200) returns a clear fetch error without invoking the loader pointlessly.
- **dynamic-workers-demo.AC1.6 Edge:** A target response over the size cap is truncated and `input.truncated` is true.

### dynamic-workers-demo.AC5: The platform contains hostile code without affecting the host
- **dynamic-workers-demo.AC5.2 Success:** `blocked-fetch` (a `fetch()` call) is blocked by `globalOutbound: null` and returns a friendly network-blocked error.
- **dynamic-workers-demo.AC5.3 Failure:** Loaded code cannot reach host secrets or bindings not placed in its `env`.

---

<!-- START_TASK_1 -->
### Task 1: Configure the Worker Loader binding (infrastructure)

**Verifies:** None (infrastructure/setup).

**Files:**
- Modify: `wrangler.jsonc` (add a `worker_loaders` array; keep existing keys)

**Step 1: Add the binding**

Inside the top-level JSON object in `wrangler.jsonc`, add (after `compatibility_flags`):

```jsonc
"worker_loaders": [
  { "binding": "LOADER" }
],
```

Keep `observability.enabled`, `upload_source_maps`, `compatibility_flags: ["nodejs_compat"]`, and compat date `2026-06-22` unchanged.

**Step 2: Regenerate types and verify**

Run: `npm run cf-typegen`
Expected: completes without error; `worker-configuration.d.ts` / the `Env` interface now includes `LOADER`.

Run: `npx tsc --noEmit`
Expected: no type errors.

**Step 3: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "chore: add Worker Loader (LOADER) binding"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->

<!-- START_TASK_2 -->
### Task 2: Functional-core types and helpers (`src/runtime/types.ts`, `src/runtime/core.ts`)

**Verifies:** dynamic-workers-demo.AC1.3 (run-result shape), dynamic-workers-demo.AC1.6 (truncation shape) — exercised via core helpers; full behavior verified in Task 5/6.

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/core.ts`
- Test: `test/runtime/core.spec.ts` (unit)

**Implementation:**

`src/runtime/types.ts` — shared contracts (types only; the TS compiler verifies these, no runtime tests needed for the types themselves):

```ts
/** Pre-fetched page snapshot handed to untrusted code via env.INPUT. */
export type RunInput = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
};

/** Structured result returned by the harness over RPC. */
export type RunResult =
  | { ok: true; value: unknown }
  | { ok: false; error: RunError };

export type RunErrorKind =
  | "transform_threw"
  | "network_blocked"
  | "cpu_exceeded"
  | "loader_failed"
  | "no_transform";

export type RunError = {
  kind: RunErrorKind;
  message: string;
};

/** Host fetch outcome before loader invocation. */
export type FetchOutcome =
  | { ok: true; input: RunInput }
  | { ok: false; error: { kind: "fetch_failed"; message: string } };
```

`src/runtime/core.ts` — pure helpers (functional core, no I/O):

- `hashCode(code: string): Promise<string>` — SHA-256 hex of the code string via `crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))`, used as the loader cache id. Identical code → identical hash. (Async but side-effect-free.)
- `truncateBody(body: string, maxBytes: number): { body: string; truncated: boolean }` — measure UTF-8 byte length; if over `maxBytes`, cut to a safe character boundary under the cap and set `truncated: true`. Otherwise return unchanged with `truncated: false`.
- `classifyTransformError(message: string): RunErrorKind` — pure mapper: if the message matches a blocked-network signature (e.g. contains `"disallowed"`, `"not allowed"`, or `"globalOutbound"` / network-blocked phrasing), return `"network_blocked"`; otherwise `"transform_threw"`. (The exact thrown text is confirmed at runtime in Task 6's test; keep the matched substrings adjustable.)

**Testing:** Tests must verify:
- `hashCode` is deterministic (same input → same output) and differs for different inputs (dynamic-workers-demo.AC1.3 cache-key requirement).
- `truncateBody` returns `truncated: false` and identical body when under cap; `truncated: true` and a shorter body when over cap, never exceeding `maxBytes` UTF-8 bytes (dynamic-workers-demo.AC1.6).
- `classifyTransformError` maps a network-blocked-style message to `"network_blocked"` and an arbitrary error to `"transform_threw"`.

Follow TDD: write `test/runtime/core.spec.ts` first, watch it fail, implement minimally.

**Verification:**
Run: `npm test -- core`
Expected: all core tests pass.

**Commit:** `feat: add runtime core types and pure helpers`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Harness module (`src/runtime/harness.ts`)

**Verifies:** dynamic-workers-demo.AC1.1, dynamic-workers-demo.AC1.3, dynamic-workers-demo.AC1.4 (proven end-to-end in Task 5/6).

**Files:**
- Create: `src/runtime/harness.ts`
- Test: covered via the integration test in Task 6 (the harness only runs meaningfully inside a loaded worker, so it is verified through the loader, not in isolation).

**Implementation:**

The harness is the `mainModule` of every loaded worker. It is a default-exported `WorkerEntrypoint` whose `run()` method:
1. Reads `this.env.INPUT` (the `RunInput`).
2. Imports the user/example module that is supplied as a sibling module in the loaded worker's `modules` map under a fixed name (see Task 4 for the exact module name and specifier). The user module default-exports `transform(input)`.
3. If there is no callable default export, returns `{ ok: false, error: { kind: "no_transform", message } }`.
4. Calls `transform(this.env.INPUT)`, `await`-ing the result (support sync or async transforms).
5. On success returns `{ ok: true, value }`.
6. On throw, returns `{ ok: false, error: { kind: classifyTransformError(message), message } }` using the pure mapper from `core.ts`. This converts a `fetch()` blocked by `globalOutbound: null` into `kind: "network_blocked"` and any other throw into `"transform_threw"`. The harness never rethrows — the host must always get a structured value.

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import type { RunInput, RunResult } from "./types";
import { classifyTransformError } from "./core";
// The user/example module is provided in the loaded worker's `modules` map.
// See Task 4 for the exact module key and why this specifier is used.
import userModule from "./user.js";

export default class Harness extends WorkerEntrypoint {
  async run(): Promise<RunResult> {
    const input = (this.env as { INPUT: RunInput }).INPUT;
    const transform = (userModule as { default?: unknown })?.default ?? userModule;
    if (typeof transform !== "function") {
      return { ok: false, error: { kind: "no_transform", message: "Module does not export a transform function" } };
    }
    try {
      const value = await (transform as (i: RunInput) => unknown)(input);
      return { ok: true, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: classifyTransformError(message), message } };
    }
  }
}
```

> Note for implementor: the import specifier (`"./user.js"`) and the default-export unwrapping must agree with how the loader names the user module in Task 4. The Task 6 integration test is the source of truth — if inter-module resolution rejects the specifier, adjust the module key in Task 4 and the specifier here together until the test passes. Do NOT leave it unverified.

**Verification:** Type-checks (`npx tsc --noEmit`) and is exercised by Task 6's integration test.

**Commit:** `feat: add dynamic-worker harness entrypoint`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Loader wrapper (`src/runtime/loader.ts`)

**Verifies:** dynamic-workers-demo.AC1.1, dynamic-workers-demo.AC1.3, dynamic-workers-demo.AC5.2, dynamic-workers-demo.AC5.3 (proven in Task 6).

**Files:**
- Create: `src/runtime/loader.ts`
- Create: `src/runtime/harness-source.ts` (the harness as a build-independent module string — see implementation)
- Test: covered by Task 6 integration test.

**Implementation:**

`loader.ts` exposes `runInLoader(env, input, code): Promise<RunResult>` (the imperative shell around `env.LOADER`). It:
1. Computes `const id = await hashCode(code)` (from `core.ts`) so identical code reuses a warm isolate.
2. Calls `env.LOADER.get(id, () => ({ ... }))` with a WorkerCode object:
   - `compatibilityDate: "2026-06-22"` (match the host's compat date),
   - `compatibilityFlags: ["nodejs_compat"]`,
   - `mainModule: "harness.js"`,
   - `modules: { "harness.js": HARNESS_SOURCE, "user.js": code }` (module names must match the harness import specifier from Task 3),
   - `env: { INPUT: input }` (structured-clonable only — NO host bindings or secrets, satisfying dynamic-workers-demo.AC5.3),
   - `globalOutbound: null` (blocks outbound fetch → dynamic-workers-demo.AC5.2),
   - (CPU `limits` added in Phase 2; omit here or set a generous default).
3. Wraps `await worker.getEntrypoint().run()` in try/catch. A throw here (e.g. loader-level failure) maps to `{ ok: false, error: { kind: "loader_failed", message } }`. The harness already converts transform throws into structured results, so this catch handles only loader/RPC-level failures.

`harness-source.ts` exports `HARNESS_SOURCE` — the harness module as a string that the loaded worker compiles. Because the harness imports `./core` and `cloudflare:workers`, the simplest robust approach for v1 is a **self-contained** harness string that inlines `classifyTransformError` and imports only `cloudflare:workers` (available in the loaded isolate) plus the user module. Write `HARNESS_SOURCE` as a template string default-exporting the `Harness` class equivalent to Task 3, importing `./user.js`. This avoids a build step in Phase 1 (esbuild bundling arrives in Phase 3). Keep the inlined `classifyTransformError` logic identical to `core.ts` (the core unit test in Task 2 covers the canonical version).

> Implementor: `cloudflare:workers` is available inside the loaded isolate, so `import { WorkerEntrypoint } from "cloudflare:workers"` works in `HARNESS_SOURCE`. Verify with the Task 6 test.

**Verification:** Type-checks; behavior proven in Task 6.

**Commit:** `feat: add loader wrapper that runs code in a sandboxed dynamic worker`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Host fetch + `POST /api/run` route (`src/runtime/fetch-target.ts`, `src/index.ts`)

**Verifies:** dynamic-workers-demo.AC1.1, dynamic-workers-demo.AC1.2, dynamic-workers-demo.AC1.5, dynamic-workers-demo.AC1.6.

**Files:**
- Create: `src/runtime/fetch-target.ts`
- Modify: `src/index.ts` (replace the Hello World handler)
- Test: `test/runtime/fetch-target.spec.ts` (unit), and `test/index.spec.ts` (replace scaffold tests; integration via `SELF`)

**Implementation:**

`fetch-target.ts` — `fetchTarget(url, opts): Promise<FetchOutcome>` (imperative shell):
- Validate `url` is a parseable absolute `http(s)` URL; if not, return `{ ok: false, error: { kind: "fetch_failed", message } }`.
- Fetch with an `AbortController` time cap (e.g. `timeoutMs = 8000`) and a body **size cap** (e.g. `maxBytes = 256 * 1024`). Read the response as text, then apply `truncateBody` from `core.ts`.
- On network failure, timeout, or `!response.ok` (non-2xx), return `{ ok: false, error: { kind: "fetch_failed", message } }` (dynamic-workers-demo.AC1.5) — the caller must NOT invoke the loader in this case.
- On success, return `{ ok: true, input: { url, finalUrl: response.url, status, contentType, body, truncated } }` (dynamic-workers-demo.AC1.2, dynamic-workers-demo.AC1.6).

`src/index.ts` — module Worker (`satisfies ExportedHandler<Env>`) routing `POST /api/run`:
- Parse JSON body `{ customCode: string, url: string }`. Reject non-POST / wrong path with 404/405; reject malformed body with 400.
- Call `fetchTarget(url)`. If `!outcome.ok`, respond `200` with `{ ok: false, error }` (clear fetch error; loader NOT invoked — dynamic-workers-demo.AC1.5).
- Otherwise call `runInLoader(env, outcome.input, customCode)` and respond with `{ ok, result|error, timingMs }` as JSON. (`logs`, Turnstile, rate-limit added later.)
- Keep responses `application/json`. Capture `timingMs` around the loader call.

**Testing:** Tests must verify:
- dynamic-workers-demo.AC1.1: POST with a trivial `transform` (e.g. `export default (i) => i.status`) + a URL served by a test fetch mock/stub returns that value.
- dynamic-workers-demo.AC1.2: the value reflects `input.url/finalUrl/status/contentType/body` (e.g. a transform returning `input.contentType`).
- dynamic-workers-demo.AC1.5: a URL that fails (unreachable/non-200) yields `{ ok: false, error.kind: "fetch_failed" }` and does NOT run the loader.
- dynamic-workers-demo.AC1.6: a response larger than the size cap yields `input.truncated === true` (assert via a transform returning `input.truncated`).

For target-fetch tests, follow the project's vitest-pool-workers patterns. Per `@cloudflare/vitest-pool-workers`, intercept outbound fetch with the documented mock/fetch-stub mechanism rather than hitting the network; if a clean intercept is not available, point at a small in-test Worker/route. Decide the exact approach when writing the test (the integration test in Task 6 also covers the happy path through `SELF`).

**Verification:**
Run: `npm test`
Expected: fetch-target + route tests pass.

**Commit:** `feat: add host target fetch and POST /api/run route`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: End-to-end loader integration tests

**Verifies:** dynamic-workers-demo.AC1.1, dynamic-workers-demo.AC1.3, dynamic-workers-demo.AC1.4, dynamic-workers-demo.AC5.2, dynamic-workers-demo.AC5.3.

**Files:**
- Test: `test/runtime/loader.spec.ts` (integration, runs in Workers runtime so `env.LOADER` is real)

**Implementation:** No new source; this task proves the subcomponent works and pins down the harness↔user module wiring.

**Testing:** Tests must verify (calling `runInLoader` directly with a synthetic `RunInput`):
- dynamic-workers-demo.AC1.1 / dynamic-workers-demo.AC1.3: `transform` returning an object/array/string round-trips unchanged in `result.value` over RPC.
- dynamic-workers-demo.AC1.4: a `transform` that `throw`s returns `{ ok: false, error.kind: "transform_threw" }` with the thrown message surfaced, and the host test process keeps running (no crash).
- dynamic-workers-demo.AC5.2: a `transform` calling `fetch("https://example.com")` returns `{ ok: false, error.kind: "network_blocked" }` (blocked by `globalOutbound: null`). **Capture the actual thrown message here and ensure `classifyTransformError` (Task 2) matches it; adjust the matched substrings if needed.**
- dynamic-workers-demo.AC5.3: a `transform` that tries to read a host secret/binding (e.g. references `globalThis`/`env` names that exist on the host) cannot see them — assert it returns `undefined`/throws, proving only `INPUT` is in the loaded `env`.
- **Classifier parity (anti-drift):** the loaded worker runs the *inlined* `classifyTransformError` in `HARNESS_SOURCE` (Task 4), while `core.ts` holds the unit-tested canonical copy (Task 2). Assert they agree end-to-end: the blocked-`fetch` run (above) must yield `kind: "network_blocked"` and a throwing-`transform` run must yield `kind: "transform_threw"` — i.e. the inlined classifier produces the same kinds the `core.ts` unit tests assert. If they diverge, the inlined copy has drifted from `core.ts`; reconcile them. (This guards the known duplication until Phase 3's esbuild step can bundle the harness from a single source.)

Use this task to finalize the Task 3/Task 4 module-name + import-specifier agreement: if the integration test fails on module resolution, fix the `modules` keys and the harness import together until green.

**Verification:**
Run: `npm test`
Expected: all Phase 1 tests pass (`core`, `fetch-target`, route, `loader`).

**Commit:** `test: end-to-end loader + harness integration coverage`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_B -->

---

## Phase 1 Done When
- A request with trivial `transform` code returns its value (dynamic-workers-demo.AC1.1–AC1.3).
- A `transform` that calls `fetch()` returns a friendly network-blocked error (dynamic-workers-demo.AC5.2).
- A throwing `transform` returns a structured error without crashing the host (dynamic-workers-demo.AC1.4).
- A failed target fetch returns a clear error without invoking the loader (dynamic-workers-demo.AC1.5).
- Oversize responses set `input.truncated` (dynamic-workers-demo.AC1.6).
- Loaded code cannot see host secrets/bindings (dynamic-workers-demo.AC5.3).
- `npm test` is green; `npx tsc --noEmit` is clean.
