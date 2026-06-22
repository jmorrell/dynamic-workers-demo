# Dynamic Workers Demo — Phase 6: Abuse Controls (Turnstile + Rate Limiting)

**Goal:** Make the public `/api/run` endpoint safe to expose on an open blog.

**Architecture:** Two gates run **before** any target fetch or loader invocation: (1) per-IP rate limiting via the Workers `ratelimit` binding keyed on the client IP, returning 429 when exceeded; (2) Turnstile token verification via server-side siteverify, rejecting missing/invalid tokens. The siteverify call is wrapped in an injectable `verifyTurnstile` function so tests can drive it deterministically (and Turnstile's documented test keys give always-pass/always-fail behavior). The frontend renders the Turnstile widget and includes the token in the run request.

**Tech Stack:** Workers `ratelimit` binding (GA), Cloudflare Turnstile (siteverify), Worker secrets/vars, the existing frontend.

**Scope:** Phase 6 of 6. **Depends on:** Phases 1 (loader/route) and 5 (frontend).

**Codebase verified:** 2026-06-21. After Phases 1–5: `/api/run` performs fetch + loader + logs; frontend posts `{ exampleId|customCode, url }`. `wrangler.jsonc` has `worker_loaders`, `durable_objects`, `assets`; no `ratelimits`, no secrets/vars. No Turnstile in the UI.

**Key API facts (verified 2026-06-21):**
- **Rate limiting binding (GA):** wrangler `"ratelimits": [ { "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": <n>, "period": 10 | 60 } } ]` — `period` MUST be 10 or 60. In code: `const { success } = await env.RATE_LIMITER.limit({ key });`. Works in local dev. (Verify the exact config key `ratelimits` via the wrangler `$schema` autocomplete when editing.)
- **Turnstile siteverify:** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with form body `secret`, `response` (token), optional `remoteip`; returns JSON `{ success: boolean, "error-codes": string[] }`. Secret is a Worker **secret**; site key is public (used in the frontend widget).
- **Turnstile test keys** (for tests/local): site key `1x00000000000000000000AA` (always passes); secret `1x0000000000000000000000000000000AA` (always passes), `2x0000000000000000000000000000000AA` (always fails).

**Skills to apply:** `ed3d-house-style:howto-code-in-typescript`, `ed3d-house-style:howto-functional-vs-imperative`, `ed3d-house-style:prompt-security-hardening` (do NOT hardcode/log the Turnstile secret — read from `env`, keep out of the client bundle), `ed3d-plan-and-execute:test-driven-development`, `ed3d-plan-and-execute:writing-good-tests`. Run `npm run cf-typegen` after adding bindings.

---

## Acceptance Criteria Coverage

### dynamic-workers-demo.AC6: Output is safe and the public endpoint is protected
- **dynamic-workers-demo.AC6.2 Failure:** A run request without a valid Turnstile token is rejected and does not invoke the loader.
- **dynamic-workers-demo.AC6.3 Failure:** Exceeding the per-IP rate limit returns 429 with a clear message and does not invoke the loader.

(dynamic-workers-demo.AC6.1 is covered in Phase 5.)

---

<!-- START_TASK_1 -->
### Task 1: Configure rate-limit binding, Turnstile vars/secrets (infrastructure)

**Verifies:** None (setup).

**Files:**
- Modify: `wrangler.jsonc` (add `ratelimits` + a public `TURNSTILE_SITEKEY` var)
- Create: `.dev.vars` (local secret for tests/dev — gitignored)
- Modify: `.gitignore` (ensure `.dev.vars` is ignored if not already)

**Step 1: Add bindings/vars**

Add to `wrangler.jsonc`:
```jsonc
"ratelimits": [
  { "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }
],
"vars": {
  "TURNSTILE_SITEKEY": "1x00000000000000000000AA"
},
```
(Site key `1x...` is the always-pass test key; replace with the real public site key for production. The site key is public — safe in config and the client.)

**Step 2: Local secret**

Create `.dev.vars` (gitignored) with the always-pass test secret for local/dev:
```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```
For production: `npx wrangler secret put TURNSTILE_SECRET`. Confirm `.dev.vars` is in `.gitignore` (the create-cloudflare scaffold's `.gitignore` typically includes it — verify and add if missing). NEVER commit the real secret.

**Step 3: Verify**

Run: `npm run cf-typegen && npx tsc --noEmit`
Expected: `Env` includes `RATE_LIMITER`, `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`; no type errors.

**Step 4: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts .gitignore
git commit -m "chore: add rate-limit binding and Turnstile config"
```
(Do NOT `git add .dev.vars`.)
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Turnstile verification helper (`src/runtime/turnstile.ts`)

**Verifies:** dynamic-workers-demo.AC6.2.

**Files:**
- Create: `src/runtime/turnstile.ts`
- Test: `test/runtime/turnstile.spec.ts` (unit, injected fetch)

**Implementation:** Imperative-shell helper with an injectable fetch for testability:
```ts
export type VerifyResult = { ok: boolean; errorCodes: string[] };

export async function verifyTurnstile(
  token: string | undefined,
  secret: string,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  if (!token) return { ok: false, errorCodes: ["missing-input-response"] };
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);
  const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
  return { ok: data.success === true, errorCodes: data["error-codes"] ?? [] };
}
```
Never logs the secret.

**Testing:** Inject a fake `fetchImpl`:
- Missing token → `{ ok: false }` without calling fetch (dynamic-workers-demo.AC6.2).
- Fake siteverify returning `{ success: false }` → `{ ok: false }`.
- Fake siteverify returning `{ success: true }` → `{ ok: true }`.
(Optionally an integration test using the real endpoint with the `2x...` always-fail secret, if outbound is available in the test env.)

**Verification:**
Run: `npm test -- turnstile`
Expected: pass.

**Commit:** `feat: Turnstile siteverify helper`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Gate `/api/run` with rate limit + Turnstile (`src/index.ts`)

**Verifies:** dynamic-workers-demo.AC6.2, dynamic-workers-demo.AC6.3.

**Files:**
- Modify: `src/index.ts`
- Test: `test/runtime/abuse.spec.ts` (integration)

**Implementation:** At the top of the `/api/run` handler, BEFORE `fetchTarget`/`runInLoader`:
1. **Rate limit first:** derive client IP from `request.headers.get("CF-Connecting-IP") ?? "anonymous"`; `const { success } = await env.RATE_LIMITER.limit({ key: ip });`. If `!success`, return `429` JSON `{ ok: false, error: { kind: "rate_limited", message: "Too many runs, please wait and try again." } }` — loader NOT invoked (dynamic-workers-demo.AC6.3). Add `"rate_limited"` and `"turnstile_failed"` to `RunErrorKind` in `types.ts`.
2. **Turnstile next:** read `turnstileToken` from the request body; `const v = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip)`. If `!v.ok`, return `403` JSON `{ ok: false, error: { kind: "turnstile_failed", message: "Verification failed." } }` — loader NOT invoked (dynamic-workers-demo.AC6.2).
3. Only if both pass, continue to `fetchTarget` + `runInLoader` as before. Extend the request body type to `{ exampleId?, customCode?, url, turnstileToken? }`.

**Testing:** (integration; inject/verify with test keys)
- dynamic-workers-demo.AC6.2: POST `/api/run` with no/invalid `turnstileToken` (using the always-fail secret via `.dev.vars`, or by structuring the handler to use an injectable verifier in tests) → 403, and assert the loader was not invoked (e.g. spy that the response carries no `result`/`timingMs`, or assert via a code path marker). Decide the cleanest no-loader assertion when writing the test.
- dynamic-workers-demo.AC6.3: with a valid token, POST `/api/run` more than `limit` times with the same `CF-Connecting-IP` → eventually `429` with the clear message, loader not invoked on the rejected call. (Set a low `limit` for the test config if needed, or loop to the configured limit.)
- Happy path: valid token + under limit → normal run still works (regression).

> If outbound to the real siteverify endpoint is unavailable in the local test runtime, route `/api/run`'s verification through an injectable verifier (e.g. a module-level default that tests override) so dynamic-workers-demo.AC6.2 is deterministic without network. Keep the production path using the real `verifyTurnstile`.

**Verification:**
Run: `npm test`
Expected: all Phase 6 + prior tests pass.

**Commit:** `feat: rate-limit and Turnstile gates on /api/run`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Turnstile widget in the frontend (`public/index.html`, `frontend/main.ts`)

**Verifies:** dynamic-workers-demo.AC6.2 (client supplies token).

**Files:**
- Modify: `public/index.html` (load the Turnstile script + a widget container)
- Modify: `frontend/main.ts` (read the token; include `turnstileToken` in the run POST)
- Modify: the host to expose the site key (e.g. a `GET /api/config` returning `{ turnstileSitekey }`, or inject it into `index.html`). Simplest: add `GET /api/config` → `{ turnstileSitekey: env.TURNSTILE_SITEKEY }` and have the frontend fetch it to render the widget.

**Implementation:**
- `index.html`: include `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` and a `<div id="turnstile">` container.
- `main.ts`: on load, fetch `/api/config`, render the Turnstile widget with the site key (explicit-render or implicit via the `cf-turnstile` class + `data-sitekey`). On Run, obtain the token (`turnstile.getResponse()` or the callback-stored token) and include `turnstileToken` in the `/api/run` body. Reset the widget after each run (tokens are single-use).
- With the `1x...` test site key, the widget auto-passes locally.

**Verification:**
Run: `npm run build && npm run dev`; load the widget, confirm the Turnstile widget appears and a run succeeds with the test key. (Human-verified step in `test-requirements.md`: with production keys, confirm a run without solving the challenge is rejected.)

**Commit:** `feat: Turnstile widget and token in run requests`
<!-- END_TASK_4 -->

---

## Phase 6 Done When
- Runs without a valid Turnstile token are rejected (403) and do not invoke the loader (dynamic-workers-demo.AC6.2).
- Exceeding the per-IP limit returns 429 with a clear message and does not invoke the loader (dynamic-workers-demo.AC6.3).
- The frontend renders the Turnstile widget and submits the token; happy-path runs still work.
- The Turnstile secret is never committed or logged (`.dev.vars` gitignored; production via `wrangler secret put`).
- `npm test` green; `npx tsc --noEmit` clean.
