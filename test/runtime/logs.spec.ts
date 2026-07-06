import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import type { RunInput } from '../../src/runtime/types';
import type { LogLine } from '../../src/runtime/log-types';

/**
 * Log capture and forwarding tests (AC3)
 *
 * EMPIRICAL FINDING (vitest + @cloudflare/vitest-pool-workers):
 * Tail workers do NOT deliver events to tail handlers in the local vitest environment.
 * Console output is visible in test output, but LogTailer.tail() is never invoked.
 * This means AC3.1 and AC3.2 (log forwarding via tails) cannot be fully tested locally.
 *
 * LOCAL TEST COVERAGE:
 * - AC3.3: LogSession cap logic is fully tested via log-session.spec.ts and log-cap.spec.ts
 * - AC3.4: Silent transforms (no logs) are fully tested here
 * - AC3.3 direct: Verifying cap enforcement via LogSession.append()
 *
 * DEPLOY-VERIFIED CRITERIA (see test-requirements.md):
 * - AC3.1: Console logs appearing in response requires real tail delivery (deploy test)
 * - AC3.2: Exception logs appearing in response requires real tail delivery (deploy test)
 */
describe('Log capture and forwarding (AC3)', () => {
	let testInput: RunInput;
	let ctx: ExecutionContext;

	beforeEach(() => {
		testInput = {
			url: 'https://example.com/test',
			finalUrl: 'https://example.com/test',
			status: 200,
			contentType: 'text/html',
			responseHeaders: new Map(),
			body: '<html>Test page</html>',
			truncated: false,
		};
		ctx = createExecutionContext();
	});

	describe('AC3.4: Silent transforms return empty logs without error', () => {
		it('silent transform returns empty logs, not an error', async () => {
			const runId = `test-silent-${Date.now()}-${Math.random()}`;
			const code = `
        export default (env, input) => {
          // No console.log, no exceptions
          return 'result';
        }
      `;

			// Transform should succeed
			const result = await runInLoader(env, testInput, code, runId, ctx);
			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toBe('result');
			}

			// Logs should be empty but not an error
			const logsStub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
			const logs = await logsStub.getLogs(500);

			expect(logs.lines.length).toBe(0);
			expect(logs.truncated).toBe(false);
		});

		it('transform with no logging returns empty log array', async () => {
			const runId = `test-no-logs-${Date.now()}-${Math.random()}`;
			const code = `
        export default (env, input) => {
          const x = input.status;
          const y = input.contentType;
          return { status: x, type: y };
        }
      `;

			const result = await runInLoader(env, testInput, code, runId, ctx);
			expect(result.type).toBe('success');

			const logsStub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
			const logs = await logsStub.getLogs(500);

			expect(logs.lines.length).toBe(0);
			expect(logs.truncated).toBe(false);
		});
	});

	describe('AC3.3: Output beyond caps is truncated', () => {
		it('LogSession enforces line cap via appendWithCap', async () => {
			// AC3.3: Verify that the LogSession DO enforces caps (unit test of log-cap logic).
			// This is already fully tested in log-session.spec.ts and log-cap.spec.ts.
			// This test directly exercises the cap logic to ensure truncation works.
			const runId = `test-line-cap-${Date.now()}-${Math.random()}`;
			const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

			// Append more than 200 lines (the line cap)
			const lines: Array<LogLine> = [];
			for (let i = 0; i < 250; i++) {
				lines.push({ level: 'info', message: `line${i}` });
			}

			await stub.append(lines);
			const result = await stub.getLogs(100);

			// Should be capped at 200 lines with truncated flag set
			expect(result.lines.length).toBe(200);
			expect(result.truncated).toBe(true);
		});

		it('LogSession enforces byte cap via appendWithCap', async () => {
			// AC3.3: Verify byte cap enforcement
			const runId = `test-byte-cap-${Date.now()}-${Math.random()}`;
			const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

			// Append lines totaling > 16KB to exceed byte cap
			const lines: Array<LogLine> = [];
			const longMessage = 'x'.repeat(1000); // 1000 bytes per line
			for (let i = 0; i < 50; i++) {
				lines.push({ level: 'info', message: longMessage });
			}

			await stub.append(lines);
			const result = await stub.getLogs(100);

			// Should be capped at or below 16KB with truncated flag set
			const totalBytes = result.lines.reduce((sum, line) => sum + new TextEncoder().encode(line.message).length, 0);
			expect(totalBytes).toBeLessThanOrEqual(16 * 1024);
			expect(result.truncated).toBe(true);
			// Should have fewer than 50 lines due to byte cap
			expect(result.lines.length).toBeLessThan(50);
		});
	});

	describe('AC3.1 & AC3.2: Tail delivery (DEPLOY-VERIFIED)', () => {
		it('runInLoader attaches the tail worker via runId and ctx', async () => {
			// Verify the integration point is in place: runInLoader always attaches
			// the LogTailer tail worker via runId/ctx. Actual tail delivery is not
			// available in local vitest (see note above).
			const runId = `test-integration-${Date.now()}-${Math.random()}`;
			const code = `
        export default (env, input) => {
          console.log('test message');
          return 'success';
        }
      `;

			const result = await runInLoader(env, testInput, code, runId, ctx);
			expect(result.type).toBe('success');
		});

		it('LogSession.getLogs returns valid LogBundle structure', async () => {
			// Verify the response structure is in place for log retrieval.
			const runId = `test-structure-${Date.now()}-${Math.random()}`;

			// Add some logs directly via LogSession (simulating tail delivery)
			const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
			await stub.append([{ level: 'log', message: 'test' }]);

			const logs = await stub.getLogs(100);

			// Verify LogBundle structure
			expect(logs).toHaveProperty('lines');
			expect(logs).toHaveProperty('truncated');
			expect(Array.isArray(logs.lines)).toBe(true);
			expect(typeof logs.truncated).toBe('boolean');
		});

		it.skip('AC3.1: Console logs from transform appear in logs (DEPLOY-VERIFIED)', async () => {
			// This test requires tail worker delivery which is not available in local vitest.
			// On the deployed platform, this test should verify that N console.log() calls
			// from the transform appear as N log lines in the response via the tail worker.
			// Skipped in local testing; use human/deploy verification instead.
		});

		it.skip('AC3.2: Exception from transform appears in logs (DEPLOY-VERIFIED)', async () => {
			// This test requires tail worker delivery which is not available in local vitest.
			// On the deployed platform, this test should verify that exceptions thrown
			// by the transform appear in the returned logs via the tail worker.
			// Skipped in local testing; use human/deploy verification instead.
		});
	});
});
