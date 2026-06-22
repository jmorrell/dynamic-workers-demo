# Dynamic Workers Demo — Phase 2: Resource Limits + Safety Demos

**Goal:** Prove the platform contains hostile code — CPU spin and blocked fetch — without affecting the host.

**Architecture:** Add an explicit CPU budget to the loader's WorkerCode (`limits: { cpuMs, subRequests }`) so a `while(true)` loop is killed deterministically, and map the limit-exceeded exception to a `cpu_exceeded` error shape. Add two example modules (`cpu-spin`, `blocked-fetch`) that exercise the two containment mechanisms. These examples are plain `transform` modules run through the exact same loader path as user code.

**Tech Stack:** Same as Phase 1. The CPU limit is enforced **only on deployed Cloudflare infrastructure**, not in local `vitest`/`wrangler dev` — see the testing notes below for how this constrains what is unit-tested vs. verified on deploy.

**Scope:** Phase 2 of 6. **Depends on:** Phase 1.

**Codebase verified:** 2026-06-21 (carried from Phase 1). After Phase 1: `src/runtime/loader.ts`, `src/runtime/core.ts`, `src/runtime/types.ts`, `src/runtime/harness.ts`, `src/runtime/harness-source.ts`, `src/index.ts`, `src/runtime/fetch-target.ts` exist. No `src/examples/` dir yet.

**Key API facts (verified 2026-06-21):**
- `limits: { cpuMs?: number, subRequests?: number }` (camelCase) in the WorkerCode object. If the loaded worker exceeds either limit it **immediately throws an exception**; catch it around the `getEntrypoint().run()` RPC.
- The exact exception name/message for CPU-exceeded is **not documented** — the implementor must capture the real thrown error on a deploy/integration check and map it to `cpu_exceeded`. The Worker platform CPU limit max is 300,000 ms; for this demo set a tiny budget (e.g. `cpuMs: 50`) so the spin is killed in well under a second.
- Limits are **not enforced in local dev** (Workers limits are enforced only on Cloudflare's network).

**Skills to apply:** `ed3d-plan-and-execute:test-driven-development`, `ed3d-plan-and-execute:writing-good-tests`, `ed3d-house-style:howto-code-in-typescript`, `ed3d-house-style:howto-functional-vs-imperative`.

---

## Acceptance Criteria Coverage

### dynamic-workers-demo.AC5: The platform contains hostile code without affecting the host
- **dynamic-workers-demo.AC5.1 Success:** `cpu-spin` (`while(true)`) is killed by the CPU limit in well under a second and returns a `cpu_exceeded` error; the host serves a concurrent request normally.
- **dynamic-workers-demo.AC5.2 Success:** `blocked-fetch` (a `fetch()` call) is blocked by `globalOutbound: null` and returns a friendly network-blocked error.

---

<!-- START_TASK_1 -->
### Task 1: Apply CPU/subrequest limits and map the limit-exceeded error (`src/runtime/loader.ts`, `src/runtime/core.ts`)

**Verifies:** dynamic-workers-demo.AC5.1 (error mapping), dynamic-workers-demo.AC5.2 (unchanged from Phase 1).

**Files:**
- Modify: `src/runtime/loader.ts` (add `limits` to the WorkerCode; map limit-exceeded throws)
- Modify: `src/runtime/core.ts` (add a pure `classifyLoaderError` mapper)
- Modify: `src/runtime/types.ts` (if needed — `cpu_exceeded` already exists in `RunErrorKind` from Phase 1)
- Test: `test/runtime/core.spec.ts` (extend, unit)

**Implementation:**

1. In `loader.ts`, add to the WorkerCode object: `limits: { cpuMs: 50, subRequests: 5 }`. Export the chosen `cpuMs` as a named constant (e.g. `export const CPU_LIMIT_MS = 50`) so the UI and tests can reference the cap (caps are first-class per the design).
2. In `core.ts`, add a pure `classifyLoaderError(message: string): RunErrorKind` that returns `"cpu_exceeded"` when the message matches the CPU/limit-exceeded signature (keep matched substrings adjustable — finalized against the real message in Task 4), else `"loader_failed"`.
3. In `loader.ts`, change the try/catch around `getEntrypoint().run()` to build the error via `classifyLoaderError(message)` instead of always `"loader_failed"`.

**Testing:** Extend `core.spec.ts`:
- `classifyLoaderError` maps a CPU-limit-style message to `"cpu_exceeded"` and an unrelated message to `"loader_failed"`.

(The end-to-end kill behavior is verified in Task 4 — and on deploy, since local dev does not enforce limits.)

**Verification:**
Run: `npm test -- core`
Expected: pass.

**Commit:** `feat: apply CPU/subrequest limits and map cpu_exceeded errors`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: `cpu-spin` example module (`src/examples/cpu-spin.ts`)

**Verifies:** dynamic-workers-demo.AC5.1.

**Files:**
- Create: `src/examples/cpu-spin.ts`
- Test: covered by Task 4 integration test.

**Implementation:**

A module that default-exports a `transform` whose body spins the CPU forever:

```ts
import type { RunInput } from "../runtime/types";

export default function transform(_input: RunInput): unknown {
  // Intentionally hostile: a hot loop that never yields. The platform CPU
  // limit (limits.cpuMs) kills this deterministically.
  while (true) {
    // no-op
  }
}
```

(Type-only import of `RunInput`; the function never returns.)

**Verification:** Type-checks. Behavior proven in Task 4.

**Commit:** `feat: add cpu-spin safety-demo example`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `blocked-fetch` example module (`src/examples/blocked-fetch.ts`)

**Verifies:** dynamic-workers-demo.AC5.2.

**Files:**
- Create: `src/examples/blocked-fetch.ts`
- Test: covered by Task 4 integration test.

**Implementation:**

```ts
import type { RunInput } from "../runtime/types";

export default async function transform(input: RunInput): Promise<unknown> {
  // Attempts a network call. globalOutbound: null makes this throw; the
  // harness converts it into a structured network_blocked error.
  const res = await fetch("https://example.com/should-be-blocked");
  return { status: res.status, from: input.url };
}
```

**Verification:** Type-checks. Behavior proven in Task 4.

**Commit:** `feat: add blocked-fetch safety-demo example`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Safety-demo integration tests + host-responsiveness check

**Verifies:** dynamic-workers-demo.AC5.1, dynamic-workers-demo.AC5.2.

**Files:**
- Test: `test/runtime/safety.spec.ts` (integration, Workers runtime)

**Implementation:** No new source. These tests run the two example modules through `runInLoader` and assert containment.

**Testing:** Tests must verify:
- dynamic-workers-demo.AC5.2: running `blocked-fetch`'s code returns `{ ok: false, error.kind: "network_blocked" }`.
- dynamic-workers-demo.AC5.1 (error-mapping + responsiveness): assert the host stays responsive — e.g. issue a concurrent trivial `runInLoader` (or `SELF.fetch` to a simple route) while/after the hostile run and confirm it returns normally. Because the CPU limit is **not enforced in local vitest**, do one of the following and document which:
  - (a) Assert `cpu-spin` mapping logic deterministically via `classifyLoaderError` (unit, Task 1) AND assert host responsiveness with a non-spinning concurrent request; mark the actual kill as a **deploy-verified** criterion in `test-requirements.md` (human/integration step: deploy, run `cpu-spin`, confirm a sub-second `cpu_exceeded` and that a concurrent request to the host succeeds).
  - (b) If the installed `@cloudflare/vitest-pool-workers` / `workerd` build DOES enforce `limits.cpuMs` locally (verify by running a short spin with a tiny `cpuMs`), assert directly that `cpu-spin` returns `{ ok: false, error.kind: "cpu_exceeded" }` in under ~1s and finalize the `classifyLoaderError` substrings against the real thrown message.

  Determine which path applies by running a quick experiment when writing the test; record the outcome in the test and in `test-requirements.md`. Do NOT silently skip the criterion.

**Verification:**
Run: `npm test`
Expected: safety + all prior tests pass.

**Commit:** `test: safety-demo containment and host-responsiveness coverage`
<!-- END_TASK_4 -->

---

## Phase 2 Done When
- `blocked-fetch` returns a network-blocked error (dynamic-workers-demo.AC5.2).
- `cpu-spin` is contained: either asserted directly as `cpu_exceeded` in under a second (if locally enforced) or covered by unit-level error mapping plus a deploy-verified step, with host responsiveness asserted under load (dynamic-workers-demo.AC5.1).
- `npm test` green; `npx tsc --noEmit` clean.
