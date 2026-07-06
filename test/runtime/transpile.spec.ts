import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { transpileUserCode, selectReferencedDeps } from '../../src/runtime/transpile';
import { runInLoader } from '../../src/runtime/loader';
import type { RunInput } from '../../src/runtime/types';

describe('transpileUserCode', () => {
	it('strips type annotations from function parameters and return types', () => {
		const source = 'export default (input: { url: string }): string => input.url;';

		const result = transpileUserCode(source);

		expect(result.type).toBe('success');
		if (result.type === 'success') {
			expect(result.code).not.toContain(': string');
			expect(result.code).not.toContain(': { url: string }');
		}
	});

	it('strips type-only imports', () => {
		const source = "import type { RunInput } from '../runtime/types';\nexport default (input: RunInput) => input.url;";

		const result = transpileUserCode(source);

		expect(result.type).toBe('success');
		if (result.type === 'success') {
			// The type-only import is erased entirely by sucrase's TS transform.
			expect(result.code).not.toContain('import type');
			expect(result.code).not.toContain("from '../runtime/types'");
		}
	});

	it('passes plain JavaScript through unchanged in behavior', () => {
		const source = 'export default (input) => input.status;';

		const result = transpileUserCode(source);

		expect(result.type).toBe('success');
		if (result.type === 'success') {
			expect(result.code).toContain('export default');
		}
	});

	it('returns compile_failed on invalid syntax', () => {
		const source = 'export default (input) => { const x = ; }';

		const result = transpileUserCode(source);

		expect(result.type).toBe('failure');
		if (result.type === 'failure') {
			expect(result.error.kind).toBe('compile_failed');
			expect(result.error.message.length).toBeGreaterThan(0);
		}
	});

	describe('integration: transpiled TS actually runs via runInLoader', () => {
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

		it('runs a transpiled TS transform end-to-end', async () => {
			const source = `
				type Input = { status: number };
				interface Result { doubled: number }
				export default (input: Input): Result => ({ doubled: input.status * 2 });
			`;

			const transpiled = transpileUserCode(source);
			expect(transpiled.type).toBe('success');
			if (transpiled.type !== 'success') return;

			const result = await runInLoader(env, testInput, transpiled.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ doubled: 400 });
			}
		});
	});
});

describe('selectReferencedDeps', () => {
	const deps = [
		{ specifier: 'linkedom', entry: 'linkedom' },
		{ specifier: 'defuddle/node', entry: 'defuddle/node' },
		{ specifier: 'markdown-dom-polyfill', entry: 'src/examples/markdown-dom-polyfill.ts' },
	];

	it('picks only deps referenced by the code', () => {
		const code = "import { parseHTML } from 'linkedom';\nexport default (input) => input.status;";

		const selected = selectReferencedDeps(code, deps);

		expect(selected).toEqual([{ specifier: 'linkedom', entry: 'linkedom' }]);
	});

	it('picks multiple referenced deps, in registry order', () => {
		const code = "import './markdown-dom-polyfill';\nimport { parseHTML } from 'linkedom';\nimport { Defuddle } from 'defuddle/node';\n";

		const selected = selectReferencedDeps(code, deps);

		expect(selected.map((d) => d.specifier)).toEqual(['linkedom', 'defuddle/node', 'markdown-dom-polyfill']);
	});

	it('returns an empty array when no deps are referenced', () => {
		const code = 'export default (input) => input.status;';

		const selected = selectReferencedDeps(code, deps);

		expect(selected).toEqual([]);
	});
});
