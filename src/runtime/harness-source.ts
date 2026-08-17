import { STORE_MAX_BYTES } from './core';

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
 *    entrypoint does PLUS exposes `env.DB` backed by the facet's OWN isolated
 *    SQLite database (`this.ctx.storage.sql`), which is the isolation boundary.
 *
 * The store cap constants are interpolated from core.ts so there is a single
 * source of truth for the number; the CAP LOGIC (checkDatabaseSize) and the
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

// Builds target-bound resource capabilities from opaque grants. User code gets
// zero-argument read() closures, never the gate or a method accepting a URL.
// Text results recursively wrap their newly minted child grants, making
// transitive authority explicit in the returned document rather than growing a
// magical global fetch allowlist.
function gateCapabilities(env) {
  const gate = env && env.GATE;
  const initialGrants = env && env.RESOURCE_GRANTS;
  if (!gate || !Array.isArray(initialGrants)) return {};

  function wrapResources(grants) {
    const resources = new Map();
    for (const grant of grants) {
      const capability = Object.freeze({
        url: grant.url,
        source: grant.source,
        async read() {
          const result = await gate.readResource(grant.id);
          return result.kind === 'text'
            ? { ...result, resources: wrapResources(result.resources) }
            : result;
        },
      });
      resources.set(grant.url, capability);
    }
    return resources;
  }

  return { resources: wrapResources(initialGrants) };
}

export default class Harness extends WorkerEntrypoint {
  // input is passed per invocation (RPC arg), NOT read from env — the loader
  // caches the compiled worker by code hash, so baking INPUT into env would
  // make a second run of identical code reuse the first run's stale input.
  async run(input) {
    // Build the capability object handed to the transform as its FIRST argument.
    // Empty by default (no network). Under a page-links grant, expose only the
    // target-bound resource map built above. A gate rejection throws and
    // surfaces as a normal transform error unless the transform catches it.
    const userEnv = gateCapabilities(this.env);
    return invokeTransform(userEnv, input);
  }
}

// Storage run path: mounted as a DO facet by the StorageHost supervisor. Its
// ctx.storage targets the facet's OWN isolated SQLite DB — the whole isolation
// story (hostile code can only trash its own facet). run(input) mirrors the
// default entrypoint plus an env.DB wrapper over ctx.storage.sql.
export class StorageHarness extends DurableObject {
  async run(input) {
    const userEnv = gateCapabilities(this.env);
    userEnv.DB = this._buildDatabase();
    return invokeTransform(userEnv, input);
  }

  // env.DB: arbitrary SQLite over the facet's own database. Each exec is
  // materialized inside a synchronous transaction. If it grows the database
  // past the cap, throwing rolls back the whole query. Queries that do not grow
  // the database remain available so user code can clean up an over-full DB.
  // SYNC PARTNER: mirrors core.ts checkDatabaseSize.
  _buildDatabase() {
    const storage = this.ctx.storage;
    const sql = this.ctx.storage.sql;
    return {
      get databaseSize() {
        return sql.databaseSize;
      },
      exec(query, ...bindings) {
        const databaseSizeBefore = sql.databaseSize;
        return storage.transactionSync(() => {
          const cursor = sql.exec(String(query), ...bindings);
          const rows = cursor.toArray();
          const result = {
            columnNames: [...cursor.columnNames],
            rowsRead: cursor.rowsRead,
            rowsWritten: cursor.rowsWritten,
            toArray() {
              return rows;
            },
          };
          const databaseSizeAfter = sql.databaseSize;
          if (
            databaseSizeAfter > ${STORE_MAX_BYTES} &&
            databaseSizeAfter > databaseSizeBefore
          ) {
            throw new Error(
              'env.DB.exec denied: database full: ${STORE_MAX_BYTES}-byte limit exceeded',
            );
          }
          return result;
        });
      },
    };
  }
}
`;
