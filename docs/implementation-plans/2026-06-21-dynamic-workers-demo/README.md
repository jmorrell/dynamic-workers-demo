# Dynamic Workers Demo — Implementation Plan

Phases `phase_01.md` … `phase_06.md` implement the design at
`docs/design-plans/2026-06-21-dynamic-workers-demo.md`. Execute them in order.

## Verification artifacts

`test-requirements.md` (in this directory) is a **planning artifact**, generated
during planning from the acceptance criteria + these phase files. It is the canonical
map of each AC → automated test or human/deploy verification. Executors **update** it
(they do not create it); the `test-analyst` step consumes it after the final code review.

## Deploy / human-verified criteria (cannot be fully asserted in local vitest)

Local `vitest`/`wrangler dev` does **not** enforce CPU limits, reliably deliver tail
events, run a browser, or guarantee `linkedom`-in-isolate. The following criteria keep a
unit-testable substitute (error-mapping, DO cap logic, escaping helpers) **and** a
deploy/human step. These MUST appear in `test-requirements.md`; do not silently skip them:

- **dynamic-workers-demo.AC5.1 (CPU kill, Phase 2):** deploy, run `cpu-spin`, confirm a
  sub-second `cpu_exceeded` result AND that a concurrent request to the host succeeds.
- **dynamic-workers-demo.AC3.1–AC3.3 (live log forwarding, Phase 4):** if local tail
  delivery is unreliable, deploy and confirm `console.log` lines + an exception appear in
  the `/api/run` response, and that over-cap output sets `logsTruncated`.
- **dynamic-workers-demo.AC2.1 (markdown/linkedom-in-isolate, Phase 3):** if `defuddle/node`
  + `linkedom` cannot run inside the Dynamic Worker isolate locally, confirm on deploy (or
  swap to `happy-dom`) that `markdown` returns non-empty output for an article URL.
- **dynamic-workers-demo.AC4.5 + AC6.1 (iframe render / inert output, Phase 5):** load
  `public/embed-example.html`, confirm the widget renders inside the `<iframe>` and that a
  run returning `<script>` displays escaped text (no alert).
- **dynamic-workers-demo.AC6.2 (Turnstile with real keys, Phase 6):** with production keys,
  confirm a run without solving the challenge is rejected (403) and the loader is not invoked.
