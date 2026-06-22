# Dynamic Workers Demo — Phase 4: Log Capture + Real-Time Forwarding

**Goal:** Surface a run's `console.log` output and exceptions in the response, byte-capped.

**Architecture:** Attach a `LogTailer` (`WorkerEntrypoint`) to each loaded worker via the `tails` array, referenced through `ctx.exports`. Because tails run **after** the loaded worker finishes (and after `run()` resolves), the captured events can't be returned inline — they rendezvous through a `LogSession` Durable Object keyed by `runId`. The host registers nothing up front beyond passing `runId`; after the loader call it reads logs back from the DO with a short timeout. The DO enforces byte/line caps on write and sets a `truncated` flag.

**Tech Stack:** Cloudflare Durable Objects (SQLite-backed, RPC methods), tail Workers, `ctx.exports`, `cloudflare:workers` `WorkerEntrypoint` + `DurableObject`.

**Scope:** Phase 4 of 6. **Depends on:** Phases 1–3.

**Codebase verified:** 2026-06-21. After Phases 1–3: full `src/runtime/*`, `src/examples/*`, manifest, `/api/run` + `/api/examples`. `wrangler.jsonc` has `worker_loaders` but no `durable_objects`/`migrations`. No `LogSession`/`LogTailer` yet.

**Key API facts (verified 2026-06-21 from dynamic-workers observability docs):**
- Tail attach: `tails: [ ctx.exports.LogTailer({ props: { runId } }) ]` inside the WorkerCode. `ctx` is the 3rd param of the host `fetch(request, env, ctx)`.
- `ctx.exports.ClassName({ props })` references a class exported from the host's main module — no separate deploy. The class must be `export`ed from `src/index.ts`.
- Tail class is a `WorkerEntrypoint` implementing `async tail(events)`. Each `event` has `event.logs` (array of `{ level, message }`) plus exceptions and request metadata. Read props via `this.ctx.props`.
- The runtime "collects all of its `console.log()` calls, exceptions, and request metadata."

> Verify-on-implement: the exact field for exceptions on a tail event (commonly `event.exceptions` with `{ name, message }`) and whether `log.message` is a pre-joined string or an array of args. The Task 5 integration test pins these down — adapt the LogTailer mapping to the real shapes rather than guessing blindly.

**Skills to apply:** `cloudflare:durable-objects`, `ed3d-plan-and-execute:test-driven-development`, `ed3d-plan-and-execute:writing-good-tests`, `ed3d-house-style:howto-code-in-typescript`. Run `npm run cf-typegen` after adding the DO binding.

---

## Acceptance Criteria Coverage

### dynamic-workers-demo.AC3: Logs are captured and forwarded, byte-capped
- **dynamic-workers-demo.AC3.1 Success:** A `transform` that calls `console.log` N times yields those N lines in the response.
- **dynamic-workers-demo.AC3.2 Success:** An exception thrown by the loaded worker appears in the returned logs.
- **dynamic-workers-demo.AC3.3 Failure/Edge:** Log output beyond the byte/line cap is truncated and a `truncated` flag is set.
- **dynamic-workers-demo.AC3.4 Edge:** A run that emits no logs returns an empty log list (not an error).

---

<!-- START_TASK_1 -->
### Task 1: Configure the Durable Object binding + migration (infrastructure)

**Verifies:** None (setup).

**Files:**
- Modify: `wrangler.jsonc`

**Step 1: Add DO binding and migration**

Add to the top-level object:
```jsonc
"durable_objects": {
  "bindings": [ { "name": "LOG_SESSION", "class_name": "LogSession" } ]
},
"migrations": [ { "tag": "v1", "new_sqlite_classes": ["LogSession"] } ],
```
(`new_sqlite_classes` is required for SQLite-backed DOs / free-tier compatibility.)

**Step 2: Regenerate types & typecheck**

> **Ordering:** `cf-typegen` needs the `LogSession` class to exist and be exported from `src/index.ts`. To avoid a typegen failure, land the binding (this task), the `LogSession` class (Task 3), and its `export { LogSession } from "./runtime/log-session"` in `src/index.ts` (Task 5 Step 1) **in one change set** — i.e. write a minimal `LogSession` class stub + export first, then run `cf-typegen`. If you prefer the linear order, do Task 3 (class) and add the export before running `cf-typegen` here.

Run: `npm run cf-typegen` then `npx tsc --noEmit`
Expected: `Env` includes `LOG_SESSION`; no type errors.

**Step 3: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "chore: add LogSession durable object binding and migration"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->

<!-- START_TASK_2 -->
### Task 2: Log types + cap logic (`src/runtime/log-types.ts`, `src/runtime/log-cap.ts`)

**Verifies:** dynamic-workers-demo.AC3.3 (cap/truncation logic), dynamic-workers-demo.AC3.4 (empty shape).

**Files:**
- Create: `src/runtime/log-types.ts`
- Create: `src/runtime/log-cap.ts`
- Test: `test/runtime/log-cap.spec.ts` (unit)

**Implementation:**

`log-types.ts`:
```ts
export type LogLine = { level: string; message: string };
export type LogBundle = { lines: LogLine[]; truncated: boolean };
export const LOG_MAX_LINES = 200;
export const LOG_MAX_BYTES = 16 * 1024;
```

`log-cap.ts` — pure `appendWithCap(current: LogBundle, incoming: LogLine[], maxLines, maxBytes): LogBundle`:
- Append incoming lines while total line count ≤ `maxLines` and cumulative UTF-8 byte size (sum of `message` lengths) ≤ `maxBytes`.
- When a cap would be exceeded, stop adding and set `truncated: true`. Never throw.
- An empty `incoming` returns `current` unchanged (supports dynamic-workers-demo.AC3.4).

**Testing:** Verify:
- Under both caps: all lines kept, `truncated: false`.
- Over the line cap: kept count == `maxLines`, `truncated: true`.
- Over the byte cap: cumulative bytes ≤ `maxBytes`, `truncated: true` (dynamic-workers-demo.AC3.3).
- Empty incoming on empty bundle: `{ lines: [], truncated: false }` (dynamic-workers-demo.AC3.4).

**Verification:**
Run: `npm test -- log-cap`
Expected: pass.

**Commit:** `feat: log types and byte/line cap logic`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `LogSession` Durable Object (`src/runtime/log-session.ts`)

**Verifies:** dynamic-workers-demo.AC3.1, dynamic-workers-demo.AC3.3, dynamic-workers-demo.AC3.4 (storage + read-back; full path in Task 5).

**Files:**
- Create: `src/runtime/log-session.ts`
- Test: `test/runtime/log-session.spec.ts` (integration, Workers runtime — DO behaves realistically)

**Implementation:** A `DurableObject` (from `cloudflare:workers`) exposing RPC methods. One instance per `runId` (via `idFromName(runId)`), so per-instance in-memory state holds that run's logs (persist to `ctx.storage` optionally for robustness):
- `append(lines: LogLine[]): void` — fold into the held `LogBundle` via `appendWithCap` (Task 2).
- `getLogs(timeoutMs: number): Promise<LogBundle>` — return the current bundle, but first wait (poll in small intervals up to `timeoutMs`) until at least one `append` has occurred OR the timeout elapses, so a just-finished tail has a chance to deliver. If nothing arrives, return `{ lines: [], truncated: false }` (dynamic-workers-demo.AC3.4). Track an "appended at least once" flag to distinguish "no logs yet" from "genuinely empty."

Keep methods total; cap enforcement lives in `append` via the pure helper.

**Testing:** Drive the DO directly via its namespace stub:
- `append` then `getLogs(short)` returns those lines (dynamic-workers-demo.AC3.1 at DO level).
- Appending beyond caps yields `truncated: true` and bounded output (dynamic-workers-demo.AC3.3).
- `getLogs` with no prior append returns empty bundle after the timeout without error (dynamic-workers-demo.AC3.4).

**Verification:**
Run: `npm test -- log-session`
Expected: pass.

**Commit:** `feat: LogSession durable object for log rendezvous`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: `LogTailer` tail worker (`src/runtime/log-tailer.ts`)

**Verifies:** dynamic-workers-demo.AC3.1, dynamic-workers-demo.AC3.2.

**Files:**
- Create: `src/runtime/log-tailer.ts`
- Test: covered by the end-to-end Task 5 test (the tailer only runs when invoked by the platform as a tail).

**Implementation:** A `WorkerEntrypoint` with `async tail(events)`:
- Read `runId` from `this.ctx.props.runId`.
- Flatten `events` into `LogLine[]`: from each `event.logs` map `{ level, message }` (join message args into a string if `message` is an array); from each exception (verify field name — likely `event.exceptions`) push a line like `{ level: "error", message: name + ": " + message }` (dynamic-workers-demo.AC3.2).
- Get the `LogSession` stub: `this.env.LOG_SESSION.get(this.env.LOG_SESSION.idFromName(runId))` and call `await stub.append(lines)`.

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import type { LogLine } from "./log-types";

export class LogTailer extends WorkerEntrypoint<Env> {
  async tail(events: any[]): Promise<void> {
    const runId = (this.ctx.props as { runId: string }).runId;
    const lines: LogLine[] = [];
    for (const event of events) {
      for (const log of event.logs ?? []) {
        const message = Array.isArray(log.message) ? log.message.map(String).join(" ") : String(log.message);
        lines.push({ level: String(log.level ?? "log"), message });
      }
      for (const ex of event.exceptions ?? []) {
        lines.push({ level: "error", message: `${ex.name ?? "Error"}: ${ex.message ?? ""}` });
      }
    }
    if (lines.length === 0) return;
    const stub = this.env.LOG_SESSION.get(this.env.LOG_SESSION.idFromName(runId));
    await stub.append(lines);
  }
}
```
(Tighten the `any` types once the real event shape is confirmed in Task 5.)

**Verification:** Type-checks; behavior in Task 5.

**Commit:** `feat: LogTailer forwards tail events into LogSession`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Wire tail + logs into the loader and response (`src/runtime/loader.ts`, `src/index.ts`)

**Verifies:** dynamic-workers-demo.AC3.1, dynamic-workers-demo.AC3.2, dynamic-workers-demo.AC3.3, dynamic-workers-demo.AC3.4.

**Files:**
- Modify: `src/runtime/loader.ts` (accept `runId` + `ctx`; add `tails`)
- Modify: `src/index.ts` (generate `runId`, export DO + tailer, read logs, include in response)
- Test: `test/runtime/logs.spec.ts` (integration, Workers runtime)

**Implementation:**
1. `src/index.ts`: `export { LogSession } from "./runtime/log-session";` and `export { LogTailer } from "./runtime/log-tailer";` (required for `ctx.exports` + the DO binding).
2. In the `/api/run` handler, generate `const runId = crypto.randomUUID();` and pass `runId` and the `fetch` handler's `ctx` into `runInLoader`.
3. `runInLoader(env, input, code, runId, ctx)`: add `tails: [ ctx.exports.LogTailer({ props: { runId } }) ]` to the WorkerCode.
4. After `await worker.getEntrypoint().run()`, read logs: `const logs = await env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId)).getLogs(LOG_READ_TIMEOUT_MS)` (e.g. 250–500 ms). Include `logs.lines` + `logs.truncated` in the `/api/run` JSON response: `{ ok, result|error, logs: logs.lines, logsTruncated: logs.truncated, timingMs }`.

**Testing:** Through `SELF.fetch("/api/run", ...)` or `runInLoader`:
- dynamic-workers-demo.AC3.1: custom `transform` that calls `console.log` N times → response `logs` contains those N lines.
- dynamic-workers-demo.AC3.2: a throwing `transform` → its exception appears in `logs` (and `ok:false` error still returned).
- dynamic-workers-demo.AC3.3: a `transform` logging far beyond the caps → `logsTruncated: true` and bounded `logs`.
- dynamic-workers-demo.AC3.4: a silent `transform` → `logs: []`, `logsTruncated: false`, no error.

> Tail delivery is asynchronous; if the integration environment delivers tails unreliably in local vitest, confirm timing and, if needed, document the live-forwarding behavior as a deploy-verified criterion in `test-requirements.md` while keeping the DO + cap logic fully unit/integration tested. Determine actual local behavior when writing the test; do not skip silently.

**Verification:**
Run: `npm test`
Expected: all Phase 4 tests pass.

**Commit:** `feat: forward captured logs into /api/run response`
<!-- END_TASK_5 -->

---

## Phase 4 Done When
- A `transform` that logs N lines yields those lines in the response (dynamic-workers-demo.AC3.1).
- Exceptions appear in logs (dynamic-workers-demo.AC3.2).
- Output beyond the cap is truncated with a flag (dynamic-workers-demo.AC3.3).
- A silent run returns an empty log list, not an error (dynamic-workers-demo.AC3.4).
- `npm test` green; `npx tsc --noEmit` clean.
