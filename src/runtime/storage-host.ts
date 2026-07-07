import { DurableObject } from 'cloudflare:workers';
import { buildWorkerCode } from './loader';
import { classifyLoaderError, hashCode, selectEvictions } from './core';
import { collectGateSpans, releaseGateRun } from './capability-gate';
import type { RunInput, RunResult, Permissions } from './types';
import type { GateSpanDraft } from './trace';

/**
 * StorageHost — the supervisor Durable Object for the `storage: 'scoped'`
 * capability. Two roles, both served by this one class (chosen over a second DO
 * class to keep the surface small; the roles never overlap on a given instance):
 *
 *  1. **Store supervisor** (`idFromName(storeId)`): a storage-granted run routes
 *     `handleRun → STORAGE_HOST.get(idFromName(storeId)).run(...)` instead of
 *     calling `runInLoader` directly. This DO loads the SAME harness+user worker
 *     via `this.env.LOADER` (built by the shared `buildWorkerCode`), then, rather
 *     than invoking the default entrypoint, mounts the worker's `StorageHarness`
 *     DO class as a facet (`ctx.facets.get(storeKey, …)`) and RPCs `run(input)`.
 *     Each facet gets its OWN isolated SQLite DB — the isolation boundary.
 *
 *  2. **Per-IP registry singleton** (`idFromName(STORE_REGISTRY_NAME)`): maps
 *     clientIp → active storeIds (LRU, cap `STORE_CAP_PER_IP`); evicting a
 *     storeId tears down that store's supervisor. The sentinel name is not a
 *     uuid, so it can never collide with a real storeId.
 *
 * Trace composition: the CapabilityGate's module-scoped span/count maps live in
 * the isolate that constructed the loopback — HERE (this DO's isolate), NOT
 * handleRun's. So `run` drains `collectGateSpans(runId)` / `releaseGateRun(runId)`
 * itself and returns the drafts for handleRun to fold into its Tracer.
 *
 * Ephemerality: every run resets a sliding self-destruct alarm to now + 1h; on
 * fire the supervisor deletes its facets and evaporates (see `_teardown`).
 */

/** Per-store facet cap (LRU-evicted). */
export const STORE_FACET_CAP = 8;
/** Per-IP active-store cap (LRU-evicted, evictee torn down). */
export const STORE_CAP_PER_IP = 5;
/** Sliding self-destruct / registry-row expiry horizon. */
export const STORE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Supervisor bookkeeping key: JSON `[{ name, lastUsed }]` of RPC'd facets. */
const FACETS_KEY = 'facets';
/** Registry-role key prefix: `ip:<clientIp>` → JSON `[{ storeId, lastUsed }]`. */
const IP_KEY_PREFIX = 'ip:';

/** RPC argument for a storage-granted run (everything buildWorkerCode needs, plus input + storeKey). */
export type StorageRunArgs = {
	input: RunInput;
	code: string;
	runId: string;
	/** Facet name — the script identity within this supervisor (see deriveStoreKey). */
	storeKey: string;
	compatDate?: string;
	extraModules?: Record<string, string>;
	wasmModules?: Record<string, Uint8Array>;
	permissions?: Permissions;
	allowedUrls?: ReadonlyArray<string>;
};

/** RPC result: the structured run outcome plus the gate spans drained in this isolate. */
export type StorageRunResult = { result: RunResult; gateSpans: GateSpanDraft[] };

type FacetRow = { name: string; lastUsed: number };
type StoreRow = { storeId: string; lastUsed: number };

export class StorageHost extends DurableObject<Env> {
	/**
	 * Supervisor role: run a storage-granted transform against its facet. Never
	 * throws to handleRun — facet-mount/RPC failures surface as a structured
	 * RunResult (loader_failed taxonomy). In the vitest pool `ctx.facets` is
	 * undefined (facets don't exist there — see AGENTS.md gotchas); that surfaces
	 * as a structured error, not a crash.
	 */
	async run(args: StorageRunArgs): Promise<StorageRunResult> {
		const { input, code, runId, storeKey, ...opts } = args;
		try {
			// facets are absent in the vitest workers pool (workerd 1.20260310,
			// pre-April-2026 facets launch). Surface it as a structured error.
			const facets = this.ctx.facets;
			if (!facets) {
				return {
					result: { type: 'failure', error: { kind: 'loader_failed', message: 'Durable Object facets are unavailable in this runtime' } },
					gateSpans: [],
				};
			}

			// Same per-run loader id keying as runInLoader (the tail binding closes
			// over runId, so identical code across runs still needs a fresh isolate).
			const id = `${await hashCode(code)}:${runId}`;
			const worker = this.env.LOADER.get(id, async () => buildWorkerCode(this.env, code, runId, this.ctx.exports, opts));

			const facet = facets.get(storeKey, async () => ({ class: worker.getDurableObjectClass('StorageHarness') })) as unknown as {
				run(input: RunInput): Promise<RunResult>;
			};
			const result = await facet.run(input);

			// Track the facet only AFTER a successful RPC (spike: deleting a
			// never-RPC'd facet throws internal error). A structured-failure result
			// still means the facet mounted and ran, so it's trackable.
			await this._trackFacet(storeKey);
			await this._resetAlarm();

			return { result, gateSpans: collectGateSpans(runId) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { result: { type: 'failure', error: { kind: classifyLoaderError(message), message } }, gateSpans: collectGateSpans(runId) };
		} finally {
			// The returned array reference is already captured above; releasing here
			// only removes the module-map entry, matching handleRun's direct path.
			releaseGateRun(runId);
		}
	}

	/**
	 * Registry role: record that `clientIp` used `storeId` now, LRU-evict beyond
	 * `STORE_CAP_PER_IP`, and return the evicted storeIds so the caller can tear
	 * their supervisors down. Resets the sliding alarm (registry rows expire on
	 * the same ~1h horizon). Pure LRU math lives in `selectEvictions`.
	 */
	async touchStore(clientIp: string, storeId: string): Promise<string[]> {
		const key = IP_KEY_PREFIX + clientIp;
		const now = Date.now();
		const rows = this._readJson<StoreRow[]>(key) ?? [];
		const updated = rows.filter((r) => r.storeId !== storeId);
		updated.push({ storeId, lastUsed: now });

		const victims = selectEvictions(
			updated.map((r) => ({ key: r.storeId, lastUsed: r.lastUsed })),
			STORE_CAP_PER_IP,
		);
		const victimSet = new Set(victims);
		const survivors = updated.filter((r) => !victimSet.has(r.storeId));
		this.ctx.storage.kv.put(key, JSON.stringify(survivors));
		await this._resetAlarm();
		return victims;
	}

	/**
	 * Tears down this store's supervisor on demand (RPC'd by handleRun for an
	 * LRU-evicted store). Runs the same sequence as the self-destruct alarm.
	 */
	async selfDestruct(): Promise<void> {
		await this._teardown();
	}

	/** Sliding self-destruct: delete facets, drop bookkeeping, evaporate. */
	async alarm(): Promise<void> {
		await this._teardown();
	}

	// ---- bookkeeping (thin seam over ctx.storage.kv + ctx.facets) ----

	private _readJson<T>(key: string): T | null {
		const raw = this.ctx.storage.kv.get(key) as string | undefined;
		return raw ? (JSON.parse(raw) as T) : null;
	}

	private _readFacets(): FacetRow[] {
		return this._readJson<FacetRow[]>(FACETS_KEY) ?? [];
	}

	/** Record a facet as RPC'd; LRU-evict beyond STORE_FACET_CAP via ctx.facets.delete. */
	private async _trackFacet(name: string): Promise<void> {
		const now = Date.now();
		const rows = this._readFacets().filter((f) => f.name !== name);
		rows.push({ name, lastUsed: now });

		const victims = selectEvictions(
			rows.map((f) => ({ key: f.name, lastUsed: f.lastUsed })),
			STORE_FACET_CAP,
		);
		const victimSet = new Set(victims);
		for (const victim of victims) {
			// try/catch each: ctx.facets.delete can reject (internal error, spike).
			// MUST be awaited — an un-awaited delete floats past the try/catch and
			// races the next mount of the same facet.
			try {
				await this.ctx.facets?.delete(victim);
			} catch {
				/* best-effort eviction */
			}
		}
		const survivors = rows.filter((f) => !victimSet.has(f.name));
		this.ctx.storage.kv.put(FACETS_KEY, JSON.stringify(survivors));
	}

	private async _resetAlarm(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + STORE_TTL_MS);
	}

	/**
	 * Teardown order (spike-decided, then live-refined): delete each tracked facet
	 * (awaited, try/catch each — a never-RPC'd facet, or one already gone, throws)
	 * → drop our own bookkeeping rows → deleteAlarm() → deleteAll() ONLY when no
	 * facet deletes happened.
	 *
	 * deleteAll THROWS after ctx.facets.delete (spike-verified), and — worse — the
	 * failed attempt wedges the live DO instance: every later storage/facet op in
	 * it errors `internal error`, so the store looks broken until the instance is
	 * evicted (live-repro'd via DELETE /api/store → next runs failing). So a store
	 * supervisor that just deleted facets SKIPS deleteAll: the facet DBs (the
	 * actual storage mass) are already gone and the bookkeeping rows were deleted
	 * explicitly above; the residue is a near-empty supervisor DB with no alarm.
	 * The registry singleton never deletes facets, so it still gets the full
	 * deleteAll and truly evaporates. Deploy re-verification of the deleteAll
	 * behavior remains an open item (HANDOFF).
	 */
	private async _teardown(): Promise<void> {
		const facets = this.ctx.facets;
		const tracked = this._readFacets();
		for (const { name } of tracked) {
			// MUST be awaited: an un-awaited delete floats past the try/catch, lets
			// selfDestruct return with the deletion still in flight (the next mount
			// of the same facet then races it), and turns a rejection into an
			// unhandled-promise error instead of this catch.
			try {
				await facets?.delete(name);
			} catch {
				/* facet may never have been RPC'd or already gone */
			}
		}
		// Explicitly drop EVERY bookkeeping row (facet registry + any ip rows) —
		// clearing must not depend on deleteAll, which is skipped below whenever
		// facets were deleted.
		try {
			for (const [key] of this.ctx.storage.kv.list()) {
				this.ctx.storage.kv.delete(key);
			}
		} catch {
			/* best-effort */
		}
		try {
			await this.ctx.storage.deleteAlarm();
		} catch {
			/* best-effort */
		}
		if (tracked.length === 0) {
			try {
				await this.ctx.storage.deleteAll();
			} catch {
				/* best-effort */
			}
		}
	}
}
