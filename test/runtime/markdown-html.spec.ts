import { describe, it, expect } from 'vitest';
import { extractMarkdown, renderMarkdownDocument, MARKDOWN_RENDER_LIMIT } from '../../src/runtime/markdown-html';

describe('extractMarkdown', () => {
	it('returns the markdown string from a plain object', () => {
		expect(extractMarkdown({ markdown: '# hi' })).toBe('# hi');
	});

	it('returns the markdown string when extra keys are present', () => {
		expect(extractMarkdown({ markdown: '# hi', extra: 1 })).toBe('# hi');
	});

	it('returns null when markdown key is missing', () => {
		expect(extractMarkdown({})).toBeNull();
	});

	it('returns null when markdown is not a string', () => {
		expect(extractMarkdown({ markdown: 42 })).toBeNull();
	});

	it('returns null for null', () => {
		expect(extractMarkdown(null)).toBeNull();
	});

	it('returns null for a string', () => {
		expect(extractMarkdown('str')).toBeNull();
	});

	it('returns null for a number', () => {
		expect(extractMarkdown(7)).toBeNull();
	});

	it('returns null for an array', () => {
		expect(extractMarkdown(['a'])).toBeNull();
	});

	it('returns null for an array containing a markdown-shaped object', () => {
		expect(extractMarkdown([{ markdown: 'x' }])).toBeNull();
	});
});

describe('renderMarkdownDocument', () => {
	describe('XSS pins (micromark defaults: allowDangerousHtml/allowDangerousProtocol off)', () => {
		it('escapes raw script tags to inert text', () => {
			const html = renderMarkdownDocument('<script>alert(1)</script>');
			expect(html).not.toContain('<script>alert');
			expect(html).toContain('&lt;script&gt;');
		});

		it('strips javascript: link protocols', () => {
			const html = renderMarkdownDocument('[x](javascript:alert(1))');
			expect(html).not.toContain('javascript:');
		});

		it('escapes raw img tags with event handlers to inert text', () => {
			// micromark escapes the whole raw tag to text, so the literal word
			// "onerror" still appears in the output — but only as inert text, never
			// as a real attribute on a real element: the opening `<img` is escaped
			// to `&lt;img`, so it can never execute.
			const html = renderMarkdownDocument('<img src=x onerror=alert(1)>');
			expect(html).not.toContain('<img');
			expect(html).toContain('&lt;img');
		});
	});

	describe('document contract', () => {
		it('contains the CSP meta, base target, and doctype', () => {
			const html = renderMarkdownDocument('hello');
			expect(html).toContain(
				"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
			);
			expect(html).toContain('<base target="_blank">');
			expect(html.startsWith('<!doctype html>')).toBe(true);
		});

		it('injects rel="noopener noreferrer" onto real anchors', () => {
			const html = renderMarkdownDocument('[a](https://x.example/)');
			expect(html).toContain('href="https://x.example/"');
			expect(html).toContain('rel="noopener noreferrer"');
		});

		it('renders headings', () => {
			const html = renderMarkdownDocument('# Hi');
			expect(html).toContain('<h1>');
		});

		it('does not double-inject or corrupt rel attrs for a plain paragraph', () => {
			const html = renderMarkdownDocument('just some text, no links here');
			expect(html).toContain('<p>just some text, no links here</p>');
			// The document wrapper itself has no anchors, so there should be no
			// stray rel-injected anchor artifacts anywhere in the output.
			expect(html).not.toContain('<a rel="noopener noreferrer" rel=');
			expect((html.match(/rel="noopener noreferrer"/g) ?? []).length).toBe(0);
		});
	});

	describe('truncation', () => {
		it('appends the truncation notice when input exceeds the cap', () => {
			const long = 'a'.repeat(MARKDOWN_RENDER_LIMIT + 1);
			const html = renderMarkdownDocument(long);
			expect(html).toContain('Output truncated for rendering (256 KiB cap).');
		});

		it('does not append the truncation notice when input is at the cap', () => {
			const atLimit = 'a'.repeat(MARKDOWN_RENDER_LIMIT);
			const html = renderMarkdownDocument(atLimit);
			expect(html).not.toContain('Output truncated for rendering');
		});

		it('does not append the truncation notice for short input', () => {
			const html = renderMarkdownDocument('short');
			expect(html).not.toContain('Output truncated for rendering');
		});
	});
});
