import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import { classifyLoaderError } from '../../src/runtime/core';
import type { RunInput } from '../../src/runtime/types';

describe('Safety demos: hostile code containment', () => {
	let testInput: RunInput;
	let ctx: ExecutionContext;

	beforeEach(() => {
		testInput = {
			url: 'https://example.com/test',
			finalUrl: 'https://example.com/test',
			status: 200,
			contentType: 'text/html',
			body: '<html>Test page</html>',
			truncated: false,
		};
		ctx = createExecutionContext();
	});

	describe('AC5.2: blocked-fetch safety demo', () => {
		it('blocked-fetch module attempts network call and gets blocked', async () => {
			// Inline the blocked-fetch example module as JavaScript (transpiled from TS)
			const blockedFetchCode = `
export default async function transform(input) {
	const res = await fetch('https://example.com/should-be-blocked');
	return { status: res.status, from: input.url };
}
`;
			const result = await runInLoader(env, testInput, blockedFetchCode, crypto.randomUUID(), ctx);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Must be network_blocked per AC5.2
				expect(result.error.kind).toBe('network_blocked');
				// The error message should mention the blocked access
				expect(result.error.message.toLowerCase()).toMatch(/disallowed|not allowed|globaloutbound|internet/);
			}
		});
	});

	describe('AC5.1: cpu-spin safety demo - error mapping and host responsiveness', () => {
		it('classifyLoaderError maps CPU limit messages to cpu_exceeded', () => {
			// Direct unit test of the pure classification function
			// This verifies the mapping logic deterministically without relying on platform enforcement
			// Narrow matcher: only CPU/time-budget signatures (requires "cpu" AND "exceeded"/"limit"/"time")
			const testCases = ['error: exceeded cpu limit of 50ms', 'CPU limit exceeded', 'exceeded cpu', 'cpu time exceeded'];

			testCases.forEach((message) => {
				const kind = classifyLoaderError(message);
				expect(kind).toBe('cpu_exceeded', `Failed for message: ${message}`);
			});
		});

		it('classifyLoaderError distinguishes between cpu_exceeded and loader_failed', () => {
			// Verify that unrelated errors still map to loader_failed
			const nonCpuMessages = ['module not found', 'syntax error in worker code', 'initialization failed', 'RPC error'];

			nonCpuMessages.forEach((message) => {
				const kind = classifyLoaderError(message);
				expect(kind).toBe('loader_failed', `Failed for message: ${message}`);
			});
		});

		describe('Host responsiveness under load (AC5.1 criterion)', () => {
			it('host stays responsive to concurrent trivial requests', async () => {
				// Verify host responsiveness by running multiple concurrent trivial (non-spinning) transforms.
				// This tests that the platform/host can handle concurrent load without blocking.
				//
				// Note: We test concurrent trivial transforms here (not hostile spinning code)
				// because limits are NOT enforced locally (only on deployed Cloudflare infrastructure).
				// The actual cpu-spin containment and responsiveness under concurrent spin
				// is verified on deploy (see deployment notes below).

				const trivialCode = 'export default (input) => ({ received: true, url: input.url })';

				// Run multiple trivial requests concurrently to verify host responsiveness
				const results = await Promise.all([
					runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx),
					runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx),
					runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx),
				]);

				// All trivial requests must succeed
				results.forEach((result) => {
					expect(result.ok).toBe(true);
					if (result.ok) {
						expect(result.value).toEqual({ received: true, url: testInput.url });
					}
				});
			});

			it('host responds to sequential requests', async () => {
				// Second responsiveness check: sequential requests should complete normally.
				// This establishes a baseline for host performance.

				const trivialCode = 'export default (input) => input.status';

				// Issue three sequential requests
				const result1 = await runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx);
				const result2 = await runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx);
				const result3 = await runInLoader(env, testInput, trivialCode, crypto.randomUUID(), ctx);

				// All should succeed
				expect(result1.ok).toBe(true);
				expect(result2.ok).toBe(true);
				expect(result3.ok).toBe(true);

				if (result1.ok && result2.ok && result3.ok) {
					expect(result1.value).toBe(200);
					expect(result2.value).toBe(200);
					expect(result3.value).toBe(200);
				}
			});
		});
	});

	describe('Deployment verification notes (AC5.1 deploy criterion)', () => {
		/**
		 * DEPLOYMENT VERIFICATION REQUIRED:
		 *
		 * The following criterion is verified locally via unit tests (classifyLoaderError)
		 * and host responsiveness checks, but final validation requires deployment:
		 *
		 * DEPLOY CRITERION:
		 * - Deploy the application with cpu-spin example module
		 * - Invoke cpu-spin via the application
		 * - Verify the cpu-spin returns { ok: false, error.kind: 'cpu_exceeded' } in <1 second
		 *   (Platform enforces limits.cpuMs: 50, so the spin is killed deterministically)
		 * - While cpu-spin is running, issue a concurrent request to the host
		 * - Verify the concurrent request completes normally (host remains responsive)
		 *
		 * This test cannot be automated locally because vitest/workerd does not enforce
		 * CPU limits. See test-requirements.md for full details.
		 *
		 * Evidence will be captured by:
		 * - Screenshots/logs showing cpu-spin blocked and returning cpu_exceeded
		 * - Screenshots/logs showing concurrent host request succeeding
		 * - Response times for both requests
		 */
		it('deployment verification note (informational, not automated)', () => {
			// This is an informational placeholder. The actual criterion is verified
			// by deployment and manual testing (see comments above).
			expect(true).toBe(true);
		});
	});
});
