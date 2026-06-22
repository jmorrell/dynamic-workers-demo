import type { RunInput } from '../runtime/types';

export default async function transform(input: RunInput): Promise<unknown> {
	// Attempts a network call. globalOutbound: null makes this throw; the
	// harness converts it into a structured network_blocked error.
	const res = await fetch('https://example.com/should-be-blocked');
	return { status: res.status, from: input.url };
}
