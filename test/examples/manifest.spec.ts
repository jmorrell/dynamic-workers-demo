import { describe, it, expect } from 'vitest';
import { EXAMPLES, listExamples, getExample } from '../../src/examples/manifest';

describe('manifest', () => {
	describe('EXAMPLES', () => {
		it('contains all six examples', () => {
			expect(EXAMPLES).toHaveLength(6);
		});

		it('has required ids', () => {
			const ids = EXAMPLES.map((e) => e.id);
			expect(ids).toContain('markdown');
			expect(ids).toContain('opengraph');
			expect(ids).toContain('reddit');
			expect(ids).toContain('hackernews');
			expect(ids).toContain('cpu-spin');
			expect(ids).toContain('blocked-fetch');
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
			expect(examples).toHaveLength(6);

			for (const example of examples) {
				expect('code' in example).toBe(false);
				expect(example.id).toBeTruthy();
				expect(example.title).toBeTruthy();
				expect(example.description).toBeTruthy();
				expect(Array.isArray(example.suggestedUrls)).toBe(true);
				expect(example.source).toBeTruthy();
			}
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
	});
});
