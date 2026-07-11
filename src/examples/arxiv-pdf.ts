// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// `./liteparse.wasm` is the liteparse.wasm tab of this editor — the real
// @llamaindex/liteparse-wasm binary (liteparse_wasm_bg.wasm), injected by the
// loader the same way wasm-add's add.wasm and image-hash's photon.wasm are.
// workerd forbids compiling wasm from raw bytes at runtime ("Wasm code
// generation disallowed by embedder"), so the only usable path is importing a
// WebAssembly.Module directly and handing it to the glue's sync initializer —
// no WebAssembly.instantiate(bytes) anywhere in this file. liteparse's
// initSync is idempotent (returns early once already initialized), unlike
// photon's initPhoton, so no re-init guard is needed here even in a warm,
// reused Dynamic Worker isolate. Parsing is text-layer only (ocrEnabled:
// false, no OCR pass) — that suits arXiv papers, which are text-based PDFs,
// and keeps this well inside the CPU budget.
import liteparseWasm from './liteparse.wasm';
import { LiteParse, initSync } from '@llamaindex/liteparse-wasm';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_PAGES = 15;
const MARKDOWN_LIMIT = 60000;

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
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
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
		if (!resolved.pathname.startsWith('/pdf/')) continue;
		pdfUrl = resolved;
		break;
	}

	if (!pdfUrl) {
		throw new Error(
			'No PDF link (a[href] starting with /pdf/) found on this page — point this example at an arXiv abstract page, e.g. https://arxiv.org/abs/{id}.',
		);
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

	const headingMatch = result.text.match(/^#\s+(.+)$/m);
	const title = headingMatch ? headingMatch[1].trim() : null;

	const markdownTruncated = result.text.length > MARKDOWN_LIMIT;
	const markdown = markdownTruncated ? result.text.slice(0, MARKDOWN_LIMIT) : result.text;

	return {
		pdfUrl: pdfUrl.toString(),
		title,
		pages: result.pages.length,
		pagesCapped: result.pages.length >= MAX_PAGES,
		markdown,
		markdownTruncated,
	};
}
