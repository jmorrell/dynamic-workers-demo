import './markdown-dom-polyfill';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_ITEMS = 6;
const MARKDOWN_LIMIT = 1200;
const EXCERPT_LIMIT = 300;

function excerpt(markdown: string): string {
  const trimmed = markdown.trim();
  return trimmed.length > EXCERPT_LIMIT
    ? `${trimmed.slice(0, EXCERPT_LIMIT)}…`
    : trimmed;
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function stripCdata(value: string): string {
  const match = value.match(
    /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/,
  );
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

function extractBlocks(body: string): {
  blocks: string[];
  kind: 'rss' | 'atom';
} {
  const items = [
    ...body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
  ].map((m) => m[1]);
  if (items.length > 0) return { blocks: items, kind: 'rss' };
  const entries = [
    ...body.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);
  return { blocks: entries, kind: 'atom' };
}

function extractFeedTitle(body: string): string | null {
  const firstBlockIndex = body.search(/<(item|entry)\b/i);
  const head =
    firstBlockIndex >= 0 ? body.slice(0, firstBlockIndex) : body;
  const match = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : null;
}

function extractItemTitle(block: string): string | null {
  const match = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : null;
}

function extractItemLink(
  block: string,
  kind: 'rss' | 'atom',
): string | null {
  if (kind === 'atom') {
    for (const linkMatch of block.matchAll(
      /<link\b([^>]*)\/?>/gi,
    )) {
      const attrs = linkMatch[1];
      const hrefMatch = attrs.match(/href="([^"]*)"/i);
      if (!hrefMatch) continue;
      const relMatch = attrs.match(/rel="([^"]*)"/i);
      if (!relMatch || relMatch[1].toLowerCase() === 'alternate')
        return decodeEntities(hrefMatch[1]);
    }
    return null;
  }
  const match = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

function extractItems(body: string): FeedItem[] {
  const { blocks, kind } = extractBlocks(body);
  return blocks.map((block) => ({
    title: extractItemTitle(block),
    link: extractItemLink(block, kind),
  }));
}

async function digestItem(
  env: TransformEnv,
  item: FeedItem,
): Promise<unknown> {
  const url = item.link as string;
  try {
    console.log(
      `Reading article "${item.title ?? displayUrl(url)}"`,
    );

    const resource = env.resources?.get(url);
    if (!resource) {
      throw new Error(
        `No resource capability was granted for ${url}`,
      );
    }
    const result = await resource.read();
    if (result.kind !== 'text') {
      throw new Error(
        `Expected a text resource for ${url}, got ${result.contentType}`,
      );
    }
    if (result.status < 200 || result.status >= 300) {
      console.log(
        `Article read failed with HTTP ${result.status}: ${displayUrl(url)}`,
      );
      return {
        title: item.title,
        url,
        error:
          'Fetching the article failed: HTTP ' + result.status,
      };
    }

    const { document } = parseHTML(result.body);
    const defuddled = await Defuddle(document, url, {
      markdown: true,
    });
    const markdown = defuddled.content ?? '';
    const markdownTruncated = markdown.length > MARKDOWN_LIMIT;

    console.log(
      `Extracted ${defuddled.wordCount ?? 'unknown'} words from ${displayUrl(url)}` +
        (markdownTruncated ? ` (output capped at ${MARKDOWN_LIMIT} characters)` : ''),
    );

    return {
      title: item.title,
      url,
      markdown: markdownTruncated
        ? markdown.slice(0, MARKDOWN_LIMIT)
        : markdown,
      markdownTruncated,
      wordCount: defuddled.wordCount ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `Could not digest ${displayUrl(url)}: ${message}`,
    );
    return {
      title: item.title,
      url,
      error: message,
    };
  }
}

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  const feedTitle = extractFeedTitle(input.body);
  const feedItems = extractItems(input.body);
  const candidates = feedItems
    .filter(
      (item): item is FeedItem & { link: string } =>
        Boolean(item.link) &&
        /^https?:\/\//i.test(item.link as string),
    )
    .slice(0, MAX_ITEMS);

  console.log(
    `Parsed "${feedTitle ?? 'Untitled feed'}" from ${displayUrl(input.finalUrl)}: ` +
      `${feedItems.length} entries, following ${candidates.length}, ` +
      `${env.resources?.size ?? 0} resource capabilities available`,
  );

  const items = await Promise.all(
    candidates.map((item) => digestItem(env, item)),
  );

  const failedItems = items.filter(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'error' in item,
  ).length;

  console.log(
    `Finished: ${items.length - failedItems} articles extracted, ${failedItems} failed`,
  );

  const markdown = [
    `# ${feedTitle ?? 'Feed digest'}`,
    ...items.map((item) => {
      const {
        title,
        url,
        markdown: itemMarkdown,
        error,
      } = item as {
        title: string | null;
        url: string;
        markdown?: string;
        error?: string;
      };
      const heading = `## [${title ?? url}](${url})`;
      const body =
        typeof itemMarkdown === 'string'
          ? excerpt(itemMarkdown)
          : `_Error: ${error}_`;
      return `${heading}\n\n${body}`;
    }),
  ].join('\n\n');

  return {
    markdown,
    json: { feedTitle, itemCount: items.length, items },
  };
}
