import { describe, it, expect } from 'vitest';
import type { RunInput } from '../../src/runtime/types';
import opengraph from '../../src/examples/opengraph';
import reddit from '../../src/examples/reddit';
import hackernews from '../../src/examples/hackernews';

// The parsing logic lives inline inside each example's transform(). These tests
// drive the examples through their default export, feeding `body` via RunInput.
function runInput(body: string, url = 'https://example.com'): RunInput {
	return {
		url,
		finalUrl: url,
		status: 200,
		contentType: 'text/html',
		body,
		truncated: false,
	};
}

const REDDIT_URL = 'https://www.reddit.com/r/webdev/comments/abc123/some_thread/.json';
const HN_URL = 'https://hn.algolia.com/api/v1/items/39284928';

describe('opengraph example', () => {
	it('extracts og: properties from HTML', () => {
		const html = `
			<html>
			<head>
				<meta property="og:title" content="My Article" />
				<meta property="og:description" content="A great article" />
				<meta property="og:image" content="https://example.com/image.jpg" />
			</head>
			</html>
		`;
		const result = opengraph({}, runInput(html)) as Record<string, string>;
		expect(result['og:title']).toBe('My Article');
		expect(result['og:description']).toBe('A great article');
		expect(result['og:image']).toBe('https://example.com/image.jpg');
	});

	it('returns empty object when no og tags found', () => {
		const html = '<html><head><title>No OG tags</title></head></html>';
		expect(opengraph({}, runInput(html))).toEqual({});
	});

	it('handles malformed HTML gracefully', () => {
		expect(opengraph({}, runInput('not valid html at all'))).toEqual({});
	});

	it('extracts twitter: tags', () => {
		const html = `
			<html>
			<head>
				<meta name="twitter:card" content="summary" />
				<meta name="twitter:title" content="Tweet Title" />
			</head>
			</html>
		`;
		const result = opengraph({}, runInput(html)) as Record<string, string>;
		expect(result['twitter:card']).toBe('summary');
		expect(result['twitter:title']).toBe('Tweet Title');
	});
});

describe('reddit example', () => {
	type RedditComment = { author: string; score: number; body: string };

	it('extracts top comments sorted by score', () => {
		const json = JSON.stringify([
			{ data: { children: [] } },
			{
				data: {
					children: [
						{ data: { author: 'user1', score: 10, body: 'First comment' } },
						{ data: { author: 'user2', score: 25, body: 'Second comment' } },
						{ data: { author: 'user3', score: 5, body: 'Third comment' } },
					],
				},
			},
		]);

		const result = reddit({}, runInput(json, REDDIT_URL)) as RedditComment[];
		expect(result).toHaveLength(3);
		expect(result[0].author).toBe('user2');
		expect(result[0].score).toBe(25);
		expect(result[0].body).toBe('Second comment');
		expect(result[1].author).toBe('user1');
		expect(result[1].score).toBe(10);
		expect(result[2].author).toBe('user3');
		expect(result[2].score).toBe(5);
	});

	it('caps results at the default limit of 10', () => {
		const children = Array.from({ length: 12 }, (_, i) => ({
			data: { author: `user${i}`, score: 100 - i, body: `comment${i}` },
		}));
		const json = JSON.stringify([{ data: { children: [] } }, { data: { children } }]);

		const result = reddit({}, runInput(json, REDDIT_URL)) as RedditComment[];
		expect(result).toHaveLength(10);
		expect(result[0].author).toBe('user0'); // highest score
	});

	it('throws when the URL is not a Reddit host', () => {
		expect(() => reddit({}, runInput('not json', 'https://example.com/foo'))).toThrow(/only works with Reddit URLs/);
	});

	it('throws with a corrected .json URL when the body is HTML, not JSON', () => {
		const url = 'https://www.reddit.com/r/steammachine/comments/1ump4mz/steam_machine_gamecube_size_comparison/';
		expect(() => reddit({}, runInput('<!doctype html><html></html>', url))).toThrow(
			'https://www.reddit.com/r/steammachine/comments/1ump4mz/steam_machine_gamecube_size_comparison.json',
		);
	});

	it('throws on a Reddit JSON response with the wrong shape (e.g. a listing)', () => {
		const listingJson = JSON.stringify({ kind: 'Listing', data: { children: [] } });
		expect(() => reddit({}, runInput(listingJson, 'https://www.reddit.com/r/javascript/hot/.json'))).toThrow(
			/Expected a Reddit thread \.json URL/,
		);
	});

	it('skips entries without required fields', () => {
		const json = JSON.stringify([
			{ data: { children: [] } },
			{
				data: {
					children: [
						{ data: { author: 'user1', score: 10, body: 'comment1' } },
						{ data: { score: 9 } }, // missing author and body
						{ data: { author: 'user3', score: 8, body: 'comment3' } },
					],
				},
			},
		]);

		const result = reddit({}, runInput(json, REDDIT_URL)) as RedditComment[];
		expect(result).toHaveLength(2);
		expect(result[0].author).toBe('user1');
		expect(result[1].author).toBe('user3');
	});
});

describe('hackernews example', () => {
	type HnComment = { author: string; points: number | null; text: string };

	it('extracts top comments from Algolia item recursively', () => {
		const json = JSON.stringify({
			children: [
				{ text: 'Great article!', author: 'alice', points: 42 },
				{
					text: 'I disagree',
					author: 'bob',
					points: 23,
					children: [
						{ text: 'Why?', author: 'charlie', points: 15 },
						{ text: 'Interesting point', author: 'diana', points: 8 },
					],
				},
			],
		});

		const result = hackernews({}, runInput(json, HN_URL)) as HnComment[];
		expect(result).toHaveLength(4);
		expect(result[0].author).toBe('alice');
		expect(result[0].points).toBe(42);
		expect(result[1].author).toBe('bob');
		expect(result[1].points).toBe(23);
	});

	it('caps results at the default limit of 10', () => {
		const children = Array.from({ length: 12 }, (_, i) => ({
			text: `comment${i}`,
			author: `user${i}`,
			points: 100 - i,
		}));
		const json = JSON.stringify({ children });

		const result = hackernews({}, runInput(json, HN_URL)) as HnComment[];
		expect(result).toHaveLength(10);
	});

	it('throws when the URL is not the HN Algolia API', () => {
		expect(() => hackernews({}, runInput('invalid json', 'https://example.com/foo'))).toThrow(
			/only works with the HN Algolia API/,
		);
	});

	it('throws with a corrected hn.algolia.com URL for a news.ycombinator.com item link', () => {
		expect(() =>
			hackernews({}, runInput('<!doctype html><html></html>', 'https://news.ycombinator.com/item?id=39284928')),
		).toThrow('https://hn.algolia.com/api/v1/items/39284928');
	});

	it('throws on JSON without the expected item/children shape', () => {
		expect(() => hackernews({}, runInput(JSON.stringify({ hits: [] }), HN_URL))).toThrow(
			/Expected an HN Algolia item URL/,
		);
	});

	it('handles null points gracefully', () => {
		const json = JSON.stringify({
			children: [
				{ text: 'comment1', author: 'user1', points: 100 },
				{ text: 'comment2', author: 'user2', points: null },
				{ text: 'comment3', author: 'user3', points: 50 },
			],
		});

		const result = hackernews({}, runInput(json, HN_URL)) as HnComment[];
		expect(result).toHaveLength(3);
		expect(result[0].points).toBe(100);
		expect(result[1].points).toBe(50);
		expect(result[2].points).toBe(null);
	});

	it('skips entries without text', () => {
		const json = JSON.stringify({
			children: [
				{ text: 'comment1', author: 'user1', points: 100 },
				{ author: 'user2', points: 90 }, // missing text
				{ text: 'comment3', author: 'user3', points: 80 },
			],
		});

		const result = hackernews({}, runInput(json, HN_URL)) as HnComment[];
		expect(result).toHaveLength(2);
		expect(result[0].author).toBe('user1');
		expect(result[1].author).toBe('user3');
	});
});
