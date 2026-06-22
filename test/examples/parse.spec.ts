import { describe, it, expect } from 'vitest';
import { parseOpenGraph, parseRedditTopComments, parseHnTopComments } from '../../src/examples/lib/parse';

describe('parseOpenGraph', () => {
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
		const result = parseOpenGraph(html);
		expect(result['og:title']).toBe('My Article');
		expect(result['og:description']).toBe('A great article');
		expect(result['og:image']).toBe('https://example.com/image.jpg');
	});

	it('returns empty object when no og tags found', () => {
		const html = '<html><head><title>No OG tags</title></head></html>';
		const result = parseOpenGraph(html);
		expect(result).toEqual({});
	});

	it('handles malformed HTML gracefully', () => {
		const html = 'not valid html at all';
		const result = parseOpenGraph(html);
		expect(result).toEqual({});
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
		const result = parseOpenGraph(html);
		expect(result['twitter:card']).toBe('summary');
		expect(result['twitter:title']).toBe('Tweet Title');
	});
});

describe('parseRedditTopComments', () => {
	it('extracts top comments sorted by score', () => {
		const json = JSON.stringify([
			{ data: { children: [] } },
			{
				data: {
					children: [
						{
							data: {
								author: 'user1',
								score: 10,
								body: 'First comment',
							},
						},
						{
							data: {
								author: 'user2',
								score: 25,
								body: 'Second comment',
							},
						},
						{
							data: {
								author: 'user3',
								score: 5,
								body: 'Third comment',
							},
						},
					],
				},
			},
		]);

		const result = parseRedditTopComments(json);
		expect(result).toHaveLength(3);
		expect(result[0].author).toBe('user2');
		expect(result[0].score).toBe(25);
		expect(result[0].body).toBe('Second comment');
		expect(result[1].author).toBe('user1');
		expect(result[1].score).toBe(10);
		expect(result[2].author).toBe('user3');
		expect(result[2].score).toBe(5);
	});

	it('respects limit parameter', () => {
		const json = JSON.stringify([
			{ data: { children: [] } },
			{
				data: {
					children: [
						{ data: { author: 'user1', score: 100, body: 'comment1' } },
						{ data: { author: 'user2', score: 90, body: 'comment2' } },
						{ data: { author: 'user3', score: 80, body: 'comment3' } },
						{ data: { author: 'user4', score: 70, body: 'comment4' } },
						{ data: { author: 'user5', score: 60, body: 'comment5' } },
					],
				},
			},
		]);

		const result = parseRedditTopComments(json, 2);
		expect(result).toHaveLength(2);
		expect(result[0].author).toBe('user1');
		expect(result[1].author).toBe('user2');
	});

	it('returns empty array on invalid JSON', () => {
		const result = parseRedditTopComments('not json');
		expect(result).toEqual([]);
	});

	it('returns empty array when body is missing', () => {
		const json = JSON.stringify([
			{ data: { children: [] } },
			{
				data: {
					children: [
						{
							data: {
								author: 'user1',
								score: 10,
							},
						},
					],
				},
			},
		]);

		const result = parseRedditTopComments(json);
		expect(result).toEqual([]);
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

		const result = parseRedditTopComments(json);
		expect(result).toHaveLength(2);
		expect(result[0].author).toBe('user1');
		expect(result[1].author).toBe('user3');
	});
});

describe('parseHnTopComments', () => {
	it('extracts top comments from Algolia item recursively', () => {
		const json = JSON.stringify({
			children: [
				{
					text: 'Great article!',
					author: 'alice',
					points: 42,
				},
				{
					text: 'I disagree',
					author: 'bob',
					points: 23,
					children: [
						{
							text: 'Why?',
							author: 'charlie',
							points: 15,
						},
						{
							text: 'Interesting point',
							author: 'diana',
							points: 8,
						},
					],
				},
			],
		});

		const result = parseHnTopComments(json);
		expect(result).toHaveLength(4);
		expect(result[0].author).toBe('alice');
		expect(result[0].points).toBe(42);
		expect(result[1].author).toBe('bob');
		expect(result[1].points).toBe(23);
	});

	it('respects limit parameter', () => {
		const json = JSON.stringify({
			children: [
				{ text: 'comment1', author: 'user1', points: 100 },
				{ text: 'comment2', author: 'user2', points: 90 },
				{ text: 'comment3', author: 'user3', points: 80 },
			],
		});

		const result = parseHnTopComments(json, 2);
		expect(result).toHaveLength(2);
	});

	it('returns empty array on invalid JSON', () => {
		const result = parseHnTopComments('invalid json');
		expect(result).toEqual([]);
	});

	it('handles null points gracefully', () => {
		const json = JSON.stringify({
			children: [
				{ text: 'comment1', author: 'user1', points: 100 },
				{ text: 'comment2', author: 'user2', points: null },
				{ text: 'comment3', author: 'user3', points: 50 },
			],
		});

		const result = parseHnTopComments(json);
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

		const result = parseHnTopComments(json);
		expect(result).toHaveLength(2);
		expect(result[0].author).toBe('user1');
		expect(result[1].author).toBe('user3');
	});
});
