import { describe, it, expect } from 'vitest';
import type { RunInput, StorageApi, TransformEnv } from '../../src/runtime/types';
import opengraph from '../../src/examples/opengraph';
import hackernews from '../../src/examples/hackernews';
import feedWatcher, { extractFeedTitle, extractItems, hashIdentity, computeDelta, type FeedItem } from '../../src/examples/feed-watcher';

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

describe('feed-watcher example', () => {
	const RSS_FEED = `<?xml version="1.0"?>
		<rss><channel>
			<title>Example Feed</title>
			<item>
				<title>First Post</title>
				<link>https://example.com/first</link>
				<guid>guid-1</guid>
			</item>
			<item>
				<title>Second Post</title>
				<link>https://example.com/second</link>
				<guid>guid-2</guid>
			</item>
		</channel></rss>`;

	const ATOM_FEED = `<?xml version="1.0"?>
		<feed>
			<title>Atom Feed</title>
			<entry>
				<title>Atom Entry</title>
				<id>urn:uuid:atom-1</id>
				<link href="https://example.com/atom-1" rel="alternate"/>
			</entry>
		</feed>`;

	describe('extractFeedTitle / extractItems (RSS + Atom parsing)', () => {
		it('extracts the feed title and item title/link/guid for RSS', () => {
			expect(extractFeedTitle(RSS_FEED)).toBe('Example Feed');
			const items = extractItems(RSS_FEED);
			expect(items).toHaveLength(2);
			expect(items[0]).toEqual({ title: 'First Post', link: 'https://example.com/first', guid: 'guid-1' });
			expect(items[1]).toEqual({ title: 'Second Post', link: 'https://example.com/second', guid: 'guid-2' });
		});

		it('extracts items for Atom feeds, using <id> as the guid', () => {
			const items = extractItems(ATOM_FEED);
			expect(items).toHaveLength(1);
			expect(items[0]).toEqual({ title: 'Atom Entry', link: 'https://example.com/atom-1', guid: 'urn:uuid:atom-1' });
		});

		it('caps parsed items at MAX_ITEMS_PER_RUN worth of blocks', () => {
			const manyItems = Array.from(
				{ length: 150 },
				(_, i) => `<item><title>Item ${i}</title><link>https://example.com/${i}</link><guid>g${i}</guid></item>`,
			).join('\n');
			const feed = `<rss><channel><title>Big Feed</title>${manyItems}</channel></rss>`;
			expect(extractItems(feed).length).toBeLessThanOrEqual(100);
		});
	});

	describe('hashIdentity', () => {
		it('is deterministic', () => {
			expect(hashIdentity('https://example.com/a')).toBe(hashIdentity('https://example.com/a'));
		});

		it('differs for different identities (no trivial collision)', () => {
			expect(hashIdentity('https://example.com/a')).not.toBe(hashIdentity('https://example.com/b'));
		});

		it('produces an 8-hex-char digest', () => {
			expect(hashIdentity('anything')).toMatch(/^[0-9a-f]{8}$/);
		});
	});

	describe('computeDelta (pure core)', () => {
		const items: FeedItem[] = [
			{ title: 'A', link: 'https://example.com/a', guid: 'a' },
			{ title: 'B', link: 'https://example.com/b', guid: 'b' },
		];

		it('reports firstRun true and all items new when nothing was stored yet', () => {
			const delta = computeDelta(items, []);
			expect(delta.firstRun).toBe(true);
			expect(delta.newItems).toHaveLength(2);
			expect(delta.updatedSeen).toHaveLength(2);
		});

		it('reports firstRun false and zero new items when everything was already seen', () => {
			const seeded = computeDelta(items, []).updatedSeen;
			const delta = computeDelta(items, seeded);
			expect(delta.firstRun).toBe(false);
			expect(delta.newItems).toHaveLength(0);
			expect(delta.updatedSeen).toEqual(seeded);
		});

		it('reports only the genuinely new items on a partial overlap', () => {
			const seeded = computeDelta([items[0]], []).updatedSeen;
			const delta = computeDelta(items, seeded);
			expect(delta.firstRun).toBe(false);
			expect(delta.newItems).toHaveLength(1);
			expect(delta.newItems[0].link).toBe('https://example.com/b');
			expect(delta.updatedSeen).toHaveLength(2);
		});

		it('skips items without a link', () => {
			const delta = computeDelta([{ title: 'no link', link: null, guid: 'x' }], []);
			expect(delta.newItems).toHaveLength(0);
			expect(delta.updatedSeen).toHaveLength(0);
		});

		it('dedupes identical identities appearing twice in the same run', () => {
			const dup: FeedItem[] = [
				{ title: 'A', link: 'https://example.com/a', guid: 'a' },
				{ title: 'A again', link: 'https://example.com/a', guid: 'a' },
			];
			const delta = computeDelta(dup, []);
			expect(delta.newItems).toHaveLength(1);
			expect(delta.updatedSeen).toHaveLength(1);
		});

		it('caps the stored seen list at the most recent 500 ids', () => {
			const manyHashes = Array.from({ length: 500 }, (_, i) => hashIdentity(`old-${i}`));
			const delta = computeDelta(items, manyHashes);
			expect(delta.updatedSeen.length).toBe(500);
			// The two newly-added hashes survive; the oldest two fall off.
			expect(delta.updatedSeen).toContain(hashIdentity('a'));
			expect(delta.updatedSeen).toContain(hashIdentity('b'));
			expect(delta.updatedSeen).not.toContain(hashIdentity('old-0'));
			expect(delta.updatedSeen).not.toContain(hashIdentity('old-1'));
		});
	});

	// A minimal in-memory env.storage stand-in (the real one is backed by a DO
	// facet's SQLite kv — see src/runtime/harness-source.ts — but its get/put
	// shape is exactly this). Facets don't exist in the vitest pool (see
	// src/runtime/AGENTS.md gotchas), so the default transform is exercised
	// directly here (as opengraph/hackernews are above), simulating
	// persistence across "runs" by reusing the same fake store.
	function fakeStorage(): StorageApi {
		const kv = new Map<string, unknown>();
		return {
			get: (key) => kv.get(key),
			put: (key, value) => {
				kv.set(key, value);
			},
			delete: (key) => kv.delete(key),
			list: () => [...kv.keys()],
		};
	}

	it('default transform: first run reports firstRun:true with every item as new', async () => {
		const env: TransformEnv = { storage: fakeStorage() };
		const result = (await feedWatcher(env, runInput(RSS_FEED))) as {
			feedTitle: string | null;
			firstRun: boolean;
			newCount: number;
			seenTotal: number;
			items: unknown[];
		};

		expect(result.feedTitle).toBe('Example Feed');
		expect(result.firstRun).toBe(true);
		expect(result.newCount).toBe(2);
		expect(result.seenTotal).toBe(2);
		expect(result.items).toHaveLength(2);
	});

	it('default transform: second run against the same feed reports no new items', async () => {
		const env: TransformEnv = { storage: fakeStorage() };
		await feedWatcher(env, runInput(RSS_FEED));
		const second = (await feedWatcher(env, runInput(RSS_FEED))) as { firstRun: boolean; newCount: number; seenTotal: number };

		expect(second.firstRun).toBe(false);
		expect(second.newCount).toBe(0);
		expect(second.seenTotal).toBe(2);
	});

	it('default transform: a third run with one added item reports only that item as new', async () => {
		const env: TransformEnv = { storage: fakeStorage() };
		await feedWatcher(env, runInput(RSS_FEED));

		const grownFeed = RSS_FEED.replace(
			'</channel></rss>',
			'<item><title>Third Post</title><link>https://example.com/third</link><guid>guid-3</guid></item></channel></rss>',
		);
		const third = (await feedWatcher(env, runInput(grownFeed))) as {
			firstRun: boolean;
			newCount: number;
			seenTotal: number;
			items: Array<{ link: string }>;
		};

		expect(third.firstRun).toBe(false);
		expect(third.newCount).toBe(1);
		expect(third.items[0].link).toBe('https://example.com/third');
		expect(third.seenTotal).toBe(3);
	});

	it('throws when env.storage is unavailable (no storage grant)', async () => {
		await expect(feedWatcher({}, runInput(RSS_FEED))).rejects.toThrow('env.storage is unavailable');
	});
});
