/**
 * StorageHost supervisor DO tests — vitest workers pool.
 *
 * IMPORTANT SCOPE: DO facets DO NOT EXIST in this pool's workerd (1.20260310,
 * predating the April 2026 facets launch): `ctx.facets` is undefined here,
 * while it works under `wrangler dev` (workerd 1.20260617). See the "Local
 * vitest vs deploy gotchas" in the root AGENTS.md and the gotchas section in
 * src/runtime/AGENTS.md. So these tests NEVER try to e2e a facet — they pin
 * the facets-absence guard (a structured error, not a crash), and exercise the
 * supervisor's own bookkeeping (per-IP store LRU, facet-registry LRU, alarm
 * teardown), which runs entirely in the supervisor's own storage. Facet e2e is
 * a wrangler-dev/deploy verification.
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { StorageHost, STORE_CAP_PER_IP, STORE_FACET_CAP, type StorageRunArgs, type StorageRunResult } from '../../src/runtime/storage-host';
import type { RunInput } from '../../src/runtime/types';

// The generated RPC stub type collapses methods whose payloads carry `unknown`
// (RunResult.value) to `never` — a type-only artifact; cast to the plain surface.
type HostStub = {
	run(args: StorageRunArgs): Promise<StorageRunResult>;
	touchStore(clientIp: string, storeId: string): Promise<string[]>;
	selfDestruct(): Promise<void>;
};

function hostStub(name: string): HostStub {
	return env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName(name)) as unknown as HostStub;
}

function testInput(): RunInput {
	return {
		url: 'https://example.com/test',
		finalUrl: 'https://example.com/test',
		status: 200,
		contentType: 'text/html',
		responseHeaders: new Map(),
		body: '<html>Test page</html>',
		truncated: false,
	};
}

describe('StorageHost (vitest pool)', () => {
	describe('facets-absence guard', () => {
		it('pins ctx.facets === undefined in the vitest pool', async () => {
			// Guard test (adapted from the throwaway facets spike): the pool's
			// workerd predates facets. If this ever starts failing, the pool gained
			// facets — revisit the gotchas in src/runtime/AGENTS.md and consider
			// promoting facet e2e coverage from wrangler-dev-only into the pool.
			const stub = env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName('guard-facets-absent'));
			await runInDurableObject(stub, async (_instance: StorageHost, state) => {
				expect(state.facets).toBeUndefined();
			});
		});

		it('run() surfaces facets absence as a structured loader_failed error, not a crash', async () => {
			const out = await hostStub(crypto.randomUUID()).run({
				input: testInput(),
				code: 'export default () => 1',
				runId: crypto.randomUUID(),
				storeKey: 'custom:test',
				permissions: { fetch: 'none', storage: 'scoped' },
			});
			expect(out.result.type).toBe('failure');
			if (out.result.type === 'failure') {
				expect(out.result.error.kind).toBe('loader_failed');
				expect(out.result.error.message).toContain('facets');
			}
			expect(out.gateSpans).toEqual([]);
		});
	});

	describe('per-IP store registry (touchStore)', () => {
		it('returns no evictions while at or under the cap', async () => {
			const registry = hostStub('registry-under-cap');
			const ip = '203.0.113.10';
			for (let i = 0; i < STORE_CAP_PER_IP; i++) {
				const evicted = await registry.touchStore(ip, crypto.randomUUID());
				expect(evicted).toEqual([]);
			}
		});

		it('LRU-evicts the oldest storeId beyond the cap', async () => {
			const registry = hostStub('registry-evict');
			const ip = '203.0.113.11';
			const ids = Array.from({ length: STORE_CAP_PER_IP + 1 }, () => crypto.randomUUID());
			for (let i = 0; i < STORE_CAP_PER_IP; i++) {
				await registry.touchStore(ip, ids[i]);
				// Distinct Date.now() ordering isn't guaranteed at ms resolution, but
				// insertion happened in order; ties break deterministically on key, so
				// re-touch the ones we want kept to give them strictly newer stamps.
				await new Promise((r) => setTimeout(r, 2));
			}
			const evicted = await registry.touchStore(ip, ids[STORE_CAP_PER_IP]);
			expect(evicted).toEqual([ids[0]]);
		});

		it('re-touching an existing storeId refreshes it instead of double-counting', async () => {
			const registry = hostStub('registry-retouch');
			const ip = '203.0.113.12';
			const first = crypto.randomUUID();
			await registry.touchStore(ip, first);
			await new Promise((r) => setTimeout(r, 2));
			for (let i = 1; i < STORE_CAP_PER_IP; i++) {
				await registry.touchStore(ip, crypto.randomUUID());
				await new Promise((r) => setTimeout(r, 2));
			}
			// `first` is now the LRU entry. Re-touch it, then add a new store: the
			// eviction must hit the second-oldest, not the freshly-touched `first`.
			await registry.touchStore(ip, first);
			await new Promise((r) => setTimeout(r, 2));
			const evicted = await registry.touchStore(ip, crypto.randomUUID());
			expect(evicted).toHaveLength(1);
			expect(evicted[0]).not.toBe(first);
		});

		it('tracks IPs independently', async () => {
			const registry = hostStub('registry-per-ip');
			for (let i = 0; i < STORE_CAP_PER_IP; i++) {
				await registry.touchStore('203.0.113.13', crypto.randomUUID());
			}
			// A different IP starts from an empty set — no eviction.
			expect(await registry.touchStore('203.0.113.14', crypto.randomUUID())).toEqual([]);
		});
	});

	describe('facet bookkeeping (_trackFacet seam, no real facets needed)', () => {
		// _trackFacet only touches the supervisor's own kv plus best-effort
		// ctx.facets?.delete (a no-op here where facets are absent), so the LRU
		// bookkeeping is exercisable in the pool without mounting anything.
		it('LRU-evicts the oldest facet row beyond STORE_FACET_CAP', async () => {
			const stub = env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName('facet-track-lru'));
			await runInDurableObject(stub, async (instance: StorageHost, state) => {
				const track = (name: string) => (instance as unknown as { _trackFacet(name: string): Promise<void> })._trackFacet(name);
				const seeded = Array.from({ length: STORE_FACET_CAP }, (_, i) => `store-${i}`);
				// Seed with strictly increasing lastUsed stamps.
				state.storage.kv.put('facets', JSON.stringify(seeded.map((name, i) => ({ name, lastUsed: i + 1 }))));
				await track('one-more');
				const rows = JSON.parse(state.storage.kv.get('facets') as string) as Array<{ name: string }>;
				expect(rows).toHaveLength(STORE_FACET_CAP);
				const names = rows.map((r) => r.name);
				expect(names).not.toContain('store-0'); // oldest evicted
				expect(names).toContain('one-more');
			});
		});

		it('re-tracking an existing facet refreshes it without growing the set', async () => {
			const stub = env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName('facet-track-refresh'));
			await runInDurableObject(stub, async (instance: StorageHost, state) => {
				const track = (name: string) => (instance as unknown as { _trackFacet(name: string): Promise<void> })._trackFacet(name);
				await track('a');
				await track('b');
				await track('a');
				const rows = JSON.parse(state.storage.kv.get('facets') as string) as Array<{ name: string }>;
				expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b']);
			});
		});
	});

	describe('alarm / selfDestruct teardown', () => {
		it('alarm clears bookkeeping rows and the alarm itself', async () => {
			const stub = env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName('alarm-teardown'));
			await runInDurableObject(stub, async (instance: StorageHost, state) => {
				state.storage.kv.put('facets', JSON.stringify([{ name: 'x', lastUsed: 1 }]));
				state.storage.kv.put('ip:203.0.113.15', JSON.stringify([{ storeId: crypto.randomUUID(), lastUsed: 1 }]));
				await state.storage.setAlarm(Date.now() + 60_000);

				await instance.alarm();

				// deleteAll ran (no facets were ever deleted here, so it doesn't hit
				// the deleteAll-after-facets.delete quirk — see AGENTS.md gotchas).
				expect(state.storage.kv.get('facets')).toBeUndefined();
				expect(state.storage.kv.get('ip:203.0.113.15')).toBeUndefined();
				expect(await state.storage.getAlarm()).toBeNull();
			});
		});

		it('selfDestruct runs the same teardown sequence', async () => {
			const name = 'selfdestruct-teardown';
			const stub = env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName(name));
			await runInDurableObject(stub, async (_instance: StorageHost, state) => {
				state.storage.kv.put('facets', JSON.stringify([{ name: 'y', lastUsed: 1 }]));
			});
			await hostStub(name).selfDestruct();
			await runInDurableObject(env.STORAGE_HOST.get(env.STORAGE_HOST.idFromName(name)), async (_instance: StorageHost, state) => {
				expect(state.storage.kv.get('facets')).toBeUndefined();
				expect(await state.storage.getAlarm()).toBeNull();
			});
		});
	});
});
