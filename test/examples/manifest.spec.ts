import { describe, it, expect } from 'vitest';
import { EXAMPLES, listExamples, getExample } from '../../src/examples/manifest';
import { ASSET_PREFIX } from '../../src/paths';

describe('manifest', () => {
	describe('EXAMPLES', () => {
		it('contains all thirteen examples', () => {
			expect(EXAMPLES).toHaveLength(13);
		});

		it('has required ids', () => {
			const ids = EXAMPLES.map((e) => e.id);
			expect(ids).toContain('markdown');
			expect(ids).toContain('opengraph');
			expect(ids).toContain('hackernews');
			expect(ids).toContain('rss-digest');
			expect(ids).toContain('cpu-spin');
			expect(ids).toContain('blocked-fetch');
			expect(ids).toContain('wasm-add');
			expect(ids).toContain('image-hash');
			expect(ids).toContain('github-repo');
			expect(ids).toContain('arxiv-pdf');
			expect(ids).toContain('url-history');
			expect(ids).toContain('arxiv-digest');
			expect(ids).toContain('write-your-own');
		});

		it('each example has non-empty code string', () => {
			for (const example of EXAMPLES) {
				expect(example.code).toBeTruthy();
				expect(example.code.length).toBeGreaterThan(0);
			}
		});

		it('markdown code is substantially larger than source (deps inlined)', () => {
			const markdown = EXAMPLES.find((e) => e.id === 'markdown');
			expect(markdown).toBeDefined();
			if (markdown) {
				expect(markdown.code.length).toBeGreaterThan(markdown.source.length);
			}
		});
	});

	describe('listExamples()', () => {
		it('returns all examples without code field', () => {
			const examples = listExamples();
			expect(examples).toHaveLength(13);

			for (const example of examples) {
				expect('code' in example).toBe(false);
				expect(example.id).toBeTruthy();
				expect(example.title).toBeTruthy();
				expect(example.description).toBeTruthy();
				expect(Array.isArray(example.suggestedUrls)).toBe(true);
				expect(example.source).toBeTruthy();
			}
		});

		it('includes the wasm-add example with its module assetPath', () => {
			const examples = listExamples();
			const wasmAdd = examples.find((e) => e.id === 'wasm-add');
			expect(wasmAdd).toBeDefined();
			expect(wasmAdd?.modules).toHaveLength(1);
			expect(wasmAdd?.modules?.[0]).toEqual(
				expect.objectContaining({
					name: 'add.wasm',
					kind: 'wasm',
					assetPath: `${ASSET_PREFIX}/modules/wasm-add/add.wasm`,
					byteSize: 41,
				}),
			);
			expect(wasmAdd?.modules?.[0]?.previewBase64).toHaveLength(56);
		});

		it('includes the markdown DOM polyfill as a source tab', () => {
			const markdown = listExamples().find((e) => e.id === 'markdown');
			expect(markdown?.modules?.[0]).toEqual(
				expect.objectContaining({
					name: 'markdown-dom-polyfill',
					label: 'markdown-dom-polyfill.ts',
					kind: 'js',
				}),
			);
			expect(markdown?.modules?.[0]?.source).toContain("import { parseHTML, DOMParser } from 'linkedom';");
		});

		it('dedupes identical module binaries shared across examples (arxiv-digest reuses arxiv-pdf\'s liteparse.wasm asset)', () => {
			const examples = listExamples();
			const arxivPdf = examples.find((e) => e.id === 'arxiv-pdf');
			const arxivDigest = examples.find((e) => e.id === 'arxiv-digest');
			expect(arxivPdf?.modules?.[0]?.assetPath).toBeTruthy();
			expect(arxivDigest?.modules?.[0]?.assetPath).toBe(arxivPdf?.modules?.[0]?.assetPath);
		});

		it('includes only a 1.5 KiB preview of wasm modules in the listing', () => {
			const examples = listExamples();
			for (const example of examples) {
				for (const module of example.modules ?? []) {
					expect('base64' in module).toBe(false);
					if (module.kind === 'wasm') {
						expect(module.assetPath).toMatch(new RegExp(`^${ASSET_PREFIX}/modules/`));
						expect(atob(module.previewBase64).length).toBeLessThanOrEqual(1536);
					}
				}
			}
		});
	});

	describe('permissions round-trip', () => {
		it('gives write-your-own the complete capability set used by its prompt', () => {
			const example = listExamples().find((e) => e.id === 'write-your-own');
			expect(example?.permissions).toEqual({
				fetch: 'page-links',
				fetchDepth: 2,
				maxFetches: 6,
				cpuMs: 5000,
				storage: 'scoped',
			});
		});

		it('exposes fetchDepth and maxFetches on arxiv-digest in the listing', () => {
			const examples = listExamples();
			const arxivDigest = examples.find((e) => e.id === 'arxiv-digest');
			expect(arxivDigest?.permissions).toEqual({ fetch: 'page-links', fetchDepth: 2, maxFetches: 6, cpuMs: 5000 });
		});

		it('exposes maxFetches on rss-digest in the listing', () => {
			const examples = listExamples();
			const rssDigest = examples.find((e) => e.id === 'rss-digest');
			expect(rssDigest?.permissions).toEqual({ fetch: 'page-links', maxFetches: 6, cpuMs: 5000 });
		});
	});

	describe('getExample()', () => {
		it('returns example by id', () => {
			const example = getExample('opengraph');
			expect(example).toBeDefined();
			expect(example?.id).toBe('opengraph');
			expect(example?.title).toBe('OpenGraph Tags');
			expect(example?.code).toBeTruthy();
		});

		it('returns undefined for unknown id', () => {
			const example = getExample('nonexistent');
			expect(example).toBeUndefined();
		});

		it('exposes the same assetPath as listExamples() for wasm-add (no separate server-only shape)', () => {
			const example = getExample('wasm-add');
			expect(example?.modules).toHaveLength(1);
			expect(example?.modules?.[0]).toEqual(
				expect.objectContaining({
					name: 'add.wasm',
					kind: 'wasm',
					assetPath: `${ASSET_PREFIX}/modules/wasm-add/add.wasm`,
				}),
			);
		});
	});
});
