# Dynamic Workers Demo — Phase 5: Embeddable Widget UI

**Goal:** The iframe widget — pick an example or write code, run a URL, see escaped results.

**Architecture:** A vanilla TypeScript single-page app in `frontend/`, bundled by esbuild into `public/app.js`, with a hand-written `public/index.html`. Served by the host Worker via the static-assets binding; `/api/*` requests run the Worker first. All dynamic values (return value, logs, errors, fetched content) are rendered with `textContent`/escaping — never `innerHTML` — so hostile HTML/script in output is inert. Pure UI helpers (escaping, result formatting, option building) live in a testable module; DOM wiring is thin.

**Tech Stack:** Vanilla TS + esbuild (bundle), Prism.js (read-only highlight) + CodeJar (editable highlighted editor) — both tiny, esbuild-friendly. Workers static assets binding.

**Scope:** Phase 5 of 6. **Depends on:** Phases 3 (`/api/examples`) and 4 (`logs` in `/api/run` response).

**Codebase verified:** 2026-06-21. After Phases 1–4: full backend with `/api/run` (returns `{ ok, result|error, logs, logsTruncated, timingMs }`) and `/api/examples`. `wrangler.jsonc` has `worker_loaders` + `durable_objects`; `assets` is commented out. No `public/` or `frontend/` dirs. Build script bundles examples only.

**Key API facts (verified 2026-06-21):**
- Static assets wrangler config: `"assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/api/*"] }`. Static assets are served first by default; `run_worker_first: ["/api/*"]` routes API paths to the Worker. (`run_worker_first` arrays need Wrangler ≥ v4.20; installed is ^4.103 — OK.)
- esbuild can bundle the frontend: `esbuild.build({ entryPoints: ["frontend/main.ts"], bundle: true, format: "iife", outfile: "public/app.js", minify: true, target: "es2022" })`.

**Skills to apply:** `ed3d-house-style:howto-code-in-typescript`, `ed3d-house-style:howto-functional-vs-imperative`, `ed3d-plan-and-execute:writing-good-tests`, `ed3d-house-style:writing-for-a-technical-audience` (UI copy). Run `npm run cf-typegen` after adding the `assets` binding.

---

## Acceptance Criteria Coverage

### dynamic-workers-demo.AC4: The embeddable widget lets a visitor run examples and custom code
- **dynamic-workers-demo.AC4.1 Success:** The example dropdown is populated and selecting one shows its code and suggested URLs.
- **dynamic-workers-demo.AC4.2 Success:** A visitor can run a suggested URL or enter an arbitrary URL for any example.
- **dynamic-workers-demo.AC4.3 Success:** A visitor can switch to custom code, edit it (syntax-highlighted), and run it.
- **dynamic-workers-demo.AC4.4 Success:** The results pane shows return value, logs, errors, and timing for a run.
- **dynamic-workers-demo.AC4.5 Edge:** The widget renders correctly when embedded via `<iframe>`.

### dynamic-workers-demo.AC6 (partial)
- **dynamic-workers-demo.AC6.1 Success:** Run output/fetched content containing HTML or `<script>` is rendered inert (escaped), not executed.

---

<!-- START_TASK_1 -->
### Task 1: Configure the assets binding + deps (infrastructure)

**Verifies:** None (setup).

**Files:**
- Modify: `wrangler.jsonc` (add `assets`)
- Modify: `package.json` (add frontend deps; extend build)
- Create: `public/.gitkeep` (ensure dir exists for wrangler)

**Step 1: Add assets binding**

Add to `wrangler.jsonc`:
```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "run_worker_first": ["/api/*"]
},
```

**Step 2: Install frontend deps**

Run: `npm install prismjs codejar` and `npm install --save-dev @types/prismjs`

**Step 3: Verify**

Run: `npm run cf-typegen && npx tsc --noEmit`
Expected: `Env` includes `ASSETS`; no type errors.

**Step 4: Commit**

```bash
git add wrangler.jsonc package.json package-lock.json public/.gitkeep
git commit -m "chore: add static assets binding and frontend deps"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Pure UI helpers (`frontend/lib/render.ts`)

**Verifies:** dynamic-workers-demo.AC4.4 (result formatting), dynamic-workers-demo.AC6.1 (escaping).

**Files:**
- Create: `frontend/lib/render.ts`
- Test: `test/frontend/render.spec.ts` (unit — pure functions, run in the existing vitest workers pool; no DOM needed)

**Implementation:** Pure, DOM-free functions:
- `escapeHtml(s: string): string` — replace `& < > " '` with entities. (Belt-and-suspenders alongside `textContent` use in Task 4.)
- `formatResultValue(value: unknown): string` — `JSON.stringify(value, null, 2)` with a fallback for non-serializable values.
- `formatRunResponse(resp): { title: string; body: string; tone: "ok" | "error" }` — given the `/api/run` JSON, produce display strings for the return value or the error (kind + message). Pure mapping only.
- `exampleOptions(examples): Array<{ id: string; title: string }>` — map `/api/examples` metadata to dropdown options.

**Testing:** Verify:
- dynamic-workers-demo.AC6.1: `escapeHtml("<script>alert(1)</script>")` contains no raw `<script>`; angle brackets/quotes are entity-encoded.
- dynamic-workers-demo.AC4.4: `formatRunResponse` for an `ok` response yields the formatted value + `tone: "ok"`; for an `error` response yields kind+message + `tone: "error"`.
- `formatResultValue` round-trips objects/arrays/strings to readable JSON.

**Verification:**
Run: `npm test -- render`
Expected: pass.

**Commit:** `feat: pure UI render/escape helpers`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Bundle the frontend (extend `scripts/build-examples.mjs` or add `scripts/build-frontend.mjs`)

**Verifies:** None directly (build infra supporting dynamic-workers-demo.AC4.*).

**Files:**
- Modify: `scripts/build-examples.mjs` (or create `scripts/build-frontend.mjs` and call both from `npm run build`)
- Modify: `package.json` `build` script if a second script is added

**Implementation:** Add an esbuild step that bundles `frontend/main.ts` (created in Task 4) → `public/app.js` (`bundle: true, format: "iife", minify: true, target: "es2022"`). Keep example-manifest generation working. Ensure `npm run build` runs both example bundling and frontend bundling.

**Verification:**
Run: `npm run build`
Expected: `public/app.js` produced; `manifest.generated.ts` still regenerated. (Add `public/app.js` to `.gitignore` OR commit it — choose: committing keeps deploys simple; gitignore keeps the tree clean and relies on a build step before deploy. Recommend committing the built `public/app.js` so `wrangler deploy` works without a pre-step, and document it as generated.)

**Commit:** `feat: bundle frontend to public/app.js`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: The widget (`public/index.html`, `frontend/main.ts`)

**Verifies:** dynamic-workers-demo.AC4.1, dynamic-workers-demo.AC4.2, dynamic-workers-demo.AC4.3, dynamic-workers-demo.AC4.4, dynamic-workers-demo.AC6.1.

**Files:**
- Create: `public/index.html`
- Create: `frontend/main.ts`
- Create: `frontend/styles.css` (or inline `<style>` in index.html)

**Implementation:**

`public/index.html` — minimal, iframe-friendly document: a `<select id="example">`, suggested-URL chips + a free `<input id="url">`, an editable code area (a `<div id="editor">` wired to CodeJar, or a `<textarea>` fallback), a "Custom code" toggle, a "Run" button, and a `<section id="results">` with sub-areas for return value, logs (a `<pre>`), error, and timing. Loads `app.js` and Prism CSS. Responsive, no fixed width (renders inside an iframe — dynamic-workers-demo.AC4.5).

`frontend/main.ts` — wiring (imperative shell):
- On load, `fetch("/api/examples")`, populate the dropdown via `exampleOptions` (dynamic-workers-demo.AC4.1).
- On example select: show its `source` in the editor (Prism/CodeJar highlight) and render its `suggestedUrls` as clickable chips that fill the URL input (dynamic-workers-demo.AC4.1, dynamic-workers-demo.AC4.2).
- "Custom code" toggle: make the editor editable via CodeJar with a Prism highlight callback (dynamic-workers-demo.AC4.3); in custom mode the run sends `customCode`, otherwise `exampleId`.
- Run button: POST `/api/run` with `{ exampleId|customCode, url }`; on response, render return value, logs (each line), error, and `timingMs` into the results pane using `textContent`/`escapeHtml` ONLY — never `innerHTML` with response data (dynamic-workers-demo.AC4.4, dynamic-workers-demo.AC6.1). Use `formatRunResponse`/`formatResultValue` from Task 2. Show a "logs truncated" notice when `logsTruncated`.
- Disable Run while a request is in flight; surface fetch/HTTP errors in the error area.

> CodeJar + Prism specifics: CodeJar(`editorEl`, (el) => { el.innerHTML = Prism.highlight(el.textContent, Prism.languages.javascript, "javascript"); }). Prism's highlight operates on the editor's own code text (trusted user input shown back to them), NOT on run output — run output never uses innerHTML. If CodeJar integration proves fiddly, fall back to a `<textarea>` editor + a Prism-highlighted read-only `<pre>` preview; AC4.3 only requires editable + highlighted.

**Verification:**
Run: `npm run build` then `npm run dev`; load `http://localhost:8787/`. Manually confirm: dropdown populated, selecting an example shows code + chips, entering a URL and running shows results + logs + timing, switching to custom code lets you edit and run. (These interactive checks are recorded as human-verified in `test-requirements.md`.)

**Commit:** `feat: embeddable widget UI`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Serve + iframe-embed verification

**Verifies:** dynamic-workers-demo.AC4.5, dynamic-workers-demo.AC6.1 (served behavior).

**Files:**
- Test: `test/index.spec.ts` (extend — assert the host serves the SPA and security headers)
- Optional: `public/embed-example.html` (a tiny page that embeds the widget via `<iframe src="/">` for manual verification)

**Implementation:**
- Ensure the Worker does not intercept `/` (static asset serves `index.html`); only `/api/*` runs the Worker (`run_worker_first`). Confirm `/api/examples` and `/api/run` still work with assets enabled.
- Do NOT set `X-Frame-Options: DENY` / a frame-blocking CSP on the asset responses, so the widget can be embedded (dynamic-workers-demo.AC4.5). If adding CSP, use `frame-ancestors` permissively for the demo.

**Testing:** Integration (via `SELF.fetch`):
- `GET /` returns HTML (the widget) — assets served.
- `GET /api/examples` still returns the manifest with assets enabled (routing correct).
- A `/api/run` whose result/body contains `<script>` returns it as data; assert the SPA path escapes it (covered by Task 2 unit test; here assert the API returns the raw string unmodified so the client is responsible for escaping — documenting the trust boundary).

> dynamic-workers-demo.AC4.5 (renders correctly in an iframe) and the visual "inert rendering" of dynamic-workers-demo.AC6.1 are inherently browser behaviors → record as human-verified steps in `test-requirements.md` (load `embed-example.html`, confirm the widget renders and that a run returning `<script>` shows escaped text, no alert).

**Verification:**
Run: `npm test`
Expected: pass.

**Commit:** `test: assets routing and iframe-embed coverage`
<!-- END_TASK_5 -->

---

## Phase 5 Done When
- From the rendered widget a visitor selects an example, runs a suggested and a custom URL, switches to custom code, and sees return value + logs + errors + timing (dynamic-workers-demo.AC4.1–AC4.4).
- The widget renders inside an `<iframe>` (dynamic-workers-demo.AC4.5, human-verified).
- Output containing HTML/script is shown inert/escaped (dynamic-workers-demo.AC6.1 — escaping unit-tested, inert rendering human-verified).
- `npm test` green; `npm run build` produces `public/app.js`; `npx tsc --noEmit` clean.
