import liteparseWasm from './liteparse.wasm';
import { LiteParse, initSync } from '@llamaindex/liteparse-wasm';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_PAGES = 15;
const MARKDOWN_LIMIT = 60000;

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  const { document } = parseHTML(input.body);
  const base = input.finalUrl || input.url;

  let pdfUrl: URL | undefined;
  for (const el of document.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (
      resolved.protocol !== 'http:' &&
      resolved.protocol !== 'https:'
    )
      continue;
    if (!resolved.pathname.startsWith('/pdf/')) continue;
    pdfUrl = resolved;
    break;
  }

  if (!pdfUrl) {
    throw new Error(
      'No PDF link (a[href] starting with /pdf/) found ' +
        'on this page — ' +
        'point this example at an arXiv abstract page, e.g. ' +
        'https://arxiv.org/abs/{id}.',
    );
  }

  const pdfUrlString = pdfUrl.toString();
  console.log(
    `Found PDF link ${displayUrl(pdfUrlString)}`,
  );
  const resource = env.resources?.get(pdfUrlString);
  if (!resource) {
    throw new Error(
      `No resource capability was granted for ${pdfUrlString}`,
    );
  }
  const file = await resource.read();
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

  console.log(
    `Read ${formatBytes(file.bytes.byteLength)} PDF; parsing up to ${MAX_PAGES} pages`,
  );

  initSync({ module: liteparseWasm });
  const parser = new LiteParse({
    ocrEnabled: false,
    outputFormat: 'markdown',
    maxPages: MAX_PAGES,
    quiet: true,
  });
  const result = await parser.parse(file.bytes);

  const headingMatch = result.text.match(/^#\s+(.+)$/m);
  const title = headingMatch ? headingMatch[1].trim() : null;

  const markdownTruncated = result.text.length > MARKDOWN_LIMIT;
  const markdown = markdownTruncated
    ? result.text.slice(0, MARKDOWN_LIMIT)
    : result.text;

  console.log(
    `Parsed ${result.pages.length} pages` +
      (title ? ` from "${title}"` : '') +
      (result.pages.length >= MAX_PAGES ? ` (page limit ${MAX_PAGES} reached)` : '') +
      (markdownTruncated ? `; markdown capped at ${MARKDOWN_LIMIT} characters` : ''),
  );

  return {
    markdown,
    json: {
      pdfUrl: pdfUrl.toString(),
      title,
      pages: result.pages.length,
      pagesCapped: result.pages.length >= MAX_PAGES,
      markdownTruncated,
    },
  };
}
