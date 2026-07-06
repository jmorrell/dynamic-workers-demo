import { describe, it, expect } from 'vitest';
import { extractLinkedUrls } from '../../src/runtime/extract-urls';

describe('extractLinkedUrls', () => {
	const base = 'https://example.com/page';

	describe('HTML content', () => {
		it('collects URL-bearing attributes across element types', () => {
			const html = `
				<a href="https://a.example/one">a</a>
				<link href="https://link.example/style.css">
				<img src="https://img.example/pic.png">
				<script src="https://script.example/app.js"></script>
				<iframe src="https://iframe.example/frame"></iframe>
				<video src="https://video.example/v.mp4" poster="https://video.example/poster.jpg"></video>
				<audio src="https://audio.example/a.mp3"></audio>
			`;
			const urls = extractLinkedUrls(html, 'text/html', base);
			expect(urls).toContain('https://a.example/one');
			expect(urls).toContain('https://link.example/style.css');
			expect(urls).toContain('https://img.example/pic.png');
			expect(urls).toContain('https://script.example/app.js');
			expect(urls).toContain('https://iframe.example/frame');
			expect(urls).toContain('https://video.example/v.mp4');
			expect(urls).toContain('https://video.example/poster.jpg');
			expect(urls).toContain('https://audio.example/a.mp3');
		});

		it('parses each candidate URL out of img/source srcset', () => {
			const html = `
				<img srcset="https://cdn.example/small.png 480w, https://cdn.example/large.png 1080w">
				<picture><source srcset="https://cdn.example/hero.avif 1x, https://cdn.example/hero2x.avif 2x"></picture>
			`;
			const urls = extractLinkedUrls(html, 'text/html', base);
			expect(urls).toContain('https://cdn.example/small.png');
			expect(urls).toContain('https://cdn.example/large.png');
			expect(urls).toContain('https://cdn.example/hero.avif');
			expect(urls).toContain('https://cdn.example/hero2x.avif');
		});

		it('resolves relative URLs against the base URL', () => {
			const html = `<a href="/about">about</a><img src="images/logo.png">`;
			const urls = extractLinkedUrls(html, 'text/html', 'https://example.com/dir/page');
			expect(urls).toContain('https://example.com/about');
			expect(urls).toContain('https://example.com/dir/images/logo.png');
		});

		it('includes meta[content] only when it parses as an absolute URL', () => {
			const html = `
				<meta property="og:image" content="https://og.example/card.png">
				<meta name="description" content="just some text, not a url">
				<meta property="og:type" content="article">
			`;
			const urls = extractLinkedUrls(html, 'text/html', base);
			expect(urls).toContain('https://og.example/card.png');
			expect(urls).not.toContain('article');
			expect(urls.some((u) => u.includes('just some text'))).toBe(false);
		});

		it('dedupes repeated URLs', () => {
			const html = `<a href="https://dup.example/x">1</a><a href="https://dup.example/x">2</a><img src="https://dup.example/x">`;
			const urls = extractLinkedUrls(html, 'text/html', base);
			expect(urls.filter((u) => u === 'https://dup.example/x')).toHaveLength(1);
		});

		it('keeps only http/https URLs', () => {
			const html = `
				<a href="mailto:a@example.com">mail</a>
				<a href="javascript:alert(1)">js</a>
				<a href="ftp://ftp.example/file">ftp</a>
				<a href="https://ok.example/page">ok</a>
			`;
			const urls = extractLinkedUrls(html, 'text/html', base);
			expect(urls).toEqual(['https://ok.example/page']);
		});

		it('caps the number of extracted URLs at 2000', () => {
			const anchors = Array.from({ length: 2500 }, (_, i) => `<a href="https://example.com/p/${i}">${i}</a>`).join('');
			const urls = extractLinkedUrls(anchors, 'text/html', base);
			expect(urls.length).toBe(2000);
		});

		it('handles application/xhtml+xml as HTML', () => {
			const html = `<a href="https://xhtml.example/a">a</a>`;
			const urls = extractLinkedUrls(html, 'application/xhtml+xml; charset=utf-8', base);
			expect(urls).toContain('https://xhtml.example/a');
		});
	});

	describe('JSON / text content', () => {
		it('extracts absolute http(s) URLs from JSON, including escaped forward slashes', () => {
			const json = JSON.stringify({
				image: 'https://json.example/a.png',
				nested: { link: 'http://json.example/b' },
			});
			// JSON.stringify does not escape slashes, so also test the escaped form
			// that appears in many real API payloads / embedded <script> JSON.
			const escaped = '{"u":"https:\\/\\/escaped.example\\/deep\\/path?x=1"}';
			const urls = extractLinkedUrls(json + escaped, 'application/json', base);
			expect(urls).toContain('https://json.example/a.png');
			expect(urls).toContain('http://json.example/b');
			expect(urls).toContain('https://escaped.example/deep/path?x=1');
		});

		it('extracts URLs from plain text and trims trailing punctuation', () => {
			const text = 'See https://text.example/doc. Also visit https://text.example/other, thanks.';
			const urls = extractLinkedUrls(text, 'text/plain', base);
			expect(urls).toContain('https://text.example/doc');
			expect(urls).toContain('https://text.example/other');
		});

		it('does not HTML-parse non-HTML text (regex path), still deduping', () => {
			const text = 'https://d.example/x https://d.example/x https://d.example/y';
			const urls = extractLinkedUrls(text, 'text/plain', base);
			expect(urls.filter((u) => u === 'https://d.example/x')).toHaveLength(1);
			expect(urls).toContain('https://d.example/y');
		});
	});

	it('returns normalized URL.toString() forms', () => {
		const html = `<a href="https://example.com">root</a>`;
		const urls = extractLinkedUrls(html, 'text/html', base);
		// URL normalization appends the trailing slash to a bare origin.
		expect(urls).toContain('https://example.com/');
	});
});
