# Test Requirements: Phase 2 Safety Demos

## Overview

Phase 2 introduces safety-demo example modules (`cpu-spin` and `blocked-fetch`) to verify the platform contains hostile code. This document outlines which criteria are verified locally via automated tests and which require deployment-based verification.

## AC5.2: Network-Blocked Fetch ✓ LOCALLY VERIFIED

**Acceptance Criterion:** `blocked-fetch` (a `fetch()` call) is blocked by `globalOutbound: null` and returns a friendly network-blocked error.

**Automation Status:** VERIFIED LOCALLY

**Test:** `test/runtime/safety.spec.ts` > `AC5.2: blocked-fetch safety demo`

**Verification:**
- Test runs `blocked-fetch` code through `runInLoader` with a network fetch attempt
- Verifies the result has `ok: false` and `error.kind: 'network_blocked'`
- Confirms error message matches network-blocked patterns (e.g., "disallowed", "globalOutbound", "internet")

**Test Command:**
```bash
npm test -- safety
```

## AC5.1: CPU Limit Containment — DUAL VERIFICATION APPROACH

**Acceptance Criterion:** `cpu-spin` (`while(true)`) is killed by the CPU limit in well under a second and returns a `cpu_exceeded` error; the host serves a concurrent request normally.

**Automation Status:** PARTIALLY VERIFIED LOCALLY; DEPLOYMENT VERIFICATION REQUIRED

### Local Verification (Automated) ✓

**Why local verification is limited:**
- `@cloudflare/vitest-pool-workers` (local development runtime) does NOT enforce `limits.cpuMs`
- CPU limits are enforced ONLY on Cloudflare's production infrastructure
- Without platform enforcement, `cpu-spin` would create an infinite loop and hang tests indefinitely

**What IS verified locally:**

1. **Error Mapping Logic** (Unit Test)
   - Test: `test/runtime/safety.spec.ts` > `classifyLoaderError maps CPU limit messages to cpu_exceeded`
   - Verifies the pure function `classifyLoaderError(message)` deterministically classifies CPU limit messages
   - Confirms mappings: messages containing "cpu", "limit", "exceeded", "timeout", or "resource" → `'cpu_exceeded'`
   - Confirms that unrelated messages → `'loader_failed'`
   - This ensures when the platform DOES throw a CPU limit exception on deploy, it will be correctly mapped

2. **Host Responsiveness Under Load** (Integration Test)
   - Test: `test/runtime/safety.spec.ts` > `Host responsiveness under load (AC5.1 criterion)`
   - Verifies the host remains responsive to concurrent and sequential trivial requests
   - Establishes a baseline that the system can handle multiple concurrent requests without blocking
   - Does NOT test cpu-spin directly (would hang indefinitely)

**Test Command:**
```bash
npm test -- safety
```

Expected output:
```
✓ classifyLoaderError maps CPU limit messages to cpu_exceeded
✓ classifyLoaderError distinguishes between cpu_exceeded and loader_failed
✓ host stays responsive to concurrent trivial requests
✓ host responds to sequential requests
```

### Deployment Verification (Manual) — REQUIRED FOR COMPLETION

**Deployment Criterion:** The actual CPU limit enforcement must be verified on deployed Cloudflare infrastructure where limits ARE enforced.

**Procedure:**

1. **Deploy the application** to Cloudflare Workers with Phase 2 code
2. **Invoke the `cpu-spin` endpoint** that runs the hostile code
3. **Measure and record:**
   - Execution time: Should terminate in <1 second (platform enforces `limits.cpuMs: 50`)
   - Error response: Must have `ok: false, error.kind: 'cpu_exceeded'`
   - Confirm the error message signature matches what `classifyLoaderError` expects

4. **Verify host responsiveness:**
   - While (or immediately after) running `cpu-spin`, issue a concurrent request to the host
   - Record response time and status
   - Confirm the concurrent request completes normally (host not blocked/DoS'd)

5. **Evidence to capture:**
   - Screenshot or log showing `cpu-spin` response with `cpu_exceeded` error
   - Screenshot or log showing concurrent host request succeeding
   - Response time measurements for both requests
   - Timestamp and deployment details (region, worker version, etc.)

**Example curl commands for testing (on deployed URL):**
```bash
# Test cpu-spin (should timeout after ~50ms)
time curl https://your-deployed-workers.example.com/run/cpu-spin

# Expected response: { ok: false, error: { kind: 'cpu_exceeded', message: '...' } }
# Expected time: <1 second

# Test concurrent request during cpu-spin
time curl https://your-deployed-workers.example.com/run/trivial &
time curl https://your-deployed-workers.example.com/run/cpu-spin
wait
```

**Acceptance:**
- [ ] cpu-spin returns `cpu_exceeded` in <1 second
- [ ] Error message contains "cpu" or "limit" or similar (matches `classifyLoaderError` patterns)
- [ ] Concurrent request completes normally with response time <500ms
- [ ] Host is not blocking/throttling other requests during cpu-spin

## Summary Table

| Criterion | Verification Method | Status | Test Command |
|-----------|-------------------|--------|--------------|
| AC5.2 Network blocked | Local automated | ✓ Complete | `npm test -- safety` |
| AC5.1 Error mapping logic | Local automated (unit) | ✓ Complete | `npm test -- safety` |
| AC5.1 Host responsiveness | Local automated (integration) | ✓ Complete | `npm test -- safety` |
| AC5.1 CPU kill behavior | Deployment manual | ⏳ Pending | (on deployed infrastructure) |
| AC5.1 Concurrent host responsiveness during kill | Deployment manual | ⏳ Pending | (on deployed infrastructure) |

## Notes

- Local tests cannot be extended to directly test cpu-spin containment because the local runtime doesn't enforce limits; attempting to do so would hang the test suite indefinitely
- The error classification is unit-tested deterministically, ensuring the mapping logic is correct
- Host responsiveness is proven with trivial requests, establishing the baseline the platform can meet
- Actual kill behavior (CPU limit enforcement) can only be validated on Cloudflare infrastructure where the limits are implemented
- See `test/runtime/safety.spec.ts` for detailed test documentation
