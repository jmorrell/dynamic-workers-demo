# Dynamic Workers Demo — Phase 3: Example Library + Build-Time Bundling

**Goal:** The curated content-transform examples, bundled at build time and exposed as a manifest.

**Architecture:** Each example is a `transform(input)` module in `src/examples/`. A build script (`scripts/build-examples.mjs`) uses esbuild to bundle each example (inlining npm deps like `defuddle`/`linkedom` for `markdown`) into a self-contained module string, and emits a generated data file plus a typed accessor (`manifest.ts`). The host's `/api/run` resolves `exampleId` → the bundled `code` string and runs it through the same loader path as custom code. `GET /api/examples` exposes example metadata + readable source (not the heavy bundled code) for the widget.

**Tech Stack:** esbuild (build-time bundler, new devDep), `defuddle` + `linkedom` (markdown extraction, new deps), pure-JS parsing for the others. Examples run inside the Dynamic Worker isolate.

**Scope:** Phase 3 of 6. **Depends on:** Phase 1 (loader path, `RunInput`).

**Codebase verified:** 2026-06-21. After Phases 1–2: `src/runtime/*`, `src/examples/cpu-spin.ts`, `src/examples/blocked-fetch.ts`, `src/index.ts` exist. `package.json` has no `esbuild`, `defuddle`, `linkedom`, and no `build` script. `src/examples/manifest*.ts` do not exist.

**Key API facts (verified 2026-06-21):**
- **defuddle (Node bundle):** `import { parseHTML } from "linkedom"; import { Defuddle } from "defuddle/node";` then `const result = await Defuddle(document, url, { markdown: true });`. `result` has `{ content, title, author, wordCount, description, ... }`; with `markdown: true`, `content` is Markdown. `document` comes from `parseHTML(html).document` (or `const { document } = parseHTML(html)`).
- **esbuild programmatic bundle-to-string:** `const out = await esbuild.build({ entryPoints: [file], bundle: true, format: "esm", write: false, platform: "neutral", target: "esnext", conditions: ["worker", "browser"] }); const code = out.outputFiles[0].text;`.
- **Reddit:** the `.json` form of a thread (`https://www.reddit.com/r/<sub>/comments/<id>.json`) returns a 2-element array: `[postListing, commentsListing]`; comments at `data[1].data.children[].data` with `.body`, `.author`, `.score`. Examples parse `input.body` (host already fetched it) — so suggested URLs are the `.json` endpoints.
- **Hacker News:** use the Algolia items API (`https://hn.algolia.com/api/v1/items/<id>`) which returns `{ children: [...] }` recursively with `.text`, `.author`, `.points`. Examples parse `input.body`; suggested URLs are the Algolia item JSON endpoints.

**Skills to apply:** `ed3d-plan-and-execute:test-driven-development`, `ed3d-plan-and-execute:writing-good-tests`, `ed3d-house-style:howto-code-in-typescript`, `ed3d-house-style:howto-functional-vs-imperative`, `ed3d-house-style:defense-in-depth` (transforms must degrade gracefully on unsuitable input — dynamic-workers-demo.AC2.5).

---

## Acceptance Criteria Coverage

### dynamic-workers-demo.AC2: Curated content-transform examples produce expected output
- **dynamic-workers-demo.AC2.1 Success:** `markdown` (defuddle) returns markdown/clean text for an article URL.
- **dynamic-workers-demo.AC2.2 Success:** `opengraph` returns the OpenGraph tags found in the document.
- **dynamic-workers-demo.AC2.3 Success:** `reddit` returns top comments parsed from a thread's `.json`.
- **dynamic-workers-demo.AC2.4 Success:** `hackernews` returns top comments for an HN thread.
- **dynamic-workers-demo.AC2.5 Failure:** An example run against an unsuitable URL (e.g. no OG tags) returns an empty/structured result, not an unhandled crash.
- **dynamic-workers-demo.AC2.6 Edge:** `npm run build` regenerates the example manifest with bundled code strings (deps inlined).

---

<!-- START_TASK_1 -->
### Task 1: Install build/runtime deps (infrastructure)

**Verifies:** None (setup).

**Files:**
- Modify: `package.json` (add deps + `build` script)

**Step 1: Install**

Run:
```bash
npm install --save-dev esbuild
npm install defuddle linkedom
```

**Step 2: Add the build script**

Add to `package.json` `scripts`:
```json
"build": "node scripts/build-examples.mjs"
```

**Step 3: Verify**

Run: `npm ls esbuild defuddle linkedom`
Expected: all resolve with versions.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add esbuild, defuddle, linkedom and build script"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-5) -->

<!-- START_TASK_2 -->
### Task 2: Pure parsing helpers (`src/examples/lib/parse.ts`)

**Verifies:** dynamic-workers-demo.AC2.2, dynamic-workers-demo.AC2.3, dynamic-workers-demo.AC2.4, dynamic-workers-demo.AC2.5 (the pure cores of the transforms).

**Files:**
- Create: `src/examples/lib/parse.ts`
- Test: `test/examples/parse.spec.ts` (unit, fixture-driven)

**Implementation:** Pure, side-effect-free parsers the transforms wrap. Keep these in the functional core so they are unit-testable from HTML/JSON fixtures without the loader:

- `parseOpenGraph(html: string): Record<string, string>` — extract `<meta property="og:*" content="...">` (and `twitter:*` optionally) via a tolerant regex or `linkedom`. Return `{}` when none found (dynamic-workers-demo.AC2.5). Prefer a small regex parser to avoid bundling linkedom into the opengraph example.
- `parseRedditTopComments(jsonText: string, limit = 10): Array<{ author: string; score: number; body: string }>` — `JSON.parse`, defensively navigate `data[1].data.children`, keep entries with a `body`, sort by `score` desc, take `limit`. Return `[]` on any shape mismatch or parse error (dynamic-workers-demo.AC2.5).
- `parseHnTopComments(jsonText: string, limit = 10): Array<{ author: string; points: number | null; text: string }>` — `JSON.parse` the Algolia item, recursively flatten `children`, keep nodes with `text`, sort by `points` desc (nulls last), take `limit`. Return `[]` on mismatch/parse error.

All three must be total functions: never throw on bad input; return empty structures.

**Testing:** Use captured fixtures in `test/examples/fixtures/` (a small real-ish HTML doc with OG tags, a Reddit `.json` sample, an HN Algolia item sample, plus an "unsuitable" doc with no OG tags / wrong JSON). Verify:
- dynamic-workers-demo.AC2.2: OG tags extracted into the expected map; empty doc → `{}`.
- dynamic-workers-demo.AC2.3: Reddit top comments sorted by score, correct fields; malformed JSON → `[]`.
- dynamic-workers-demo.AC2.4: HN comments flattened + sorted by points; malformed → `[]`.
- dynamic-workers-demo.AC2.5: each parser returns an empty structure (never throws) on unsuitable input.

> When writing tests, capture realistic fixtures. If unsure of exact Reddit/HN JSON shape, fetch one sample manually while writing the test and save it as a fixture; assert against that fixture. (Consider `ed3d-house-style:property-based-testing` for the parsers — they are normalization functions.)

**Verification:**
Run: `npm test -- parse`
Expected: pass.

**Commit:** `feat: pure parsers for opengraph, reddit, hackernews`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Example transform modules (`src/examples/{markdown,opengraph,reddit,hackernews}.ts`)

**Verifies:** dynamic-workers-demo.AC2.1, dynamic-workers-demo.AC2.2, dynamic-workers-demo.AC2.3, dynamic-workers-demo.AC2.4, dynamic-workers-demo.AC2.5 (full transforms; proven through the loader in Task 6).

**Files:**
- Create: `src/examples/opengraph.ts`, `src/examples/reddit.ts`, `src/examples/hackernews.ts`, `src/examples/markdown.ts`
- Test: covered by Task 6 integration test (and the pure cores by Task 2).

**Implementation:** Each default-exports `transform(input: RunInput)`:

- `opengraph.ts`: `return parseOpenGraph(input.body);` (imports the pure helper).
- `reddit.ts`: `return parseRedditTopComments(input.body);`.
- `hackernews.ts`: `return parseHnTopComments(input.body);`.
- `markdown.ts`: uses defuddle:
  ```ts
  import { parseHTML } from "linkedom";
  import { Defuddle } from "defuddle/node";
  import type { RunInput } from "../runtime/types";

  export default async function transform(input: RunInput): Promise<unknown> {
    try {
      const { document } = parseHTML(input.body);
      const result = await Defuddle(document, input.finalUrl, { markdown: true });
      return { title: result.title ?? null, markdown: result.content ?? "", wordCount: result.wordCount ?? null };
    } catch (err) {
      return { title: null, markdown: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
  ```
  The try/catch keeps it total for dynamic-workers-demo.AC2.5.

> Verify `defuddle/node` + `linkedom` bundle and run inside the Dynamic Worker isolate (workerd + nodejs_compat). This is the one example with heavy deps; if linkedom needs a Node API unavailable in workerd, the Task 6 integration test will reveal it — capture and resolve (e.g. swap to `happy-dom`, or restrict markdown to a deploy-verified criterion) rather than leaving it unverified.

**Verification:** Type-checks. Behavior in Task 6.

**Commit:** `feat: add markdown, opengraph, reddit, hackernews example transforms`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Build script + generated manifest (`scripts/build-examples.mjs`, `src/examples/manifest.generated.ts`, `src/examples/manifest.ts`)

**Verifies:** dynamic-workers-demo.AC2.6.

**Files:**
- Create: `scripts/build-examples.mjs`
- Create: `src/examples/registry.ts` (static list of example metadata + entry file paths)
- Generate: `src/examples/manifest.generated.ts` (output of the build; committed)
- Create: `src/examples/manifest.ts` (typed accessor over the generated data)
- Test: `test/examples/manifest.spec.ts` (unit)

**Implementation:**

`registry.ts` — the source of truth for which examples exist and their metadata (no code):
```ts
export type ExampleMeta = {
  id: string;
  title: string;
  description: string;
  suggestedUrls: string[];
  entry: string; // path to the .ts module, relative to repo root
};
export const EXAMPLE_REGISTRY: ExampleMeta[] = [
  { id: "markdown", title: "Readable Markdown", description: "...", suggestedUrls: ["https://<article-url>"], entry: "src/examples/markdown.ts" },
  { id: "opengraph", title: "OpenGraph Tags", description: "...", suggestedUrls: ["https://<page-with-og>"], entry: "src/examples/opengraph.ts" },
  { id: "reddit", title: "Reddit Top Comments", description: "...", suggestedUrls: ["https://www.reddit.com/r/<sub>/comments/<id>.json"], entry: "src/examples/reddit.ts" },
  { id: "hackernews", title: "Hacker News Top Comments", description: "...", suggestedUrls: ["https://hn.algolia.com/api/v1/items/<id>"], entry: "src/examples/hackernews.ts" },
  { id: "cpu-spin", title: "CPU Spin (killed by platform)", description: "...", suggestedUrls: ["https://example.com"], entry: "src/examples/cpu-spin.ts" },
  { id: "blocked-fetch", title: "Blocked fetch()", description: "...", suggestedUrls: ["https://example.com"], entry: "src/examples/blocked-fetch.ts" },
];
```
(Fill `description` and concrete `suggestedUrls` with real, currently-valid URLs when implementing; the reddit/hackernews ones MUST be the JSON endpoints.)

`scripts/build-examples.mjs` — imports `EXAMPLE_REGISTRY` (read it by importing the compiled list, or by re-declaring the entry list in the script if importing TS from a `.mjs` is awkward — simplest: the script reads `src/examples/registry.ts` via esbuild too, or duplicates the small list; choose at implementation and keep DRY by having esbuild bundle `registry.ts` first). For each example: run esbuild bundle-to-string on `entry` (settings from Key API facts above), and read the raw source text of `entry` for display. Emit `src/examples/manifest.generated.ts`:
```ts
// AUTO-GENERATED by scripts/build-examples.mjs — do not edit.
export const GENERATED_MANIFEST = [
  { id: "markdown", title: "...", description: "...", suggestedUrls: [...], source: "<raw .ts source>", code: "<bundled esm string>" },
  // ...one per example
] as const;
```
Escape the strings safely (use `JSON.stringify` on each string value when generating).

`manifest.ts` — typed accessor:
```ts
import { GENERATED_MANIFEST } from "./manifest.generated";
export type Example = { id: string; title: string; description: string; suggestedUrls: string[]; source: string; code: string };
export const EXAMPLES: Example[] = GENERATED_MANIFEST as unknown as Example[];
export function listExamples(): Omit<Example, "code">[] { return EXAMPLES.map(({ code, ...rest }) => rest); }
export function getExample(id: string): Example | undefined { return EXAMPLES.find((e) => e.id === id); }
```

**Testing:** `manifest.spec.ts` verifies (dynamic-workers-demo.AC2.6):
- `EXAMPLES` contains all six ids.
- Each has a non-empty `code` string; the `markdown` entry's `code` is substantially larger than its `source` (deps inlined) — assert `code.length > source.length` for `markdown`, proving bundling happened.
- `listExamples()` omits `code`; `getExample("opengraph")` returns the entry.

**Verification:**
Run: `npm run build && npm test -- manifest`
Expected: build regenerates `manifest.generated.ts`; tests pass. Confirm re-running `npm run build` produces a stable file (no spurious diffs beyond expected content).

**Commit:** `feat: build script generating bundled example manifest`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Wire examples into the host (`src/index.ts`)

**Verifies:** dynamic-workers-demo.AC2.1–AC2.5 (resolution path), supports dynamic-workers-demo.AC4.1 (next phase).

**Files:**
- Modify: `src/index.ts`
- Test: `test/index.spec.ts` (extend, integration)

**Implementation:**
- Add `GET /api/examples` → `Response.json(listExamples())`.
- Extend `POST /api/run` body to `{ exampleId?: string, customCode?: string, url: string }`. Resolve code: if `exampleId`, `getExample(id)?.code` (404/400 if unknown id); else use `customCode`. Require exactly one of the two. Then proceed with `fetchTarget` + `runInLoader` exactly as Phase 1.

**Testing:** Verify:
- `GET /api/examples` returns the six examples with metadata and no `code` field.
- `POST /api/run` with `{ exampleId: "opengraph", url }` (target served via test stub returning OG HTML) returns the parsed OG tags (dynamic-workers-demo.AC2.2 through the real loader path).
- Unknown `exampleId` → 400/404, loader not invoked.

**Verification:**
Run: `npm test`
Expected: pass.

**Commit:** `feat: expose /api/examples and resolve exampleId in /api/run`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_6 -->
### Task 6: Example integration tests through the loader

**Verifies:** dynamic-workers-demo.AC2.1, dynamic-workers-demo.AC2.2, dynamic-workers-demo.AC2.3, dynamic-workers-demo.AC2.4, dynamic-workers-demo.AC2.5.

**Files:**
- Test: `test/examples/examples.spec.ts` (integration, Workers runtime)

**Implementation:** No new source. Run each example's bundled `code` from the manifest through `runInLoader` with a synthetic `RunInput` whose `body` is a captured fixture.

**Testing:** Verify:
- dynamic-workers-demo.AC2.1: `markdown` over an article-HTML fixture returns non-empty `markdown`/clean text (or, if linkedom proves incompatible in-isolate per Task 3, this becomes a deploy-verified criterion recorded in `test-requirements.md`).
- dynamic-workers-demo.AC2.2: `opengraph` over an OG-tagged fixture returns the tags.
- dynamic-workers-demo.AC2.3: `reddit` over a `.json` fixture returns sorted top comments.
- dynamic-workers-demo.AC2.4: `hackernews` over an Algolia-item fixture returns sorted comments.
- dynamic-workers-demo.AC2.5: each example over an unsuitable fixture returns an empty/structured result with `ok: true` (no unhandled crash, no `error`).

**Verification:**
Run: `npm test`
Expected: all Phase 3 tests pass.

**Commit:** `test: example transforms end-to-end through the loader`
<!-- END_TASK_6 -->

---

## Phase 3 Done When
- Each example run against a suitable fixture/URL returns expected structured output (dynamic-workers-demo.AC2.1–AC2.4).
- Examples degrade gracefully on unsuitable input (dynamic-workers-demo.AC2.5).
- `npm run build` regenerates `manifest.generated.ts` with bundled (deps-inlined) code strings (dynamic-workers-demo.AC2.6).
- `npm test` green; `npx tsc --noEmit` clean.
