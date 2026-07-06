// NOTE: Example payload (untrusted code). Not application code — executed via the loader. Not classified as Functional Core (fetch is the whole point of the demo).

import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	// Attempts a network call. globalOutbound: null makes this throw; the
	// harness converts it into a structured network_blocked error.
	const res = await fetch('https://example.com/should-be-blocked');
	return { status: res.status, from: input.url };
}
