import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { LogTailer } from '@/runtime/log-tailer';
import type { LogLine } from '@/runtime/log-types';

describe('LogTailer tail() mapping', () => {
	it('maps logs with message as array of args', async () => {
		const runId = 'test-array-args-' + Math.random();

		// Create a synthetic event with message as array (like console.log outputs)
		const events: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [
					{
						timestamp: Date.now(),
						level: 'log',
						message: ['hello', 'world', 123], // Array of args
					},
				],
				exceptions: [],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		// Create LogTailer and call tail
		const tailer = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		await tailer.tail(events);

		// Read logs back from LogSession
		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
		const result = await stub.getLogs(100);

		// Message should be joined with spaces
		expect(result.lines).toEqual([
			{
				level: 'log',
				message: 'hello world 123',
			},
		]);
		expect(result.truncated).toBe(false);
	});

	it('maps logs with message as string', async () => {
		const runId = 'test-string-msg-' + Math.random();

		const events: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [
					{
						timestamp: Date.now(),
						level: 'warn',
						message: 'single message',
					},
				],
				exceptions: [],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		const tailer = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		await tailer.tail(events);

		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
		const result = await stub.getLogs(100);

		expect(result.lines).toEqual([
			{
				level: 'warn',
				message: 'single message',
			},
		]);
	});

	it('maps exceptions with name and message', async () => {
		const runId = 'test-exception-' + Math.random();

		const events: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [],
				exceptions: [
					{
						timestamp: Date.now(),
						name: 'TypeError',
						message: 'Cannot read property x',
						stack: 'at foo (user.js:5:1)',
					},
				],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		const tailer = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		await tailer.tail(events);

		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
		const result = await stub.getLogs(100);

		// Exception should map to error level with "Name: message" format
		expect(result.lines).toEqual([
			{
				level: 'error',
				message: 'TypeError: Cannot read property x',
			},
		]);
	});

	it('processes multiple logs and exceptions in a single event', async () => {
		const runId = 'test-mixed-' + Math.random();

		const events: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [
					{
						timestamp: Date.now(),
						level: 'info',
						message: 'starting',
					},
					{
						timestamp: Date.now() + 1,
						level: 'error',
						message: ['operation', 'failed'],
					},
				],
				exceptions: [
					{
						timestamp: Date.now() + 2,
						name: 'RuntimeError',
						message: 'timeout',
						stack: '',
					},
				],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		const tailer = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		await tailer.tail(events);

		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
		const result = await stub.getLogs(100);

		expect(result.lines).toEqual([
			{
				level: 'info',
				message: 'starting',
			},
			{
				level: 'error',
				message: 'operation failed',
			},
			{
				level: 'error',
				message: 'RuntimeError: timeout',
			},
		]);
	});

	it('handles empty events array gracefully', async () => {
		const runId = 'test-empty-' + Math.random();

		const tailer = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		// Call tail with empty array
		await tailer.tail([]);

		const stub = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId));
		const result = await stub.getLogs(100);

		// Should not append anything if there are no lines
		expect(result.lines).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it('routes logs to the correct runId-keyed LogSession instance', async () => {
		const runId1 = 'test-route-1-' + Math.random();
		const runId2 = 'test-route-2-' + Math.random();

		const events1: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [
					{
						timestamp: Date.now(),
						level: 'info',
						message: 'runId1 logs',
					},
				],
				exceptions: [],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		const events2: Array<TraceItem> = [
			{
				event: null,
				eventTimestamp: null,
				logs: [
					{
						timestamp: Date.now(),
						level: 'info',
						message: 'runId2 logs',
					},
				],
				exceptions: [],
				diagnosticsChannelEvents: [],
				scriptName: null,
				outcome: 'ok',
				executionModel: 'standard',
				truncated: false,
				cpuTime: 0,
				wallTime: 0,
			},
		];

		const tailer1 = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId1),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId: runId1 },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		const tailer2 = new LogTailer(
			{
				id: env.LOG_SESSION.idFromName(runId2),
				blockConcurrencyWhile: async (f: () => Promise<void>) => {
					await f();
				},
				storage: { sql: { exec: () => ({ toArray: () => [] }) } },
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: { runId: runId2 },
				exports: {},
			} as any,
			{ LOG_SESSION: env.LOG_SESSION } as any,
		);

		// Tail both to their respective LOG_SESSION instances
		await tailer1.tail(events1);
		await tailer2.tail(events2);

		// Read back from both and verify separation
		const stub1 = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId1));
		const result1 = await stub1.getLogs(100);
		expect(result1.lines).toEqual([
			{
				level: 'info',
				message: 'runId1 logs',
			},
		]);

		const stub2 = env.LOG_SESSION.get(env.LOG_SESSION.idFromName(runId2));
		const result2 = await stub2.getLogs(100);
		expect(result2.lines).toEqual([
			{
				level: 'info',
				message: 'runId2 logs',
			},
		]);
	});
});
