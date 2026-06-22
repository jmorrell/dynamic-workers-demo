// pattern: Imperative Shell

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { RunInput, RunResult } from './types';
import { classifyTransformError } from './core';

// The user/example module is provided in the loaded worker's `modules` map.
// See Task 4 for the exact module key and why this specifier is used.
// Note: This import is for use in HARNESS_SOURCE (Task 4); it won't resolve
// at compile time but is valid in the generated worker string.
// @ts-expect-error user.js is injected by the loader at runtime
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import userModule from './user.js';

export default class Harness extends WorkerEntrypoint<{ INPUT: RunInput }> {
	async run(): Promise<RunResult> {
		const input = this.env.INPUT;

		const transform = (userModule as { default?: unknown })?.default ?? userModule;
		if (typeof transform !== 'function') {
			return {
				ok: false,
				error: {
					kind: 'no_transform',
					message: 'Module does not export a transform function',
				},
			};
		}

		try {
			const value = await (transform as (i: RunInput) => unknown)(input);
			return { ok: true, value };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: {
					kind: classifyTransformError(message),
					message,
				},
			};
		}
	}
}
