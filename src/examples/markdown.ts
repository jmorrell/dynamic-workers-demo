// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

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
