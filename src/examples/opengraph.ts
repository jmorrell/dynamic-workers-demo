// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';
import { parseOpenGraph } from './lib/parse';

export default function transform(input: RunInput): unknown {
	return parseOpenGraph(input.body);
}
