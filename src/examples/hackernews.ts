// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';
import { parseHnTopComments } from './lib/parse';

export default function transform(input: RunInput): unknown {
	return parseHnTopComments(input.body);
}
