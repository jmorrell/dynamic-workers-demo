import { describe, expect, it } from 'vitest';
import {
	escapeHtml,
	formatResultValue,
	formatRunResponse,
	exampleOptions,
	formatPermissions,
	exampleTabs,
	isTabSetDirty,
	buildCustomRunPayload,
	type Example,
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

		it('appends one tab per module, in order', () => {
			const example: Example = {
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', base64: 'AAAA' }],
			};
			const tabs = exampleTabs(example);
			expect(tabs).toEqual([
				{ id: 'script', label: 'transform.ts', kind: 'script', content: 'code' },
				{ id: 'add.wasm', label: 'add.wasm', kind: 'wasm', content: 'AAAA' },
			]);
		});
	});

	describe('isTabSetDirty', () => {
		const pristine = exampleTabs({
			id: '1',
			title: 'x',
			description: 'd',
			suggestedUrls: [],
			source: 'code',
			modules: [{ name: 'add.wasm', kind: 'wasm', base64: 'AAAA' }],
		});

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
			const tabs = exampleTabs({
				id: '1',
				title: 'x',
				description: 'd',
				suggestedUrls: [],
				source: 'code',
				modules: [{ name: 'add.wasm', kind: 'wasm', base64: 'AAAA' }],
			});
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
	});
});
