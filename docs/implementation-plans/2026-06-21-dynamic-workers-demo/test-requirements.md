# Test Requirements — Dynamic Workers Demo

Maps every acceptance criterion from
`docs/design-plans/2026-06-21-dynamic-workers-demo.md` to an automated test or a
human/deploy verification. Generated during planning; **executors update this file** as
tests land (record the real test file/name once written). Consumed by the `test-analyst`
step after the final code review.

Test types: **unit** (pure functions, Workers pool, no DOM), **integration** (real
`env.LOADER`/DO/runtime via `@cloudflare/vitest-pool-workers`), **human/deploy** (cannot be
asserted in local vitest — see `README.md`).

---

## AC1 — Untrusted code runs against a URL through the loader (Phase 1)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC1.1 | integration | `test/index.spec.ts` / `test/runtime/loader.spec.ts` | POST `/api/run` with trivial `transform` + URL returns the function's value |
| AC1.2 | integration | `test/runtime/fetch-target.spec.ts` + route test | `input` exposes `{ url, finalUrl, status, contentType, body }` from the host fetch |
| AC1.3 | integration | `test/runtime/loader.spec.ts` | object/array/string return value round-trips over RPC unchanged |
| AC1.4 | integration | `test/runtime/loader.spec.ts` | throwing `transform` → structured `error` (`transform_threw`), no host crash |
| AC1.5 | unit + integration | `test/runtime/fetch-target.spec.ts` | failed/non-200 target fetch → clear `fetch_failed` error, loader NOT invoked |
| AC1.6 | unit + integration | `test/runtime/core.spec.ts` (`truncateBody`) + route test | over-cap response truncated, `input.truncated === true` |

Supporting unit tests: `hashCode` determinism, `truncateBody`, `classifyTransformError` (`test/runtime/core.spec.ts`).

## AC2 — Curated content-transform examples (Phase 3)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC2.1 | integration | `test/examples/examples.spec.ts` | `markdown` (defuddle + linkedom, bundled via esbuild `platform:browser`) runs inside the workerd Dynamic Worker isolate and returns non-empty markdown for an article fixture. Verified locally through `runInLoader`; the transform's try/catch also keeps it total on unsuitable input (AC2.5). |
| AC2.2 | unit + integration | `test/examples/parse.spec.ts`, `test/examples/examples.spec.ts` | `opengraph` returns OG tags found in the document |
| AC2.3 | unit + integration | `test/examples/parse.spec.ts`, `examples.spec.ts` | `reddit` returns top comments parsed from a `.json` fixture |
| AC2.4 | unit + integration | `test/examples/parse.spec.ts`, `examples.spec.ts` | `hackernews` returns top comments from an Algolia-item fixture |
| AC2.5 | unit + integration | `parse.spec.ts`, `examples.spec.ts` | unsuitable input → empty/structured result, `ok:true`, no crash |
| AC2.6 | unit | `test/examples/manifest.spec.ts` | `npm run build` regenerates manifest; `markdown.code.length > source.length` (deps inlined) |

## AC3 — Logs captured and forwarded, byte-capped (Phase 4)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC3.1 | integration **+ deploy** | `test/runtime/logs.spec.ts`; **deploy** if local tail delivery is unreliable | N `console.log` calls → N lines in response |
| AC3.2 | integration **+ deploy** | `test/runtime/logs.spec.ts` | thrown exception appears in returned logs |
| AC3.3 | unit + integration | `test/runtime/log-cap.spec.ts`, `logs.spec.ts` | output beyond cap truncated, `logsTruncated` set |
| AC3.4 | unit + integration | `log-cap.spec.ts`, `log-session.spec.ts`, `logs.spec.ts` | no-log run → empty list, not an error |

Supporting: `LogSession` DO behavior (`test/runtime/log-session.spec.ts`).

## AC4 — Embeddable widget (Phase 5)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC4.1 | unit + human | `test/frontend/render.spec.ts` (`exampleOptions`) + manual | dropdown populated; selecting shows code + suggested URLs |
| AC4.2 | human | manual (`npm run dev`) | run a suggested URL or an arbitrary URL for any example |
| AC4.3 | human | manual | switch to custom code, edit (highlighted), run |
| AC4.4 | unit + human | `render.spec.ts` (`formatRunResponse`) + manual | results pane shows return value, logs, errors, timing |
| AC4.5 | human | load `public/embed-example.html` | widget renders correctly inside an `<iframe>` |

## AC5 — Platform contains hostile code (Phases 1–2)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC5.1 | unit **+ deploy** | `test/runtime/core.spec.ts` (`classifyLoaderError`) + `safety.spec.ts` (responsiveness); **deploy**: run `cpu-spin`, sub-second `cpu_exceeded`, concurrent host request succeeds | `while(true)` killed by CPU limit; host stays responsive |
| AC5.2 | integration | `test/runtime/loader.spec.ts`, `test/runtime/safety.spec.ts` | `fetch()` blocked by `globalOutbound: null` → `network_blocked` |
| AC5.3 | integration | `test/runtime/loader.spec.ts` | loaded code cannot reach host secrets/bindings not in its `env` |

## AC6 — Output safety + endpoint protection (Phases 5–6)

| AC | Type | Test location | What it verifies |
|----|------|---------------|------------------|
| AC6.1 | unit **+ human** | `test/frontend/render.spec.ts` (`escapeHtml`) + manual iframe check | HTML/`<script>` in output rendered inert (escaped), not executed |
| AC6.2 | unit + integration **+ deploy** | `test/runtime/turnstile.spec.ts`, `test/runtime/abuse.spec.ts`; **deploy** with real keys | missing/invalid Turnstile token → 403, loader NOT invoked |
| AC6.3 | integration | `test/runtime/abuse.spec.ts` | exceeding per-IP limit → 429 clear message, loader NOT invoked |

---

## Human / deploy verification checklist (see README.md)

- [ ] **AC5.1** — deploy; run `cpu-spin`; observe sub-second `cpu_exceeded`; concurrent request to host succeeds.
- [ ] **AC3.1/AC3.2/AC3.3** — deploy (if needed); confirm log lines + exception in `/api/run` response; over-cap sets `logsTruncated`.
- [ ] **AC2.1 (optional smoke-test)** — `markdown` is verified locally in-isolate via `test/examples/examples.spec.ts`; optionally smoke-test it against a real article URL on the deployed instance.
- [ ] **AC4.1–AC4.4** — `npm run dev`; dropdown populated; example code + chips show; run suggested + custom URL; switch to custom code, edit, run; results show value/logs/errors/timing.
- [ ] **AC4.5** — load `public/embed-example.html`; widget renders inside the iframe.
- [ ] **AC6.1** — run something returning `<script>…</script>`; confirm escaped text displayed, no alert.
- [ ] **AC6.2** — with production Turnstile keys, a run without solving the challenge is rejected (403); loader not invoked.

## Coverage summary

All 30 acceptance criteria (AC1.1–AC6.3) map to at least one automated test; criteria
that local vitest cannot fully enforce additionally carry a deploy/human step above. No AC
is left unverified.
