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
  // input is passed per invocation (RPC arg), NOT read from env — the loader
  // caches the compiled worker by code hash, so baking INPUT into env would
  // make a second run of identical code reuse the first run's stale input.
  async run(input) {
    const transform = (userModule?.default) ?? userModule;
    if (typeof transform !== 'function') {
      return {
        type: 'failure',
        error: {
          kind: 'no_transform',
          message: 'Module does not export a transform function',
        },
      };
    }

    // Build the capability object handed to the transform as its FIRST argument.
    // Empty by default (no network). When the loader attached the CapabilityGate
    // loopback (fetch permission), expose fetch/fetchFile that proxy to the host
    // gate, which enforces the allowlist and safety rails. A gate rejection throws
    // and surfaces as a normal transform error unless the transform catches it.
    const gate = this.env && this.env.GATE;
    const userEnv = gate
      ? {
          fetch: (url) => gate.fetchText(url),
          fetchFile: (url) => gate.fetchFile(url),
        }
      : {};

    try {
      const value = await transform(userEnv, input);
      return { type: 'success', value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: 'failure',
        error: {
          kind: classifyTransformError(message),
          message,
        },
      };
    }
  }
}
`;
