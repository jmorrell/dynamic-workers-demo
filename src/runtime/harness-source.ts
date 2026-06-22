// pattern: Functional Core

/**
 * HARNESS_SOURCE is the harness module as a string that will be compiled
 * inside the loaded worker. It inlines classifyTransformError logic (identical
 * to core.ts) to avoid build dependencies in Phase 1.
 *
 * This string is used as the mainModule in env.LOADER.get(id, callback).
 */
export const HARNESS_SOURCE = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import userModule from './user.js';

// SYNC PARTNER: Keep this inlined copy in sync with src/runtime/core.ts classifyTransformError.
// Both must match exactly. Core.ts is the canonical version (tested in core.spec.ts).
// Update both locations together if changing matched substrings or logic.
function classifyTransformError(message) {
  const lower = message.toLowerCase();
  if (
    lower.includes('disallowed') ||
    lower.includes('not allowed') ||
    lower.includes('globaloutbound') ||
    lower.includes('not permitted to access the internet') ||
    lower.includes('cannot access the internet')
  ) {
    return 'network_blocked';
  }
  return 'transform_threw';
}

export default class Harness extends WorkerEntrypoint {
  async run() {
    const input = (this.env).INPUT;

    const transform = (userModule?.default) ?? userModule;
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
      const value = await transform(input);
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
`;
