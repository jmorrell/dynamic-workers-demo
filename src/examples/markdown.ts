import './markdown-dom-polyfill';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  try {
    const { document } = parseHTML(input.body);
    const result = await Defuddle(document, input.finalUrl, {
      markdown: true,
    });
    return {
      markdown: result.content ?? '',
      json: {
        title: result.title ?? null,
        wordCount: result.wordCount ?? null,
      },
    };
  } catch (err) {
    return {
      markdown: '',
      json: {
        title: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
