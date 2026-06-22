import { describe, it, expect } from 'vitest';
import { appendWithCap } from '@/runtime/log-cap';
import { LOG_MAX_LINES, LOG_MAX_BYTES } from '@/runtime/log-types';
import type { LogLine, LogBundle } from '@/runtime/log-types';

describe('appendWithCap', () => {
	it('returns unchanged current bundle when incoming is empty', () => {
		const current: LogBundle = {
			lines: [{ level: 'info', message: 'hello' }],
			truncated: false,
		};
		const result = appendWithCap(current, [], LOG_MAX_LINES, LOG_MAX_BYTES);
		expect(result).toEqual(current);
	});

	it('appends all incoming lines when under both caps', () => {
		const current: LogBundle = { lines: [], truncated: false };
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'line1' },
			{ level: 'warn', message: 'line2' },
		];
		const result = appendWithCap(current, incoming, LOG_MAX_LINES, LOG_MAX_BYTES);
		expect(result.lines).toEqual(incoming);
		expect(result.truncated).toBe(false);
	});

	it('respects the line count cap', () => {
		const current: LogBundle = {
			lines: [{ level: 'info', message: 'line1' }],
			truncated: false,
		};
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'line2' },
			{ level: 'info', message: 'line3' },
			{ level: 'info', message: 'line4' },
		];
		const maxLines = 3;
		const result = appendWithCap(current, incoming, maxLines, LOG_MAX_BYTES);
		expect(result.lines.length).toBe(3);
		expect(result.truncated).toBe(true);
		expect(result.lines[0].message).toBe('line1');
		expect(result.lines[1].message).toBe('line2');
		expect(result.lines[2].message).toBe('line3');
	});

	it('respects the byte count cap', () => {
		const current: LogBundle = { lines: [], truncated: false };
		// Each line is approximately: "message" + overhead
		// "hello" = 5 bytes in UTF-8
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'hello' }, // 5 bytes
			{ level: 'info', message: 'world' }, // 5 bytes
			{ level: 'info', message: 'test' }, // 4 bytes
		];
		const maxBytes = 12; // Should fit first 2 lines (10 bytes), not 3 (14 bytes)
		const result = appendWithCap(current, incoming, LOG_MAX_LINES, maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.lines.length).toBe(2);
		expect(result.lines.map((l) => l.message)).toEqual(['hello', 'world']);
	});

	it('handles UTF-8 multibyte characters in byte count', () => {
		const current: LogBundle = { lines: [], truncated: false };
		// "café" = 5 bytes in UTF-8 (é = 2 bytes)
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'café' }, // 5 bytes
			{ level: 'info', message: 'naïve' }, // 6 bytes
		];
		const maxBytes = 10; // Should fit first line, not second
		const result = appendWithCap(current, incoming, LOG_MAX_LINES, maxBytes);
		expect(result.truncated).toBe(true);
		expect(result.lines.length).toBe(1);
		expect(result.lines[0].message).toBe('café');
	});

	it('handles mixed current and incoming lines respecting both caps', () => {
		const current: LogBundle = {
			lines: [{ level: 'info', message: 'start' }],
			truncated: false,
		};
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'a' },
			{ level: 'info', message: 'b' },
			{ level: 'info', message: 'c' },
		];
		const maxLines = 3;
		const maxBytes = 10;
		const result = appendWithCap(current, incoming, maxLines, maxBytes);
		expect(result.lines.length).toBeLessThanOrEqual(3);
		expect(result.truncated).toBe(true);
	});

	it('sets truncated to false when no cap is exceeded', () => {
		const current: LogBundle = { lines: [], truncated: false };
		const incoming: Array<LogLine> = [{ level: 'info', message: 'test' }];
		const result = appendWithCap(current, incoming, 100, 10000);
		expect(result.truncated).toBe(false);
	});

	it('returns empty bundle with truncated false for empty current and empty incoming', () => {
		const current: LogBundle = { lines: [], truncated: false };
		const result = appendWithCap(current, [], LOG_MAX_LINES, LOG_MAX_BYTES);
		expect(result).toEqual({ lines: [], truncated: false });
	});

	it('preserves truncated flag from current when already truncated', () => {
		const current: LogBundle = {
			lines: [{ level: 'info', message: 'line1' }],
			truncated: true,
		};
		const incoming: Array<LogLine> = [{ level: 'info', message: 'line2' }];
		const result = appendWithCap(current, incoming, LOG_MAX_LINES, LOG_MAX_BYTES);
		expect(result.truncated).toBe(true);
	});

	it('stops appending as soon as a cap is exceeded', () => {
		const current: LogBundle = { lines: [], truncated: false };
		const incoming: Array<LogLine> = [
			{ level: 'info', message: 'a' },
			{ level: 'info', message: 'b' },
			{ level: 'info', message: 'c' },
		];
		const maxLines = 2;
		const result = appendWithCap(current, incoming, maxLines, LOG_MAX_BYTES);
		expect(result.lines.length).toBe(2);
		expect(result.lines.map((l) => l.message)).toEqual(['a', 'b']);
	});
});
