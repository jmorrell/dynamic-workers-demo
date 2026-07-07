import { describe, expect, it } from 'vitest';
import {
	escapeHtml,
	formatResultValue,
	formatRunResponse,
	exampleOptions,
	formatPermissions,
	needsStoreId,
	exampleTabs,
	isTabSetDirty,
	buildCustomRunPayload,
	bytesToBase64,
	buildTraceLayout,
	type Example,
	type TraceSpan,
} from '../../frontend/lib/render';

describe('render helpers', () => {
	describe('escapeHtml', () => {
		it('escapes angle brackets', () => {
			const result = escapeHtml('<script>alert(1)</script>');
			expect(result).not.toContain('<script>');
			expect(result).toContain('&lt;');
			expect(result).toContain('&gt;');
		});

		it('escapes ampersand', () => {
			const result = escapeHtml('foo & bar');
			expect(result).toBe('foo &amp; bar');
		});

		it('escapes double quotes', () => {
			const result = escapeHtml('say "hello"');
			expect(result).toContain('&quot;');
		});

		it('escapes single quotes', () => {
			const result = escapeHtml("it's mine");
			expect(result).toContain('&#39;');
		});

		it('encodes all dangerous characters together', () => {
			const result = escapeHtml('<div onclick="alert(\'xss\')">');
			expect(result).not.toContain('<');
			expect(result).not.toContain('>');
			expect(result).not.toContain('"');
			expect(result).not.toContain("'");
		});

		it('returns unchanged text for safe strings', () => {
			const result = escapeHtml('hello world');
			expect(result).toBe('hello world');
		});
	});

	describe('formatResultValue', () => {
		it('formats objects as JSON', () => {
			const result = formatResultValue({ foo: 'bar', baz: 42 });
			expect(result).toContain('foo');
			expect(result).toContain('bar');
			expect(result).toContain('baz');
			expect(result).toContain('42');
		});

		it('formats arrays as JSON', () => {
			const result = formatResultValue([1, 2, 3]);
			expect(result).toContain('1');
			expect(result).toContain('2');
			expect(result).toContain('3');
		});

		it('formats strings as JSON', () => {
			const result = formatResultValue('hello');
			expect(result).toContain('hello');
		});

		it('formats numbers as JSON', () => {
			const result = formatResultValue(42);
			expect(result).toBe('42');
		});

		it('formats booleans as JSON', () => {
			const result = formatResultValue(true);
			expect(result).toBe('true');
		});

		it('formats null as JSON', () => {
			const result = formatResultValue(null);
			expect(result).toBe('null');
		});

		it('handles non-serializable values with fallback', () => {
			const result = formatResultValue(undefined);
			expect(result).toBe('undefined');
		});
	});

	describe('formatRunResponse', () => {
		it('formats successful response with ok result', () => {
			const response = {
				ok: true,
				result: { value: 42, type: 'number' },
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			expect(formatted.tone).toBe('ok');
			expect(formatted.body).toContain('42');
			expect(formatted.title).toBeTruthy();
		});

		it('formats error response with kind and message', () => {
			const response = {
				ok: false,
				error: { kind: 'ReferenceError', message: 'x is not defined' },
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			expect(formatted.tone).toBe('error');
			expect(formatted.body).toContain('ReferenceError');
			expect(formatted.body).toContain('x is not defined');
		});

		it('preserves the raw result value verbatim (escaping is the renderer textContent job)', () => {
			const response = {
				ok: true,
				result: '<script>alert(1)</script>',
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			// formatRunResponse must NOT pre-escape — main.ts renders via textContent,
			// which makes the raw string inert. Pre-escaping here would double-escape.
			expect(formatted.body).toContain('<script>alert(1)</script>');
		});

		it('preserves the raw error message verbatim', () => {
			const response = {
				ok: false,
				error: { kind: 'Error', message: '<img src=x onerror=alert(1)>' },
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			expect(formatted.body).toContain('<img src=x onerror=alert(1)>');
		});
	});

	describe('exampleOptions', () => {
		it('maps examples to options with id and title', () => {
			const examples = [
				{ id: '1', title: 'Fetch Example', description: 'desc', suggestedUrls: [], source: 'code' },
				{ id: '2', title: 'Timeout Example', description: 'desc', suggestedUrls: [], source: 'code' },
			];
			const options = exampleOptions(examples);
			expect(options).toHaveLength(2);
			expect(options[0]).toEqual({ id: '1', title: 'Fetch Example' });
			expect(options[1]).toEqual({ id: '2', title: 'Timeout Example' });
		});

		it('returns empty array for empty examples', () => {
			const options = exampleOptions([]);
			expect(options).toEqual([]);
		});
	});

	describe('exampleTabs', () => {
		it('returns a single script tab for an example with no modules', () => {
			const example: Example = { id: '1', title: 'x', description: 'd', suggestedUrls: [], source: 'export default () => 1' };
			const tabs = exampleTabs(example);
			expect(tabs).toEqual([{ id: 'script', label: 'transform.ts', kind: 'script', content: 'export default () => 1' }]);
		});

		it('returns a single script tab (empty content) when there is no example', () => {
			const tabs = exampleTabs(undefined);
			expect(tabs).toEqual([{ id: 'script', label: 'transform.ts', kind: 'script', content: '' }]);
		});

		it('appends one tab per module, in order, with empty content when no contents map is supplied', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm' }],
			};
			const tabs = exampleTabs(example);
			expect(tabs).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: 'code' },
				{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: '' },
			]);
		});

		it('uses the supplied contents map, keyed by module name, when provided', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm' }],
			};
			const tabs = exampleTabs(example, new Map([['add.wasm', 'AAAA']]));
			expect(tabs).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: 'code' },
				{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: 'AAAA' },
			]);
		});
	});

	describe('isTabSetDirty', () => {
		const pristine = exampleTabs(
			{
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm' }],
			},
			new Map([['add.wasm', 'AAAA']]),
		);

		it('is dirty when there are no pristine tabs (no example selected)', () => {
			expect(isTabSetDirty([], new Map([['script', 'anything']]))).toBe(true);
		});

		it('is not dirty when every tab matches pristine content', () => {
			const current = new Map([
				['script', 'code'],
				['add.wasm', 'AAAA'],
			]);
			expect(isTabSetDirty(pristine, current)).toBe(false);
		});

		it('is dirty when the script tab differs', () => {
			const current = new Map([
				['script', 'edited'],
				['add.wasm', 'AAAA'],
			]);
			expect(isTabSetDirty(pristine, current)).toBe(true);
		});

		it('is dirty when a module tab differs, even if the script tab matches', () => {
			const current = new Map([
				['script', 'code'],
				['add.wasm', 'BBBB'],
			]);
			expect(isTabSetDirty(pristine, current)).toBe(true);
		});
	});

	describe('buildCustomRunPayload', () => {
		it('omits modules entirely when there are none', () => {
			const tabs = exampleTabs({ id: '1', title: 'x', description: 'd', suggestedUrls: [], source: 'code' });
			const current = new Map([['script', 'edited code']]);
			expect(buildCustomRunPayload(tabs, current)).toEqual({ customCode: 'edited code' });
		});

		it('includes modules with whitespace stripped from base64 text', () => {
			const tabs = exampleTabs(
				{
					id: '1',
					title: 'x',
					description: 'd',
					suggestedUrls: [],
					source: 'code',
					modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm' }],
				},
				new Map([['add.wasm', 'AAAA']]),
			);
			const current = new Map([
				['script', 'edited code'],
				['add.wasm', 'AA AA\nBB\t'],
			]);
			expect(buildCustomRunPayload(tabs, current)).toEqual({
				customCode: 'edited code',
				modules: [{ name: 'add.wasm', kind: 'wasm', base64: 'AAAABB' }],
			});
		});
	});

	describe('bytesToBase64', () => {
		it('matches btoa for a small buffer', () => {
			const bytes = new TextEncoder().encode('hello world');
			expect(bytesToBase64(bytes)).toBe(btoa('hello world'));
		});

		it('returns an empty string for an empty buffer', () => {
			expect(bytesToBase64(new Uint8Array(0))).toBe('');
		});

		it('handles a buffer larger than the chunk size without dropping bytes', () => {
			// Exercises the chunked String.fromCharCode loop (chunk size 0x8000):
			// this buffer spans multiple chunks.
			const bytes = new Uint8Array(0x8000 * 2 + 100);
			for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

			const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
			expect(decoded).toEqual(bytes);
		});
	});

	describe('formatPermissions', () => {
		it('returns null for undefined permissions', () => {
			expect(formatPermissions(undefined)).toBeNull();
		});

		it('returns null for a no-network grant', () => {
			expect(formatPermissions({ fetch: 'none' })).toBeNull();
		});

		it('formats a page-links grant', () => {
			expect(formatPermissions({ fetch: 'page-links' })).toBe('permissions: fetch page-links');
		});

		it('includes a cpu budget when present', () => {
			expect(formatPermissions({ fetch: 'page-links', cpuMs: 500 })).toBe('permissions: fetch page-links · cpu 500ms');
		});

		it('omits the depth segment when fetchDepth is absent', () => {
			expect(formatPermissions({ fetch: 'page-links' })).toBe('permissions: fetch page-links');
		});

		it('omits the depth segment when fetchDepth is 1 (the default)', () => {
			expect(formatPermissions({ fetch: 'page-links', fetchDepth: 1 })).toBe('permissions: fetch page-links');
		});

		it('includes a depth segment when fetchDepth is greater than 1', () => {
			expect(formatPermissions({ fetch: 'page-links', fetchDepth: 2 })).toBe('permissions: fetch page-links · depth 2');
		});

		it('orders depth before cpu when both are present', () => {
			expect(formatPermissions({ fetch: 'page-links', fetchDepth: 2, cpuMs: 500 })).toBe('permissions: fetch page-links · depth 2 · cpu 500ms');
		});

		it('includes a fetches segment when maxFetches is present', () => {
			expect(formatPermissions({ fetch: 'page-links', maxFetches: 6 })).toBe('permissions: fetch page-links · fetches 6');
		});

		it('omits the fetches segment when maxFetches is absent', () => {
			expect(formatPermissions({ fetch: 'page-links', cpuMs: 500 })).toBe('permissions: fetch page-links · cpu 500ms');
		});

		it('orders fetch · depth · fetches · cpu when all are present', () => {
			expect(formatPermissions({ fetch: 'page-links', fetchDepth: 2, maxFetches: 6, cpuMs: 500 })).toBe(
				'permissions: fetch page-links · depth 2 · fetches 6 · cpu 500ms',
			);
		});

		it('returns null for a storage: "none" grant alongside no-network', () => {
			expect(formatPermissions({ fetch: 'none', storage: 'none' })).toBeNull();
		});

		it('renders a storage-only hint for a storage-scoped, no-network grant', () => {
			expect(formatPermissions({ fetch: 'none', storage: 'scoped' })).toBe('permissions: storage scoped');
		});

		it('appends storage scoped after the fetch segments', () => {
			expect(formatPermissions({ fetch: 'page-links', cpuMs: 500, storage: 'scoped' })).toBe(
				'permissions: fetch page-links · cpu 500ms · storage scoped',
			);
		});
	});

	describe('needsStoreId', () => {
		it('is false for undefined permissions', () => {
			expect(needsStoreId(undefined)).toBe(false);
		});

		it('is false for a no-storage grant', () => {
			expect(needsStoreId({ fetch: 'none' })).toBe(false);
		});

		it('is false for an explicit storage: "none" grant', () => {
			expect(needsStoreId({ fetch: 'none', storage: 'none' })).toBe(false);
		});

		it('is true for a storage: "scoped" grant', () => {
			expect(needsStoreId({ fetch: 'none', storage: 'scoped' })).toBe(true);
		});
	});

	describe('buildTraceLayout', () => {
		function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, 'spanId'>): TraceSpan {
			return {
				traceId: 't1',
				parentSpanId: undefined,
				startMs: 0,
				durMs: 0,
				status: 'ok',
				attrs: {},
				...overrides,
			};
		}

		it('computes nesting depth from the parentSpanId chain', () => {
			const spans: Array<TraceSpan> = [
				span({ spanId: 's1', attrs: { name: 'run' } }),
				span({ spanId: 's2', parentSpanId: 's1', attrs: { name: 'loader' } }),
				span({ spanId: 's3', parentSpanId: 's2', attrs: { name: 'env.fetch', kind: 'gate_fetch' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows.map((r) => r.depthLevel)).toEqual([0, 1, 2]);
		});

		it('treats a missing/unresolvable parent as root (depth 0)', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', parentSpanId: 'ghost', attrs: { name: 'orphan' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].depthLevel).toBe(0);
		});

		it('converts startMs/durMs to percentages of totalMs', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', startMs: 25, durMs: 50, attrs: { name: 'target_fetch' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].leftPct).toBe(25);
			expect(rows[0].widthPct).toBe(50);
		});

		it('clamps a span that overruns totalMs so left + width never exceeds 100', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', startMs: 90, durMs: 40, attrs: { name: 'loader' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].leftPct).toBe(90);
			expect(rows[0].leftPct + rows[0].widthPct).toBeLessThanOrEqual(100);
		});

		it('enforces a minimum visible width for a ~0ms span', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', startMs: 10, durMs: 0, attrs: { name: 'logs_read' } })];
			const rows = buildTraceLayout(spans, 1000);
			expect(rows[0].widthPct).toBeGreaterThan(0);
		});

		it('guards totalMs <= 0 by treating it as 1 rather than dividing by zero', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', startMs: 0, durMs: 0, attrs: { name: 'run' } })];
			const rows = buildTraceLayout(spans, 0);
			expect(Number.isFinite(rows[0].leftPct)).toBe(true);
			expect(Number.isFinite(rows[0].widthPct)).toBe(true);
		});

		it('tones a denied gate span as error even though its kind starts with gate_', () => {
			const spans: Array<TraceSpan> = [
				span({ spanId: 's1', status: 'error', attrs: { name: 'env.fetch', kind: 'gate_fetch', denied: 'not_allowlisted' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('error');
		});

		it('tones a successful gate span as ok', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', status: 'ok', attrs: { name: 'env.fetch', kind: 'gate_fetch' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('ok');
		});

		it('tones a host phase/root span as phase', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', status: 'ok', attrs: { name: 'run' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('phase');
		});

		it('labels a gate span with the name plus the url tail, keeping the full url in detail', () => {
			const spans: Array<TraceSpan> = [
				span({ spanId: 's1', attrs: { name: 'env.fetch', kind: 'gate_fetch', url: 'https://example.com/articles/foo' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].label).toBe('env.fetch foo');
			expect(rows[0].detail).toContain('https://example.com/articles/foo');
		});

		it('falls back to spanId for the label when attrs.name is absent', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's7', attrs: {} })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].label).toBe('s7');
		});

		it('includes a human-readable timing line in detail', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', startMs: 3, durMs: 12, attrs: { name: 'target_fetch' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].detail).toContain('12ms at +3ms');
		});

		it('preserves row order matching the given span order', () => {
			const spans: Array<TraceSpan> = [
				span({ spanId: 's1', attrs: { name: 'run' } }),
				span({ spanId: 's2', parentSpanId: 's1', attrs: { name: 'target_fetch' } }),
				span({ spanId: 's3', parentSpanId: 's1', attrs: { name: 'loader' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows.map((r) => r.label)).toEqual(['run', 'target_fetch', 'loader']);
		});
	});
});
