// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// Point this at an RSS or Atom feed URL, e.g. https://blog.cloudflare.com/rss/.
// Parses feed items with regex/string matching instead of a full XML parser —
// tolerant of both RSS (<item> … <title> … <link>url</link>) and Atom
// (<entry> … <link href="url" …/>) shapes, CDATA-wrapped titles, and basic XML
// entity escaping.
//
// Deliberately NO fetchDepth grant here (unlike arxiv-digest): a feed's own
// payload already lists every article's URL directly — there's no second hop
// to grow into, so the default depth-1 page-links grant covers every
// env.fetch this example makes.
//
// Known gap: extractLinkedUrls (the host-side allowlist builder) treats an RSS
// feed's XML content-type as plain text and regex-matches absolute
// http(s) URLs WITHOUT decoding XML entities first (it only unescapes JSON's
// `\/`). If a feed XML-escapes '&' inside a URL (`&amp;`), the allowlist ends
// up keyed on the raw escaped string, but this example decodes entities in a
// link's text before calling env.fetch — the decoded URL then fails the
// gate's exact-match allowlist check. That surfaces as a per-item `error`
// (env.fetch denied), not a run failure; this example does not attempt to fix
// extract-urls, it just tolerates the resulting per-item miss.

import './markdown-dom-polyfill';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_ITEMS = 3;
const MARKDOWN_LIMIT = 1200;

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

type FeedItem = { title: string | null; link: string | null };

function extractBlocks(body: string): { blocks: string[]; kind: 'rss' | 'atom' } {
	const items = [...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
	if (items.length > 0) return { blocks: items, kind: 'rss' };
	const entries = [...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
	return { blocks: entries, kind: 'atom' };
}

function extractFeedTitle(body: string): string | null {
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

function extractItems(body: string): FeedItem[] {
	const { blocks, kind } = extractBlocks(body);
	return blocks.map((block) => ({ title: extractItemTitle(block), link: extractItemLink(block, kind) }));
}

async function digestItem(env: TransformEnv, item: FeedItem): Promise<unknown> {
	const url = item.link as string;
	try {
		if (!env.fetch) throw new Error('env.fetch is unavailable');
		const result = await env.fetch(url);
		if (result.status < 200 || result.status >= 300) {
			return { title: item.title, url, error: `Fetching the article failed: HTTP ${result.status}` };
		}

		const { document } = parseHTML(result.body);
		const defuddled = await Defuddle(document, url, { markdown: true });
		const markdown = defuddled.content ?? '';
		const markdownTruncated = markdown.length > MARKDOWN_LIMIT;

		return {
			title: item.title,
			url,
			markdown: markdownTruncated ? markdown.slice(0, MARKDOWN_LIMIT) : markdown,
			markdownTruncated,
			wordCount: defuddled.wordCount ?? null,
		};
	} catch (err) {
		return { title: item.title, url, error: err instanceof Error ? err.message : String(err) };
	}
}

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	const feedTitle = extractFeedTitle(input.body);
	const candidates = extractItems(input.body)
		.filter((item): item is FeedItem & { link: string } => Boolean(item.link) && /^https?:\/\//i.test(item.link as string))
		.slice(0, MAX_ITEMS);

	const items = await Promise.all(candidates.map((item) => digestItem(env, item)));

	return { feedTitle, itemCount: items.length, items };
}
