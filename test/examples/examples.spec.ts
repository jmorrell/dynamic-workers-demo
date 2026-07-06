// Integration tests running bundled example code through the loader

import { describe, it, expect } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import { getExample } from '../../src/examples/manifest';
import type { RunInput } from '../../src/runtime/types';

// Fixtures defined inline (tests run in Workers runtime where filesystem isn't available)
const FIXTURES = {
	articleHtml: `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Understanding Web Performance Optimization</title>
	<meta name="description" content="A comprehensive guide to optimizing web performance for better user experience.">
	<meta property="og:title" content="Understanding Web Performance Optimization">
	<meta property="og:description" content="A comprehensive guide to optimizing web performance for better user experience.">
	<meta property="og:image" content="https://example.com/perf-guide.jpg">
	<meta property="og:url" content="https://example.com/article">
	<meta property="article:author" content="Jane Developer">
	<meta property="article:published_time" content="2024-01-15T08:00:00Z">
</head>
<body>
	<article>
		<header>
			<h1>Understanding Web Performance Optimization</h1>
			<p class="meta">By Jane Developer on January 15, 2024</p>
		</header>
		<main>
			<section>
				<h2>Introduction</h2>
				<p>Web performance is crucial for user experience and search engine rankings. In this comprehensive guide, we'll explore the key metrics, best practices, and tools that help create faster, more responsive websites.</p>
			</section>
			<section>
				<h2>Core Web Vitals</h2>
				<p>Google's Core Web Vitals focus on three key metrics:</p>
				<ul>
					<li><strong>Largest Contentful Paint (LCP):</strong> How quickly the largest element on the page renders.</li>
					<li><strong>First Input Delay (FID):</strong> How quickly the browser responds to user interactions.</li>
					<li><strong>Cumulative Layout Shift (CLS):</strong> How much the page layout shifts unexpectedly.</li>
				</ul>
			</section>
			<section>
				<h2>Optimization Strategies</h2>
				<p>There are several proven strategies for improving web performance:</p>
				<ol>
					<li>Minimize HTTP requests by bundling and compressing assets.</li>
					<li>Optimize images by using modern formats like WebP and responsive image techniques.</li>
					<li>Implement lazy loading for below-the-fold content.</li>
					<li>Use a Content Delivery Network (CDN) to serve assets from locations closer to users.</li>
					<li>Enable browser caching with appropriate cache headers.</li>
				</ol>
			</section>
			<section>
				<h2>Tools and Monitoring</h2>
				<p>Several tools can help measure and monitor web performance:</p>
				<ul>
					<li>Google PageSpeed Insights provides actionable recommendations.</li>
					<li>WebPageTest offers detailed waterfall charts and filmstrips.</li>
					<li>Lighthouse, built into Chrome, runs comprehensive audits.</li>
					<li>Real User Monitoring (RUM) captures actual user experience data.</li>
				</ul>
			</section>
			<section>
				<h2>Conclusion</h2>
				<p>Optimizing web performance is an ongoing process that requires continuous monitoring and improvement. By following these strategies and using available tools, you can create faster, more efficient web applications that provide better user experiences and achieve higher search engine rankings.</p>
			</section>
		</main>
	</article>
</body>
</html>`,

	ogTaggedHtml: `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Amazing Product | Store Name</title>
	<meta property="og:title" content="Amazing Product">
	<meta property="og:description" content="The best product you've ever seen. Limited time offer!">
	<meta property="og:image" content="https://example.com/product-image.jpg">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:type" content="product">
	<meta property="og:url" content="https://store.example.com/products/amazing-product">
	<meta property="og:site_name" content="Store Name">
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="Amazing Product">
	<meta name="twitter:description" content="The best product you've ever seen. Limited time offer!">
	<meta name="twitter:image" content="https://example.com/product-image.jpg">
	<meta name="twitter:creator" content="@storehandle">
</head>
<body>
	<h1>Amazing Product</h1>
	<p>Welcome to our store. This is a page with rich OpenGraph metadata.</p>
</body>
</html>`,

	noOgHtml: `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Simple Page Without Metadata</title>
	<meta name="description" content="This is a simple page without OpenGraph tags.">
</head>
<body>
	<h1>Simple Page</h1>
	<p>This page has no OpenGraph metadata, just basic HTML.</p>
	<p>When processed by the opengraph example, it should return an empty object.</p>
</body>
</html>`,

	redditJson: `[
	{
		"data": {
			"children": []
		}
	},
	{
		"data": {
			"children": [
				{
					"kind": "t1",
					"data": {
						"author": "alice",
						"score": 1250,
						"body": "This is the top comment about web performance. It provides useful insights about optimization techniques.",
						"created_utc": 1234567890
					}
				},
				{
					"kind": "t1",
					"data": {
						"author": "bob",
						"score": 890,
						"body": "Great article! I found the section on Core Web Vitals particularly helpful. Implementing these changes improved our site speed by 40%.",
						"created_utc": 1234567891
					}
				},
				{
					"kind": "t1",
					"data": {
						"author": "charlie",
						"score": 650,
						"body": "Has anyone else tried using a CDN? The difference in load times was night and day for our international users.",
						"created_utc": 1234567892
					}
				},
				{
					"kind": "t1",
					"data": {
						"author": "diana",
						"score": 420,
						"body": "The Lighthouse recommendations have been invaluable for our development process.",
						"created_utc": 1234567893
					}
				},
				{
					"kind": "t1",
					"data": {
						"author": "eve",
						"score": 180,
						"body": "Is anyone using WebPageTest? I'd like to hear about your experience.",
						"created_utc": 1234567894
					}
				}
			]
		}
	}
]`,

	hnAlgoliaJson: `{
	"id": 39284928,
	"created_at": "2024-01-15T10:30:00Z",
	"created_at_i": 1705318200,
	"type": "story",
	"author": "hn_author",
	"title": "Understanding Web Performance Optimization",
	"url": "https://example.com/article",
	"text": null,
	"points": 500,
	"parent_id": null,
	"story_id": 39284928,
	"comment_count": 150,
	"story_text": "A comprehensive guide to optimizing web performance",
	"children": [
		{
			"id": 39285001,
			"created_at": "2024-01-15T11:00:00Z",
			"created_at_i": 1705320000,
			"type": "comment",
			"author": "user_alice",
			"text": "Excellent breakdown of Core Web Vitals. The LCP optimization tips alone saved us several seconds on page load.",
			"points": 125,
			"parent_id": 39284928,
			"story_id": 39284928,
			"children": [
				{
					"id": 39285050,
					"created_at": "2024-01-15T11:30:00Z",
					"created_at_i": 1705321800,
					"type": "comment",
					"author": "user_bob",
					"text": "Did you implement image optimization as well?",
					"points": 42,
					"parent_id": 39285001,
					"story_id": 39284928
				},
				{
					"id": 39285075,
					"created_at": "2024-01-15T11:45:00Z",
					"created_at_i": 1705322700,
					"type": "comment",
					"author": "user_charlie",
					"text": "We switched to WebP and the difference was significant.",
					"points": 35,
					"parent_id": 39285001,
					"story_id": 39284928
				}
			]
		},
		{
			"id": 39285200,
			"created_at": "2024-01-15T12:00:00Z",
			"created_at_i": 1705324800,
			"type": "comment",
			"author": "user_diana",
			"text": "The CDN section was particularly relevant for our international user base. Traffic from Europe and Asia has never been faster.",
			"points": 98,
			"parent_id": 39284928,
			"story_id": 39284928
		},
		{
			"id": 39285350,
			"created_at": "2024-01-15T12:30:00Z",
			"created_at_i": 1705326600,
			"type": "comment",
			"author": "user_eve",
			"text": "Anyone using Lighthouse CI in their build pipeline?",
			"points": 56,
			"parent_id": 39284928,
			"story_id": 39284928,
			"children": [
				{
					"id": 39285400,
					"created_at": "2024-01-15T13:00:00Z",
					"created_at_i": 1705328400,
					"type": "comment",
					"author": "user_frank",
					"text": "Yes, it's been game-changing for catching regressions early.",
					"points": 22,
					"parent_id": 39285350,
					"story_id": 39284928
				}
			]
		}
	]
}`,
};

describe('Example transforms through loader (AC2.1–AC2.5)', () => {
	describe('AC2.1: markdown example', () => {
		it('extracts readable markdown from article HTML through the loader', async () => {
			// linkedom + defuddle are bundled (esbuild, platform:browser) and run
			// successfully inside the workerd Dynamic Worker isolate, producing
			// markdown from the article fixture.
			const example = getExample('markdown');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://example.com/article',
				finalUrl: 'https://example.com/article',
				status: 200,
				contentType: 'text/html',
				responseHeaders: new Map(),
				body: FIXTURES.articleHtml,
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as { title: unknown; markdown: unknown; error?: unknown };
				// Defuddle ran cleanly (no caught error) and produced non-empty markdown.
				expect(output.error).toBeUndefined();
				expect(typeof output.markdown).toBe('string');
				expect((output.markdown as string).length).toBeGreaterThan(0);
				// Article body text survives the extraction.
				expect(output.markdown as string).toContain('Core Web Vitals');
			}
		});
	});

	describe('AC2.2: opengraph example', () => {
		it('returns extracted OG tags for OG-tagged HTML', async () => {
			const example = getExample('opengraph');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://store.example.com/products/amazing-product',
				finalUrl: 'https://store.example.com/products/amazing-product',
				status: 200,
				contentType: 'text/html',
				responseHeaders: new Map(),
				body: FIXTURES.ogTaggedHtml,
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as Record<string, string>;
				expect(output['og:title']).toBe('Amazing Product');
				expect(output['og:description']).toContain('best product');
				expect(output['og:image']).toContain('product-image.jpg');
				expect(output['twitter:card']).toBe('summary_large_image');
				expect(output['twitter:title']).toBe('Amazing Product');
			}
		});
	});

	describe('AC2.3: reddit example', () => {
		it('returns sorted top comments from Reddit JSON', async () => {
			const example = getExample('reddit');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://www.reddit.com/r/webdev/comments/abc123.json',
				finalUrl: 'https://www.reddit.com/r/webdev/comments/abc123.json',
				status: 200,
				contentType: 'application/json',
				responseHeaders: new Map(),
				body: FIXTURES.redditJson,
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as Array<Record<string, unknown>>;
				expect(Array.isArray(output)).toBe(true);
				expect(output.length).toBeGreaterThan(0);
				// Should be sorted by score descending
				expect(output[0].author).toBe('alice');
				expect(output[0].score).toBe(1250);
				expect(output[0].body).toContain('top comment');
				expect(output[1].author).toBe('bob');
				expect(output[1].score).toBe(890);
				// Verify sorting is descending
				for (let i = 0; i < output.length - 1; i++) {
					expect((output[i].score as number) >= (output[i + 1].score as number)).toBe(true);
				}
			}
		});
	});

	describe('AC2.4: hackernews example', () => {
		it('returns sorted comments from HN Algolia item', async () => {
			const example = getExample('hackernews');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://hn.algolia.com/api/v1/items/39284928',
				finalUrl: 'https://hn.algolia.com/api/v1/items/39284928',
				status: 200,
				contentType: 'application/json',
				responseHeaders: new Map(),
				body: FIXTURES.hnAlgoliaJson,
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as Array<Record<string, unknown>>;
				expect(Array.isArray(output)).toBe(true);
				expect(output.length).toBeGreaterThan(0);
				// Should include comments from various nesting levels
				// and be sorted by points descending
				const points = output.map((c) => (c.points as number | null) ?? -Infinity);
				for (let i = 0; i < points.length - 1; i++) {
					expect(points[i] >= points[i + 1]).toBe(true);
				}
				// Verify we have extracted from nested children
				const authors = output.map((c) => c.author);
				expect(authors).toContain('user_alice');
				expect(authors).toContain('user_bob');
			}
		});
	});

	describe('AC2.5: graceful degradation on unsuitable input', () => {
		it('markdown stays total (ok:true, structured result) on unsuitable input', async () => {
			const example = getExample('markdown');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://example.com/empty',
				finalUrl: 'https://example.com/empty',
				status: 200,
				contentType: 'text/html',
				responseHeaders: new Map(),
				body: '',
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			// The markdown transform's try/catch keeps it total: even on empty/garbage
			// input it returns ok:true with a structured object (markdown is always a
			// string), never an unhandled crash (AC2.5).
			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as { markdown: unknown };
				expect(typeof output.markdown).toBe('string');
			}
		});

		it('opengraph returns empty object for HTML without OG tags', async () => {
			const example = getExample('opengraph');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://example.com/simple',
				finalUrl: 'https://example.com/simple',
				status: 200,
				contentType: 'text/html',
				responseHeaders: new Map(),
				body: FIXTURES.noOgHtml,
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as Record<string, unknown>;
				expect(Object.keys(output).length).toBe(0);
			}
		});

		it('reddit returns empty array for invalid JSON', async () => {
			const example = getExample('reddit');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://www.reddit.com/r/test/comments/invalid.json',
				finalUrl: 'https://www.reddit.com/r/test/comments/invalid.json',
				status: 200,
				contentType: 'application/json',
				responseHeaders: new Map(),
				body: 'not valid json',
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as unknown;
				expect(Array.isArray(output)).toBe(true);
				expect((output as Array<unknown>).length).toBe(0);
			}
		});

		it('hackernews returns empty array for invalid JSON', async () => {
			const example = getExample('hackernews');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://hn.algolia.com/api/v1/items/invalid',
				finalUrl: 'https://hn.algolia.com/api/v1/items/invalid',
				status: 200,
				contentType: 'application/json',
				responseHeaders: new Map(),
				body: 'invalid json',
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const output = result.value as unknown;
				expect(Array.isArray(output)).toBe(true);
				expect((output as Array<unknown>).length).toBe(0);
			}
		});

		// NOTE: cpu-spin is deliberately NOT executed through runInLoader here.
		// The CPU limit (limits.cpuMs) is enforced only on deployed Cloudflare
		// infrastructure, NOT in the local vitest/workerd runtime — so running its
		// while(true) loop locally would hang forever. Its containment is covered by
		// Phase 2's safety.spec.ts (classifyLoaderError → cpu_exceeded) and the
		// deploy-verified criterion in test-requirements.md. Here we only assert the
		// example is registered with bundled code so the manifest stays complete.
		it('cpu-spin example is present in the manifest with bundled code', () => {
			const example = getExample('cpu-spin');
			expect(example).toBeDefined();
			if (!example) return;
			expect(typeof example.code).toBe('string');
			expect(example.code.length).toBeGreaterThan(0);
		});

		it('blocked-fetch example returns a network_blocked error through the loader', async () => {
			const example = getExample('blocked-fetch');
			expect(example).toBeDefined();
			if (!example) return;

			const input: RunInput = {
				url: 'https://example.com',
				finalUrl: 'https://example.com',
				status: 200,
				contentType: 'text/html',
				responseHeaders: new Map(),
				body: '<html></html>',
				truncated: false,
			};

			const ctx = createExecutionContext();
			const result = await runInLoader(env, input, example.code, crypto.randomUUID(), ctx);

			// fetch() is blocked by globalOutbound: null; the harness converts the
			// thrown error into a structured network_blocked result (no host crash).
			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('network_blocked');
			}
		});
	});
});
