import { STORE_MAX_BYTES, STORE_MAX_KEY_BYTES, STORE_MAX_KEYS, STORE_MAX_VALUE_BYTES } from './core';

/**
 * HARNESS_SOURCE is the harness module as a string that will be compiled
 * inside the loaded worker. It inlines classifyTransformError logic (identical
 * to core.ts) to avoid build dependencies in Phase 1.
 *
 * It exports TWO things:
 *  - the default `Harness` WorkerEntrypoint (the direct, non-storage run path;
 *    `runInLoader` invokes `getEntrypoint().run(input)`), and
 *  - a `StorageHarness` Durable Object class (the storage run path; the
 *    `StorageHost` supervisor mounts it as a facet and RPCs `run(input)` — see
 *    src/runtime/storage-host.ts). Its `run` does exactly what the default
 *    entrypoint does PLUS exposes `env.storage` backed by the facet's OWN
 *    isolated SQLite DB (`this.ctx.storage.kv`), which is the isolation boundary.
 *
 * The store cap constants are interpolated from core.ts so there is a single
 * source of truth for the numbers; the CAP LOGIC (checkStorageWrite) and the
 * error classifier are inlined by hand — SYNC PARTNER with core.ts.
 */
export const HARNESS_SOURCE = `
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
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

function resolveTransform() {
  const transform = (userModule?.default) ?? userModule;
  return typeof transform === 'function' ? transform : null;
}

async function invokeTransform(userEnv, input) {
  const transform = resolveTransform();
  if (!transform) {
    return {
      type: 'failure',
      error: {
        kind: 'no_transform',
        message: 'Module does not export a transform function',
      },
    };
  }
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

// Builds the { fetch, fetchFile } half of userEnv from the CapabilityGate
// loopback the loader attaches under a page-links grant (env.GATE). Empty when
// no gate is attached. Shared by both run paths so fetch+storage grants compose.
function gateCapabilities(env) {
  const gate = env && env.GATE;
  return gate
    ? {
        fetch: (url) => gate.fetchText(url),
        fetchFile: (url) => gate.fetchFile(url),
      }
    : {};
}

export default class Harness extends WorkerEntrypoint {
  // input is passed per invocation (RPC arg), NOT read from env — the loader
  // caches the compiled worker by code hash, so baking INPUT into env would
  // make a second run of identical code reuse the first run's stale input.
  async run(input) {
    // Build the capability object handed to the transform as its FIRST argument.
    // Empty by default (no network). When the loader attached the CapabilityGate
    // loopback (fetch permission), expose fetch/fetchFile that proxy to the host
    // gate. A gate rejection throws and surfaces as a normal transform error
    // unless the transform catches it.
    const userEnv = gateCapabilities(this.env);
    return invokeTransform(userEnv, input);
  }
}

// Storage run path: mounted as a DO facet by the StorageHost supervisor. Its
// ctx.storage targets the facet's OWN isolated SQLite DB — the whole isolation
// story (hostile code can only trash its own facet). run(input) mirrors the
// default entrypoint plus an env.storage wrapper over ctx.storage.kv.
export class StorageHarness extends DurableObject {
  async run(input) {
    const userEnv = gateCapabilities(this.env);
    userEnv.storage = this._buildStorage();
    return invokeTransform(userEnv, input);
  }

  // env.storage: get/put/delete/list over the facet's own kv, JSON-encoding
  // values (plain data only) and enforcing the caps. SYNC PARTNER: the cap
  // ordering/logic mirrors core.ts checkStorageWrite; the numeric limits are
  // interpolated from core.ts constants (single source of truth).
  _buildStorage() {
    const kv = this.ctx.storage.kv;
    const sql = this.ctx.storage.sql;
    const enc = new TextEncoder();
    const countKeys = () => {
      let n = 0;
      for (const _ of kv.list()) n++;
      return n;
    };
    return {
      get(key) {
        const raw = kv.get(String(key));
        return raw === undefined ? undefined : JSON.parse(raw);
      },
      put(key, value) {
        const k = String(key);
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          throw new Error('env.storage.put: value must be JSON-serializable plain data');
        }
        // Hard backstop first (authoritative — includes SQLite overhead), then
        // the per-op advisory caps. Mirrors core.ts checkStorageWrite order.
        const dbSize = sql.databaseSize;
        if (dbSize >= ${STORE_MAX_BYTES}) {
          throw new Error('env.storage.put denied: storage full: ${STORE_MAX_BYTES}-byte database cap reached');
        }
        if (enc.encode(k).length > ${STORE_MAX_KEY_BYTES}) {
          throw new Error('env.storage.put denied: storage key exceeds ${STORE_MAX_KEY_BYTES}-byte limit');
        }
        if (enc.encode(serialized).length > ${STORE_MAX_VALUE_BYTES}) {
          throw new Error('env.storage.put denied: storage value exceeds ${STORE_MAX_VALUE_BYTES}-byte limit');
        }
        const exists = kv.get(k) !== undefined;
        if (!exists && countKeys() >= ${STORE_MAX_KEYS}) {
          throw new Error('env.storage.put denied: storage key count exceeds ${STORE_MAX_KEYS}-key limit');
        }
        kv.put(k, serialized);
      },
      delete(key) {
        return kv.delete(String(key));
      },
      list() {
        const out = [];
        for (const [k] of kv.list()) out.push(k);
        return out;
      },
    };
  }
}
`;
