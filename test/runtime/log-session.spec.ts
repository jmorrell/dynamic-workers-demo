import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { LogLine } from '@/runtime/log-types';

describe('LogSession Durable Object', () => {
	it('appends log lines and retrieves them', async () => {
		const runId = 'test-run-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const lines: Array<LogLine> = [
			{ level: 'info', message: 'hello' },
			{ level: 'warn', message: 'world' },
		];

		await stub.append(lines);
		const result = await stub.getLogs(50);

		expect(result.lines).toEqual(lines);
		expect(result.truncated).toBe(false);
	});

	it('respects line and byte caps on append', async () => {
		const runId = 'test-cap-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const lines: Array<LogLine> = [];
		for (let i = 0; i < 250; i++) {
			lines.push({ level: 'info', message: `line${i}` });
		}

		await stub.append(lines);
		const result = await stub.getLogs(50);

		// Should be capped at 200 lines
		expect(result.lines.length).toBe(200);
		expect(result.truncated).toBe(true);
	});

	it('multiple appends accumulate lines', async () => {
		const runId = 'test-multi-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const lines1: Array<LogLine> = [{ level: 'info', message: 'first' }];
		const lines2: Array<LogLine> = [{ level: 'info', message: 'second' }];

		await stub.append(lines1);
		await stub.append(lines2);
		const result = await stub.getLogs(50);

		expect(result.lines).toEqual([...lines1, ...lines2]);
		expect(result.truncated).toBe(false);
	});

	it('getLogs waits until append occurs before returning', async () => {
		const runId = 'test-wait-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const timeout = 60;
		const startTime = Date.now();
		const result = await stub.getLogs(timeout);
		const elapsed = Date.now() - startTime;

		// Should wait for most of the timeout before returning empty
		expect(result).toEqual({ lines: [], truncated: false });
		expect(elapsed).toBeGreaterThanOrEqual(timeout * 0.75);
	});

	it('getLogs returns immediately if append already occurred', async () => {
		const runId = 'test-immed-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const lines: Array<LogLine> = [{ level: 'info', message: 'test' }];
		await stub.append(lines);

		const startTime = Date.now();
		const result = await stub.getLogs(1000);
		const elapsed = Date.now() - startTime;

		expect(result.lines).toEqual(lines);
		expect(elapsed).toBeLessThan(100);
	});

	it('returns empty bundle when getLogs called before any append', async () => {
		const runId = 'test-empty-' + Math.random();
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));

		const result = await stub.getLogs(30);
		expect(result).toEqual({ lines: [], truncated: false });
	});

	it('distinguishes between no logs yet and genuinely empty append', async () => {
		const runId1 = 'test-noappend-' + Math.random();
		const stub1 = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId1));

		// Case 1: No append called at all
		const result1 = await stub1.getLogs(30);
		expect(result1).toEqual({ lines: [], truncated: false });

		// Case 2: Append was called with empty array
		const runId2 = 'test-emptyappend-' + Math.random();
		const stub2 = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId2));

		await stub2.append([]);
		const timeout = 60;
		const startTime = Date.now();
		const result2 = await stub2.getLogs(timeout);
		const elapsed = Date.now() - startTime;

		// Empty append should not count as "appended", so getLogs should wait for timeout
		expect(result2).toEqual({ lines: [], truncated: false });
		expect(elapsed).toBeGreaterThanOrEqual(timeout * 0.75);
	});
});
