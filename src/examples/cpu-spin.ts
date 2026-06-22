// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';

export default function transform(_input: RunInput): unknown {
	// Intentionally hostile: a hot loop that never yields. The platform CPU
	// limit (limits.cpuMs) kills this deterministically.
	while (true) {
		// no-op
	}
}
