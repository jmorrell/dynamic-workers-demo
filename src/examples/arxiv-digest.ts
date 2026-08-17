import liteparseWasm from './liteparse.wasm';
import { LiteParse, initSync } from '@llamaindex/liteparse-wasm';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_PAPERS = 3;
const MAX_PAGES = 2;
const ABSTRACT_LIMIT = 600;
const EXCERPT_LIMIT = 1500;

const ABS_URL_REGEX =
  /https?:\/\/[^\s"'<>)\]]*arxiv\.org\/abs\/[^\s"'<>)\]]+/gi;

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function isAbsUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const isArxivHost =
    host === 'arxiv.org' || host.endsWith('.arxiv.org');
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    isArxivHost &&
    url.pathname.startsWith('/abs/')
  );
}

function normalizeAbsUrl(url: URL): string {
  url.hash = '';
  url.search = '';
  return url.toString();
}

function collectAbsUrls(input: RunInput): string[] {
  const base = input.finalUrl || input.url;
  const found: string[] = [];

  const contentType = input.contentType
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml'
  ) {
    try {
      const { document } = parseHTML(input.body);
      for (const el of document.querySelectorAll('a[href]')) {
        const href = el.getAttribute('href');
        if (!href) continue;
        try {
          const resolved = new URL(href, base);
          if (isAbsUrl(resolved))
            found.push(normalizeAbsUrl(resolved));
        } catch {}
      }
    } catch {}
  }

  for (const match of input.body.match(ABS_URL_REGEX) ?? []) {
    try {
      const resolved = new URL(match);
      if (isAbsUrl(resolved))
        found.push(normalizeAbsUrl(resolved));
    } catch {}
  }

  return [...new Set(found)].slice(0, MAX_PAPERS);
}

function resolvePdfUrl(
  document: ReturnType<typeof parseHTML>['document'],
  absUrl: string,
): URL | undefined {
  const metaPdf = document
    .querySelector('meta[name="citation_pdf_url"]')
    ?.getAttribute('content');
  if (metaPdf) {
    try {
      return new URL(metaPdf, absUrl);
    } catch {}
  }

  for (const el of document.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, absUrl);
    } catch {
      continue;
    }
    if (
      resolved.protocol !== 'http:' &&
      resolved.protocol !== 'https:'
    )
      continue;
    if (!resolved.pathname.startsWith('/pdf/')) continue;
    return resolved;
  }
  return undefined;
}

async function fetchPaper(
  env: TransformEnv,
  absUrl: string,
): Promise<unknown> {
  try {
    console.log(`Reading abstract ${displayUrl(absUrl)}`);
    const abstractResource = env.resources?.get(absUrl);
    if (!abstractResource) {
      throw new Error(
        `No resource capability was granted for ${absUrl}`,
      );
    }
    const absResult = await abstractResource.read();
    if (absResult.kind !== 'text') {
      throw new Error(
        'Expected a text resource for the abstract page, got ' +
          absResult.contentType,
      );
    }
    if (absResult.status < 200 || absResult.status >= 300) {
      throw new Error(
        'Fetching the abstract page failed: HTTP ' +
          `${absResult.status} ` +
          `for ${absUrl}`,
      );
    }

    const { document } = parseHTML(absResult.body);

    const title =
      document
        .querySelector('meta[name="citation_title"]')
        ?.getAttribute('content')
        ?.trim() ||
      document
        .querySelector('h1')
        ?.textContent?.replace(/^Title:\s*/i, '')
        .trim() ||
      null;

    const authors =
      [
        ...document.querySelectorAll(
          'meta[name="citation_author"]',
        ),
      ]
        .map((el) => el.getAttribute('content')?.trim())
        .filter((a): a is string => Boolean(a))
        .join(', ') || null;

    const abstractRaw =
      document.querySelector('blockquote.abstract')
        ?.textContent ?? '';
    const abstractCleaned =
      abstractRaw
        .replace(/^\s*Abstract:?\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim() || null;
    const abstract =
      abstractCleaned && abstractCleaned.length > ABSTRACT_LIMIT
        ? abstractCleaned.slice(0, ABSTRACT_LIMIT)
        : abstractCleaned;

    const pdfUrl = resolvePdfUrl(document, absUrl);
    if (!pdfUrl) {
      throw new Error(
        'No PDF link (citation_pdf_url meta or a[href] ' +
          'starting with ' +
          `/pdf/) found on the abstract page at ${absUrl}.`,
      );
    }

    const pdfUrlString = pdfUrl.toString();
    console.log(
      `Found PDF for "${title ?? displayUrl(absUrl)}": ${displayUrl(pdfUrlString)}`,
    );
    const pdfResource = absResult.resources.get(pdfUrlString);
    if (!pdfResource) {
      throw new Error(
        `No resource capability was granted for ${pdfUrlString} ` +
          'by the abstract page.',
      );
    }
    const file = await pdfResource.read();
    if (file.kind !== 'bytes') {
      throw new Error(
        'Expected a binary resource but got content-type ' +
          `"${file.contentType}" for ${pdfUrlString}`,
      );
    }
    if (file.status < 200 || file.status >= 300) {
      throw new Error(
        `Fetching the PDF failed: HTTP ${file.status} ` +
          `for ${pdfUrlString}`,
      );
    }
    if (
      !file.contentType
        .split(';')[0]
        .trim()
        .toLowerCase()
        .startsWith('application/pdf')
    ) {
      throw new Error(
        'Expected a PDF but got content-type ' +
          `"${file.contentType}" ` +
          `for ${pdfUrlString}`,
      );
    }
    if (file.truncated) {
      throw new Error(
        `The PDF at ${pdfUrlString} was truncated ` +
          'by the fetch cap ' +
          'and cannot be reliably parsed.',
      );
    }

    initSync({ module: liteparseWasm });
    const parser = new LiteParse({
      ocrEnabled: false,
      outputFormat: 'markdown',
      maxPages: MAX_PAGES,
      quiet: true,
    });
    const result = await parser.parse(file.bytes);

    const excerptTruncated = result.text.length > EXCERPT_LIMIT;
    const excerpt = excerptTruncated
      ? result.text.slice(0, EXCERPT_LIMIT)
      : result.text;

    console.log(
      `Parsed ${result.pages.length} PDF pages for "${title ?? displayUrl(absUrl)}"` +
        (excerptTruncated ? ` (excerpt capped at ${EXCERPT_LIMIT} characters)` : ''),
    );

    return {
      absUrl,
      title,
      authors,
      abstract,
      pdfPages: result.pages.length,
      excerpt,
      excerptTruncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `Could not digest ${displayUrl(absUrl)}: ${message}`,
    );
    return {
      absUrl,
      error: message,
    };
  }
}

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  const absUrls = collectAbsUrls(input);
  if (absUrls.length === 0) {
    throw new Error(
      'No arXiv abstract links found (neither a[href] ' +
        'values nor bare URLs matching ' +
        'https://arxiv.org/abs/{id}) — point this ' +
        'example at ' +
        'a page that cites arXiv papers, e.g. ' +
        'https://arxiv.org/list/cs.LG/recent or a ' +
        'Wikipedia article with ' +
        'arXiv citations.',
    );
  }

  console.log(
    `Found ${absUrls.length} arXiv papers to digest` +
      (absUrls.length >= MAX_PAPERS ? ` (limit ${MAX_PAPERS})` : ''),
  );

  const papers: unknown[] = [];
  for (const absUrl of absUrls) {
    papers.push(await fetchPaper(env, absUrl));
  }

  const failedPapers = papers.filter(
    (paper) =>
      typeof paper === 'object' &&
      paper !== null &&
      'error' in paper,
  ).length;
  console.log(
    `Finished: ${papers.length - failedPapers} papers digested, ${failedPapers} failed`,
  );

  return { papersFound: papers.length, papers };
}
