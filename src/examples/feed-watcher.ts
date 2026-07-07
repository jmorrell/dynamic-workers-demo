// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// "What's new since I last ran this?" — point this at an RSS or Atom feed
// URL, e.g. https://blog.cloudflare.com/rss/ or https://hnrss.org/frontpage.
// Parses the feed's items with the same tolerant regex/string approach as
// src/examples/rss-digest.ts (RSS <item>/<link>/<guid>, Atom
// <entry>/<link href>/<id>, CDATA-wrapped titles, basic XML entity escaping)
// — copied rather than imported across example files, since each example is
// bundled standalone by scripts/build-examples.mjs.
//
// Unlike rss-digest, this example makes NO outbound fetch of its own
// (permissions: { fetch: 'none', storage: 'scoped' }): it only remembers,
// across runs, which item identities (guid/id, falling back to the link) it
// has already reported, using env.storage. Running it a second time against
// the same feed URL reports only the items that showed up since the previous
// run, plus firstRun/newCount/seenTotal counters.
//
// Storage is EPHEMERAL: the store's supervisor Durable Object resets a
// sliding ~1h self-destruct alarm on every run and evaporates if untouched
// that long (see src/runtime/AGENTS.md's Storage contract) — so "seen
// before" only holds across runs within about an hour of each other. This
// example's registry description repeats that so the demo UX sets the right
// expectation.

import type { RunInput, TransformEnv } from '../runtime/types';

// Bound the amount of parsing/work a single run does on a pathologically
// large feed. Real-world feeds carry at most a few dozen items.
const MAX_ITEMS_PER_RUN = 100;

// Seen-item identities live under this ONE key (well inside the 200-key
// cap) as a JSON array of short hashes — NOT the full guid/link text, which
// would blow the 8 KiB per-value cap at hundreds of entries. Arithmetic:
// each stored id is an 8-hex-char FNV-1a digest (32 bits) of the item's
// identity string. JSON-encoded, one entry costs `"xxxxxxxx"` = 10 bytes
// plus a separating comma = 11 bytes. Capping at MAX_SEEN_IDS = 500 entries
// costs at most 2 (brackets) + 500*10 (quoted hashes) + 499 (commas) = 5501
// bytes — comfortably under the 8192-byte (STORE_MAX_VALUE_BYTES) cap, with
// ~2.7 KiB of headroom to spare.
const SEEN_KEY = 'seenIds';
const MAX_SEEN_IDS = 500;

function stripCdata(value: string): string {
	const match = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
	return match ? match[1] : value;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

function cleanText(value: string): string {
	return decodeEntities(stripCdata(value)).trim();
}

export type FeedItem = { title: string | null; link: string | null; guid: string | null };

function extractBlocks(body: string): { blocks: string[]; kind: 'rss' | 'atom' } {
	const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
	if (items.length > 0) return { blocks: items, kind: 'rss' };
	const entries = [...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
	return { blocks: entries, kind: 'atom' };
}

export function extractFeedTitle(body: string): string | null {
	const firstBlockIndex = body.search(/<(item|entry)\b/i);
	const head = firstBlockIndex >= 0 ? body.slice(0, firstBlockIndex) : body;
	const match = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? cleanText(match[1]) : null;
}

function extractItemTitle(block: string): string | null {
	const match = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? cleanText(match[1]) : null;
}

function extractItemLink(block: string, kind: 'rss' | 'atom'): string | null {
	if (kind === 'atom') {
		// Atom links are self-closing elements with a href attribute; prefer the
		// one with rel="alternate" (or no rel at all, which defaults to alternate).
		for (const linkMatch of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
			const attrs = linkMatch[1];
			const hrefMatch = attrs.match(/href="([^"]*)"/i);
			if (!hrefMatch) continue;
			const relMatch = attrs.match(/rel="([^"]*)"/i);
			if (!relMatch || relMatch[1].toLowerCase() === 'alternate') return decodeEntities(hrefMatch[1]);
		}
		return null;
	}
	const match = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
	return match ? decodeEntities(match[1].trim()) : null;
}

// RSS <guid> (the isPermaLink attribute is ignored — we only need a stable
// identity string, not whether it happens to resolve as a URL); Atom <id>.
function extractItemGuid(block: string, kind: 'rss' | 'atom'): string | null {
	const tag = kind === 'atom' ? 'id' : 'guid';
	const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
	return match ? cleanText(match[1]) : null;
}

export function extractItems(body: string): FeedItem[] {
	const { blocks, kind } = extractBlocks(body);
	return blocks
		.slice(0, MAX_ITEMS_PER_RUN)
		.map((block) => ({ title: extractItemTitle(block), link: extractItemLink(block, kind), guid: extractItemGuid(block, kind) }));
}

// Stable identity for a feed item: its guid/id when present (the feed's own
// notion of item identity), falling back to the link. Callers only invoke
// this on items that have at least a link (see computeDelta).
export function identityFor(item: FeedItem): string {
	return (item.guid ?? item.link) as string;
}

// FNV-1a 32-bit hash, hex-encoded (8 chars) — a fast, deterministic,
// non-cryptographic digest of an item's identity string. A collision would
// only cause a truly-new item to be missed as "already seen" — an acceptable
// demo-grade trade for keeping the stored footprint small (see SEEN_KEY's
// arithmetic comment above). Not a security boundary.
export function hashIdentity(identity: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < identity.length; i++) {
		hash ^= identity.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export type FeedDelta = {
	newItems: Array<{ title: string | null; link: string }>;
	updatedSeen: string[];
	firstRun: boolean;
};

// Pure core: given this run's items and the previously-stored seen-hash list,
// determines which items are new and the updated seen-hash list (deduped
// within this run too, then capped to the MAX_SEEN_IDS most recent). No I/O —
// the transform below is the thin imperative shell around this.
export function computeDelta(items: ReadonlyArray<FeedItem>, seenHashes: ReadonlyArray<string>): FeedDelta {
	const firstRun = seenHashes.length === 0;
	const seen = new Set(seenHashes);
	const newItems: Array<{ title: string | null; link: string }> = [];
	const appended: string[] = [];

	for (const item of items) {
		if (!item.link) continue;
		const hash = hashIdentity(identityFor(item));
		if (seen.has(hash)) continue;
		seen.add(hash);
		appended.push(hash);
		newItems.push({ title: item.title, link: item.link });
	}

	const updatedSeen = [...seenHashes, ...appended].slice(-MAX_SEEN_IDS);
	return { newItems, updatedSeen, firstRun };
}

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	const storage = env.storage;
	if (!storage) throw new Error('env.storage is unavailable');

	const feedTitle = extractFeedTitle(input.body);
	const items = extractItems(input.body);

	const stored = storage.get(SEEN_KEY);
	const seenHashes = Array.isArray(stored) ? stored.filter((h): h is string => typeof h === 'string') : [];

	const { newItems, updatedSeen, firstRun } = computeDelta(items, seenHashes);
	storage.put(SEEN_KEY, updatedSeen);

	return {
		feedTitle,
		firstRun,
		newCount: newItems.length,
		seenTotal: updatedSeen.length,
		items: newItems,
	};
}
