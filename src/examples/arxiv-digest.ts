// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// Point this at ANY page that references arXiv abstract pages — an arXiv
// listing page, a Wikipedia article's references section, a blog post, an HN
// thread. Collects up to 3 arXiv "/abs/" links, follows each to its abstract
// page, then follows the PDF link found ON that abstract page and parses it
// to markdown with the liteparse wasm library (see arxiv-pdf.ts for the
// wasm-injection contract this reuses verbatim).
//
// Why fetchDepth: 2 (unlike arxiv-pdf's default depth 1): the INPUT page only
// links the abstract page — it does not link the PDF directly. The PDF link
// lives on the abstract page, one hop further out. Depth 1 would let us
// env.fetch the abstract page (a link from the input), but env.fetchFile on
// the PDF discovered inside it would be denied — the PDF URL is only
// reachable by growing the allowlist from a page this run has already
// text-fetched. Depth 2 grants exactly that one extra hop. (An arXiv listing
// page happens to link PDFs directly too, so it would work even at depth 1 —
// but a Wikipedia article or blog post citing a paper never does, and depth 2
// is what makes this example work generically on any citing page, not just
// arXiv's own listings.)
//
// Why maxFetches: 6 (default is 5): each paper costs 2 gate fetches — env.fetch
// on the abstract page, then env.fetchFile on its PDF — so MAX_PAPERS (3) papers
// need up to 3 × 2 = 6 gate fetches in the worst case (no per-paper failures).

import liteparseWasm from './liteparse.wasm';
import { LiteParse, initSync } from '@llamaindex/liteparse-wasm';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_PAPERS = 3;
const MAX_PAGES = 2;
const ABSTRACT_LIMIT = 600;
const EXCERPT_LIMIT = 1500;

// Absolute https?://…arxiv.org/abs/<id> occurrences anywhere in the raw body —
// covers non-HTML inputs and contexts an HTML parse wouldn't reach (e.g. a
// bare URL in plain text or inside a <script> blob).
const ABS_URL_REGEX = /https?:\/\/[^\s"'<>)\]]*arxiv\.org\/abs\/[^\s"'<>)\]]+/gi;

function isAbsUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	// Suffix match alone would also accept e.g. "evilarxiv.org" — require the
	// bare host or a real subdomain boundary.
	const isArxivHost = host === 'arxiv.org' || host.endsWith('.arxiv.org');
	return (url.protocol === 'http:' || url.protocol === 'https:') && isArxivHost && url.pathname.startsWith('/abs/');
}

function normalizeAbsUrl(url: URL): string {
	url.hash = '';
	url.search = '';
	return url.toString();
}

function collectAbsUrls(input: RunInput): string[] {
	const base = input.finalUrl || input.url;
	const found: string[] = [];

	const contentType = input.contentType.split(';')[0].trim().toLowerCase();
	if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
		try {
			const { document } = parseHTML(input.body);
			for (const el of document.querySelectorAll('a[href]')) {
				const href = el.getAttribute('href');
				if (!href) continue;
				try {
					const resolved = new URL(href, base);
					if (isAbsUrl(resolved)) found.push(normalizeAbsUrl(resolved));
				} catch {
					// Not a resolvable URL; skip.
				}
			}
		} catch {
			// Not parseable HTML; fall through to the regex scan below.
		}
	}

	for (const match of input.body.match(ABS_URL_REGEX) ?? []) {
		try {
			const resolved = new URL(match);
			if (isAbsUrl(resolved)) found.push(normalizeAbsUrl(resolved));
		} catch {
			// Malformed match; skip.
		}
	}

	return [...new Set(found)].slice(0, MAX_PAPERS);
}

function resolvePdfUrl(document: ReturnType<typeof parseHTML>['document'], absUrl: string): URL | undefined {
	const metaPdf = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute('content');
	if (metaPdf) {
		try {
			return new URL(metaPdf, absUrl);
		} catch {
			// Fall through to the anchor scan below.
		}
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
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
		if (!resolved.pathname.startsWith('/pdf/')) continue;
		return resolved;
	}
	return undefined;
}

async function fetchPaper(env: TransformEnv, absUrl: string): Promise<unknown> {
	try {
		if (!env.fetch) throw new Error('env.fetch is unavailable');
		const absResult = await env.fetch(absUrl);
		if (absResult.status < 200 || absResult.status >= 300) {
			throw new Error(`Fetching the abstract page failed: HTTP ${absResult.status} for ${absUrl}`);
		}

		const { document } = parseHTML(absResult.body);

		const title =
			document.querySelector('meta[name="citation_title"]')?.getAttribute('content')?.trim() ||
			document.querySelector('h1')?.textContent?.replace(/^Title:\s*/i, '').trim() ||
			null;

		const authors =
			[...document.querySelectorAll('meta[name="citation_author"]')]
				.map((el) => el.getAttribute('content')?.trim())
				.filter((a): a is string => Boolean(a))
				.join(', ') || null;

		const abstractRaw = document.querySelector('blockquote.abstract')?.textContent ?? '';
		const abstractCleaned = abstractRaw.replace(/^\s*Abstract:?\s*/i, '').replace(/\s+/g, ' ').trim() || null;
		const abstract = abstractCleaned && abstractCleaned.length > ABSTRACT_LIMIT ? abstractCleaned.slice(0, ABSTRACT_LIMIT) : abstractCleaned;

		const pdfUrl = resolvePdfUrl(document, absUrl);
		if (!pdfUrl) {
			throw new Error(`No PDF link (citation_pdf_url meta or a[href] starting with /pdf/) found on the abstract page at ${absUrl}.`);
		}

		if (!env.fetchFile) throw new Error('env.fetchFile is unavailable');
		const file = await env.fetchFile(pdfUrl.toString());
		if (file.status < 200 || file.status >= 300) {
			throw new Error(`Fetching the PDF failed: HTTP ${file.status} for ${pdfUrl.toString()}`);
		}
		if (!file.contentType.split(';')[0].trim().toLowerCase().startsWith('application/pdf')) {
			throw new Error(`Expected a PDF but got content-type "${file.contentType}" for ${pdfUrl.toString()}`);
		}
		if (file.truncated) {
			throw new Error(`The PDF at ${pdfUrl.toString()} was truncated by the fetch cap and cannot be reliably parsed.`);
		}

		initSync({ module: liteparseWasm });
		const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', maxPages: MAX_PAGES, quiet: true });
		const result = await parser.parse(file.bytes);

		const excerptTruncated = result.text.length > EXCERPT_LIMIT;
		const excerpt = excerptTruncated ? result.text.slice(0, EXCERPT_LIMIT) : result.text;

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
		return { absUrl, error: err instanceof Error ? err.message : String(err) };
	}
}

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	const absUrls = collectAbsUrls(input);
	if (absUrls.length === 0) {
		throw new Error(
			'No arXiv abstract links found (neither a[href] values nor bare URLs matching https://arxiv.org/abs/{id}) — point this example at a page that cites arXiv papers, e.g. https://arxiv.org/list/cs.LG/recent or a Wikipedia article with arXiv citations.',
		);
	}

	// Sequential, not Promise.all: liteparse's initSync is idempotent but is not
	// documented as safe to race concurrently, and at most 3 papers keeps this
	// well inside the CPU budget either way.
	const papers: unknown[] = [];
	for (const absUrl of absUrls) {
		papers.push(await fetchPaper(env, absUrl));
	}

	return { papersFound: papers.length, papers };
}
