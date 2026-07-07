import { describe, it, expect } from 'vitest';
import { EXAMPLES, listExamples, getExample } from '../../src/examples/manifest';

describe('manifest', () => {
	describe('EXAMPLES', () => {
		it('contains all twelve examples', () => {
			expect(EXAMPLES).toHaveLength(12);
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
			expect(ids).toContain('feed-watcher');
			expect(ids).toContain('arxiv-digest');
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
			expect(examples).toHaveLength(12);

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
			expect(wasmAdd?.modules?.[0]).toEqual({ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/wasm-add/add.wasm' });
		});

		it('dedupes identical module binaries shared across examples (arxiv-digest reuses arxiv-pdf\'s liteparse.wasm asset)', () => {
			const examples = listExamples();
			const arxivPdf = examples.find((e) => e.id === 'arxiv-pdf');
			const arxivDigest = examples.find((e) => e.id === 'arxiv-digest');
			expect(arxivPdf?.modules?.[0]?.assetPath).toBeTruthy();
			expect(arxivDigest?.modules?.[0]?.assetPath).toBe(arxivPdf?.modules?.[0]?.assetPath);
		});

		it('never includes module base64 for any listed example (bytes are static assets)', () => {
			const examples = listExamples();
			for (const example of examples) {
				for (const module of example.modules ?? []) {
					expect('base64' in module).toBe(false);
					expect(module.assetPath).toMatch(/^\/modules\//);
				}
			}
		});
	});

	describe('permissions round-trip', () => {
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
			expect(example?.modules?.[0]).toEqual({ name: 'add.wasm', kind: 'wasm', assetPath: '/modules/wasm-add/add.wasm' });
		});
	});
});
