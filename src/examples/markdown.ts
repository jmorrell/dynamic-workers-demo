// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// Side-effect import: must precede the defuddle/node import (see file comment
// there for why order matters — Turndown resolves its HTML parser from
// `window`/`DOMParser` at ITS module-eval time, which happens as part of
// evaluating this file's imports, before transform() ever runs).
import './markdown-dom-polyfill';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { RunInput } from '../runtime/types';

export default async function transform(input: RunInput): Promise<unknown> {
	try {
		const { document } = parseHTML(input.body);
		const result = await Defuddle(document, input.finalUrl, { markdown: true });
		return { title: result.title ?? null, markdown: result.content ?? '', wordCount: result.wordCount ?? null };
	} catch (err) {
		return { title: null, markdown: '', error: err instanceof Error ? err.message : String(err) };
	}
}
