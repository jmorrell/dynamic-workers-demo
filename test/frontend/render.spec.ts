import { describe, expect, it } from 'vitest';
import {
	escapeHtml,
	formatResultValue,
	formatRunResponse,
	exampleOptions,
	permissionBadges,
	needsStoreId,
	exampleTabs,
	isTabSetDirty,
	buildCustomRunPayload,
	bytesToBase64,
	buildTraceLayout,
	buildTraceAxisTicks,
	formatTraceDuration,
	tabStripItems,
	LLM_PROMPT,
	orderExamplesForPlayground,
	type Example,
	type EditorTab,
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
		it('shows only the json value when a result also contains markdown', () => {
			const response = {
				ok: true,
				result: {
					markdown: '# A very long rendered document',
					json: { title: 'Document title', wordCount: 42 },
				},
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			expect(formatted.body).toContain('Document title');
			expect(formatted.body).toContain('wordCount');
			expect(formatted.body).not.toContain('markdown');
			expect(formatted.body).not.toContain('very long rendered document');
		});

		it('preserves direct-value results that do not have a json field', () => {
			const response = {
				ok: true,
				result: { markdown: '# Legacy result', title: 'Still visible' },
				logs: [],
				logsTruncated: false,
				timingMs: 100,
				inputTruncated: false,
			};
			const formatted = formatRunResponse(response);
			expect(formatted.body).toContain('Legacy result');
			expect(formatted.body).toContain('Still visible');
		});

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

	describe('orderExamplesForPlayground', () => {
		const example = (id: string): Example => ({ id, title: id, description: id, suggestedUrls: [], source: 'code' });

		it('leads with the showcase examples and retains every example', () => {
			const ordered = orderExamplesForPlayground([
				example('markdown'),
				example('cpu-spin'),
				example('arxiv-digest'),
				example('arxiv-pdf'),
				example('image-hash'),
			]);
			expect(ordered.map((item) => item.id)).toEqual(['arxiv-pdf', 'arxiv-digest', 'image-hash', 'markdown', 'cpu-spin']);
		});

		it('appends unknown future examples in their registry order', () => {
			const ordered = orderExamplesForPlayground([example('future-b'), example('opengraph'), example('future-a')]);
			expect(ordered.map((item) => item.id)).toEqual(['opengraph', 'future-b', 'future-a']);
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

		it('appends one tab per module, using the wasm preview before the full module loads', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm', previewBase64: 'PREVIEW', byteSize: 2048 }],
			};
			const tabs = exampleTabs(example);
			expect(tabs).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: 'code' },
				{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: 'PREVIEW' },
			]);
		});

		it('uses the supplied contents map, keyed by module name, when provided', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm', previewBase64: 'PREVIEW', byteSize: 2048 }],
			};
			const tabs = exampleTabs(example, new Map([['add.wasm', 'AAAA']]));
			expect(tabs).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: 'code' },
				{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: 'AAAA' },
			]);
		});

		it('shows JavaScript support modules as source tabs', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: "import './polyfill';",
				modules: [{ name: 'polyfill', label: 'polyfill.ts', kind: 'js', source: 'globalThis.ready = true;' }],
			};
			expect(exampleTabs(example)).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: "import './polyfill';" },
				{ id: 'polyfill', label: 'polyfill.ts', kind: 'script', content: 'globalThis.ready = true;' },
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
				modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm', previewBase64: 'PREVIEW', byteSize: 2048 }],
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
					modules: [{ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/x/add.wasm', previewBase64: 'PREVIEW', byteSize: 2048 }],
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

		it('includes edited JavaScript support modules as source', () => {
			const tabs = exampleTabs({
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: "import './polyfill';",
				modules: [{ name: 'polyfill', kind: 'js', source: 'original' }],
			});
			const current = new Map([
				['script', "import './polyfill';"],
				['polyfill', 'edited'],
			]);
			expect(buildCustomRunPayload(tabs, current)).toEqual({
				customCode: "import './polyfill';",
				modules: [{ name: 'polyfill', kind: 'js', source: 'edited' }],
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

	describe('permissionBadges', () => {
		// Compact projection so tests read at the label/tone level; `detail`
		// tooltips are copy, asserted only where the number they embed matters.
		function labels(badges: ReturnType<typeof permissionBadges>): Array<string> {
			return badges.map((b) => `${b.tone}:${b.label}`);
		}

		it('renders the sandboxed-default badge for undefined permissions', () => {
			expect(labels(permissionBadges(undefined))).toEqual(['none:no network access']);
		});

		it('renders the sandboxed-default badge for a no-network grant', () => {
			expect(labels(permissionBadges({ fetch: 'none' }))).toEqual(['none:no network access']);
		});

		it('renders a network badge for a page-links grant', () => {
			expect(labels(permissionBadges({ fetch: 'page-links' }))).toEqual(['net:network: page links']);
		});

		it('includes a cpu badge when present', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', cpuMs: 500 }))).toEqual(['net:network: page links', 'limit:cpu 500ms']);
		});

		it('omits the depth badge when fetchDepth is 1 (the default)', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', fetchDepth: 1 }))).toEqual(['net:network: page links']);
		});

		it('includes a depth badge when fetchDepth is greater than 1', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', fetchDepth: 2 }))).toEqual(['net:network: page links', 'limit:link depth 2']);
		});

		it('phrases the depth tooltip in hops beyond the original page', () => {
			const badge = permissionBadges({ fetch: 'page-links', fetchDepth: 3 }).find((b) => b.label === 'link depth 3');
			expect(badge?.detail).toContain('2 hop(s)');
		});

		it('includes a max-reads badge when maxFetches is present', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', maxFetches: 6 }))).toEqual(['net:network: page links', 'limit:max 6 reads']);
		});

		it('orders network · depth · fetches · cpu when all are present', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', fetchDepth: 2, maxFetches: 6, cpuMs: 500 }))).toEqual([
				'net:network: page links',
				'limit:link depth 2',
				'limit:max 6 reads',
				'limit:cpu 500ms',
			]);
		});

		it('gates the limit badges on a network grant', () => {
			expect(labels(permissionBadges({ fetch: 'none', cpuMs: 500, maxFetches: 6, fetchDepth: 2 }))).toEqual(['none:no network access']);
		});

		it('renders the sandboxed-default badge for a storage: "none" grant alongside no-network', () => {
			expect(labels(permissionBadges({ fetch: 'none', storage: 'none' }))).toEqual(['none:no network access']);
		});

		it('adds a storage badge alongside the sandboxed default for a storage-only grant', () => {
			expect(labels(permissionBadges({ fetch: 'none', storage: 'scoped' }))).toEqual(['none:no network access', 'storage:storage: scoped']);
		});

		it('appends the storage badge after the network badges', () => {
			expect(labels(permissionBadges({ fetch: 'page-links', cpuMs: 500, storage: 'scoped' }))).toEqual([
				'net:network: page links',
				'limit:cpu 500ms',
				'storage:storage: scoped',
			]);
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
				span({ spanId: 's3', parentSpanId: 's2', attrs: { name: 'resource.read', kind: 'gate_resource_read' } }),
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
				span({ spanId: 's1', status: 'error', attrs: { name: 'resource.read', kind: 'gate_resource_read', denied: 'unknown capability' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('error');
		});

		it('tones a successful gate span as ok', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', status: 'ok', attrs: { name: 'resource.read', kind: 'gate_resource_read' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('ok');
		});

		it('tones a host phase/root span as phase', () => {
			const spans: Array<TraceSpan> = [span({ spanId: 's1', status: 'ok', attrs: { name: 'run' } })];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].tone).toBe('phase');
		});

		it('humanizes a resource span and labels it with a readable path, keeping the full URL in detail', () => {
			const spans: Array<TraceSpan> = [
				span({ spanId: 's1', attrs: { name: 'resource.read', kind: 'gate_resource_read', url: 'https://example.com/articles/foo' } }),
			];
			const rows = buildTraceLayout(spans, 100);
			expect(rows[0].label).toBe('Read /articles/foo');
			expect(rows[0].detail).toContain('https://example.com/articles/foo');
		});

		it('formats a compact duration label for every row', () => {
			const rows = buildTraceLayout([span({ spanId: 's1', durMs: 1250, attrs: { name: 'run' } })], 1250);
			expect(rows[0].durationLabel).toBe('1.25 s');
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
			expect(rows.map((r) => r.label)).toEqual(['Run', 'Fetch input', 'Run worker']);
		});
	});

	describe('trace time labels', () => {
		it('formats sub-second and second durations compactly', () => {
			expect(formatTraceDuration(0)).toBe('0 ms');
			expect(formatTraceDuration(42)).toBe('42 ms');
			expect(formatTraceDuration(1250)).toBe('1.25 s');
		});

		it('builds a five-tick axis spanning the full trace duration', () => {
			const ticks = buildTraceAxisTicks(1000);
			expect(ticks.map((tick) => tick.leftPct)).toEqual([0, 25, 50, 75, 100]);
			expect(ticks.map((tick) => tick.label)).toEqual(['0 ms', '250 ms', '500 ms', '750 ms', '1.00 s']);
			expect(ticks.map((tick) => tick.align)).toEqual(['start', 'middle', 'middle', 'middle', 'end']);
		});
	});

	describe('tabStripItems', () => {
		const sourceTabs: Array<EditorTab> = [
			{ id: 'script', label: 'transform.ts', kind: 'script', content: '' },
			{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: '' },
		];

		// Compact projection so the assertions read at the id/kind/active level.
		function shape(items: ReturnType<typeof tabStripItems>): Array<string> {
			return items.map((i) => `${i.kind}:${i.id}${i.active ? '*' : ''}`);
		}

		it('renders only the source tabs before any run, active = the active source tab', () => {
			const items = tabStripItems(sourceTabs, 'script', null, { hasRun: false, hasTrace: false });
			expect(shape(items)).toEqual(['source:script*', 'source:add.wasm']);
		});

		it('ignores hasTrace before a run', () => {
			const items = tabStripItems(sourceTabs, 'script', null, { hasRun: false, hasTrace: true });
			expect(shape(items)).toEqual(['source:script*', 'source:add.wasm']);
		});

		it('can show the LLM prompt before a run', () => {
			const items = tabStripItems(sourceTabs, 'script', null, { hasRun: false, hasTrace: false, hasPrompt: true });
			expect(shape(items)).toEqual(['source:script*', 'source:add.wasm', 'result:prompt']);
		});

		it('keeps the prompt before run result tabs', () => {
			const items = tabStripItems(sourceTabs, 'script', 'prompt', { hasRun: true, hasTrace: true, hasPrompt: true });
			expect(shape(items)).toEqual([
				'source:script',
				'source:add.wasm',
				'result:prompt*',
				'result:output',
				'result:logs',
				'result:trace',
			]);
		});

		it('appends Output and Logs once a run exists, keeping the source tab active', () => {
			const items = tabStripItems(sourceTabs, 'script', null, { hasRun: true, hasTrace: false });
			expect(shape(items)).toEqual(['source:script*', 'source:add.wasm', 'result:output', 'result:logs']);
		});

		it('gates the Trace tab on hasTrace', () => {
			const items = tabStripItems(sourceTabs, 'script', null, { hasRun: true, hasTrace: true });
			expect(shape(items)).toEqual(['source:script*', 'source:add.wasm', 'result:output', 'result:logs', 'result:trace']);
		});

		it('activates the given result tab and leaves every source item inactive', () => {
			const items = tabStripItems(sourceTabs, 'script', 'output', { hasRun: true, hasTrace: true });
			expect(shape(items)).toEqual(['source:script', 'source:add.wasm', 'result:output*', 'result:logs', 'result:trace']);
		});

		it('activates the Trace result tab when it is the active result tab', () => {
			const items = tabStripItems(sourceTabs, 'add.wasm', 'trace', { hasRun: true, hasTrace: true });
			expect(shape(items)).toEqual(['source:script', 'source:add.wasm', 'result:output', 'result:logs', 'result:trace*']);
		});

		it('activates the active source tab (not any result tab) when no result tab is selected', () => {
			const items = tabStripItems(sourceTabs, 'add.wasm', null, { hasRun: true, hasTrace: true });
			expect(shape(items)).toEqual(['source:script', 'source:add.wasm*', 'result:output', 'result:logs', 'result:trace']);
		});
	});

	describe('LLM_PROMPT', () => {
		it('contains the transform contract, capabilities, and important limits', () => {
			expect(LLM_PROMPT).toContain('ask me what I want to build and wait for my answer');
			expect(LLM_PROMPT).toContain('Do not write any code until I have supplied that direction');
			expect(LLM_PROMPT).toContain("import type { RunInput, TransformEnv } from '../runtime/types'");
			expect(LLM_PROMPT).toContain('type TransformEnv');
			expect(LLM_PROMPT).toContain('type ResourceCapability');
			expect(LLM_PROMPT).toContain('type Database');
			expect(LLM_PROMPT).toContain('Never call global fetch()');
			expect(LLM_PROMPT).toContain('at most 2 link levels and 6 reads');
			expect(LLM_PROMPT).toContain('capped at 128 KiB');
		});
	});
});
