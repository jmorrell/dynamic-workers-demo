import { describe, it, expect } from 'vitest';
import {
	hashCode,
	truncateBody,
	classifyTransformError,
	classifyLoaderError,
	clampFetchDepth,
	clampMaxFetches,
	isValidPermissions,
	normalizeStoreId,
	deriveStoreKey,
	checkDatabaseSize,
	selectEvictions,
	STORE_MAX_BYTES,
} from '@/runtime/core';

describe('hashCode', () => {
	it('returns consistent hash for same input', async () => {
		const code = 'export default (i) => i.status';
		const hash1 = await hashCode(code);
		const hash2 = await hashCode(code);
		expect(hash1).toBe(hash2);
	});

	it('returns different hash for different inputs', async () => {
		const code1 = 'export default (i) => i.status';
		const code2 = 'export default (i) => i.url';
		const hash1 = await hashCode(code1);
		const hash2 = await hashCode(code2);
		expect(hash1).not.toBe(hash2);
	});

	it('returns a hex string', async () => {
		const code = 'export default (i) => i.status';
		const hash = await hashCode(code);
		expect(hash).toMatch(/^[0-9a-f]+$/);
	});

	it('produces SHA-256 length hash (64 hex chars)', async () => {
		const code = 'export default (i) => i.status';
		const hash = await hashCode(code);
		expect(hash).toHaveLength(64); // SHA-256 = 32 bytes = 64 hex chars
	});
});

describe('truncateBody', () => {
	it('returns unchanged body with truncated false when under cap', () => {
		const body = 'hello world';
		const result = truncateBody(body, 100);
		expect(result).toEqual({ body: 'hello world', truncated: false });
	});

	it('returns unchanged body with truncated false when exactly at cap', () => {
		const body = 'hello';
		const byteLength = new TextEncoder().encode(body).length;
		const result = truncateBody(body, byteLength);
		expect(result).toEqual({ body: 'hello', truncated: false });
	});

	it('truncates body and sets truncated true when over cap', () => {
		const body = 'hello world this is a longer string';
		const result = truncateBody(body, 10);
		expect(result.truncated).toBe(true);
		const resultBytes = new TextEncoder().encode(result.body).byteLength;
		expect(resultBytes).toBeLessThanOrEqual(10);
	});

	it('never exceeds maxBytes after truncation', () => {
		const body = 'a'.repeat(1000);
		const maxBytes = 256;
		const result = truncateBody(body, maxBytes);
		const resultBytes = new TextEncoder().encode(result.body).byteLength;
		expect(resultBytes).toBeLessThanOrEqual(maxBytes);
	});

	it('handles multi-byte UTF-8 characters correctly', () => {
		const body = 'hello 世界 world'; // Contains multi-byte chars
		const maxBytes = 10;
		const result = truncateBody(body, maxBytes);
		const resultBytes = new TextEncoder().encode(result.body).byteLength;
		expect(resultBytes).toBeLessThanOrEqual(maxBytes);
		// Should not split multi-byte character
		expect(result.body).not.toContain('�'); // Replacement char
	});

	it('returns truncated true for empty string with 0 cap', () => {
		const result = truncateBody('a', 0);
		expect(result.truncated).toBe(true);
		expect(new TextEncoder().encode(result.body).byteLength).toBeLessThanOrEqual(0);
	});
});

describe('classifyTransformError', () => {
	it('returns network_blocked for disallowed fetch message', () => {
		const message = 'fetch failed: disallowed by globalOutbound: null';
		const kind = classifyTransformError(message);
		expect(kind).toBe('network_blocked');
	});

	it('returns network_blocked for not allowed message', () => {
		const message = 'fetch not allowed: network access restricted';
		const kind = classifyTransformError(message);
		expect(kind).toBe('network_blocked');
	});

	it('returns network_blocked for globalOutbound message', () => {
		const message = 'globalOutbound: null blocks all outbound requests';
		const kind = classifyTransformError(message);
		expect(kind).toBe('network_blocked');
	});

	it('returns transform_threw for arbitrary error', () => {
		const message = 'something went wrong';
		const kind = classifyTransformError(message);
		expect(kind).toBe('transform_threw');
	});

	it('returns transform_threw for empty message', () => {
		const message = '';
		const kind = classifyTransformError(message);
		expect(kind).toBe('transform_threw');
	});

	it('case insensitive matching for network blocked', () => {
		const message = 'Fetch DISALLOWED by network policy';
		const kind = classifyTransformError(message);
		expect(kind).toBe('network_blocked');
	});
});

describe('classifyLoaderError', () => {
	it('returns cpu_exceeded for cpu limit message', () => {
		const message = 'error: exceeded cpu limit of 50ms';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('cpu_exceeded');
	});

	it('returns cpu_exceeded for cpu exceeded message', () => {
		const message = 'Worker exceeded cpu';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('cpu_exceeded');
	});

	it('returns cpu_exceeded for cpu time message', () => {
		const message = 'exceeded cpu time budget';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('cpu_exceeded');
	});

	it('returns loader_failed for subrequest limit message', () => {
		// Sub-request limits should NOT match (too broad matcher caused misclassification)
		const message = 'too many subrequests';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('returns loader_failed for subrequest limit exceeded message', () => {
		// Subrequest limit exceeded should map to loader_failed, not cpu_exceeded
		const message = 'subrequest limit exceeded (max 5)';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('returns loader_failed for memory limit message', () => {
		// Memory limits should map to loader_failed, not cpu_exceeded
		const message = 'memory limit exceeded';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('returns loader_failed for timeout message', () => {
		// Generic timeout (RPC, module resolution) should map to loader_failed
		const message = 'RPC timeout';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('returns loader_failed for unrelated error message', () => {
		const message = 'something went wrong in the loader';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('returns loader_failed for empty message', () => {
		const message = '';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('loader_failed');
	});

	it('case insensitive matching for cpu exceeded', () => {
		const message = 'CPU LIMIT EXCEEDED';
		const kind = classifyLoaderError(message);
		expect(kind).toBe('cpu_exceeded');
	});
});

describe('clampFetchDepth', () => {
	it('defaults to 1 when undefined', () => {
		expect(clampFetchDepth(undefined)).toBe(1);
	});

	it('clamps 0 up to the minimum (1)', () => {
		expect(clampFetchDepth(0)).toBe(1);
	});

	it('passes through 2 unchanged', () => {
		expect(clampFetchDepth(2)).toBe(2);
	});

	it('passes through 3 unchanged', () => {
		expect(clampFetchDepth(3)).toBe(3);
	});

	it('clamps 7 down to the maximum (3)', () => {
		expect(clampFetchDepth(7)).toBe(3);
	});

	it('rounds 2.6 up to 3', () => {
		expect(clampFetchDepth(2.6)).toBe(3);
	});

	it('falls back to 1 for NaN', () => {
		expect(clampFetchDepth(NaN)).toBe(1);
	});
});

describe('clampMaxFetches', () => {
	it('defaults to 5 when undefined', () => {
		expect(clampMaxFetches(undefined)).toBe(5);
	});

	it('clamps 0 up to the minimum (1)', () => {
		expect(clampMaxFetches(0)).toBe(1);
	});

	it('passes through 1 unchanged', () => {
		expect(clampMaxFetches(1)).toBe(1);
	});

	it('passes through 100 unchanged', () => {
		expect(clampMaxFetches(100)).toBe(100);
	});

	it('clamps 150 down to the maximum (100)', () => {
		expect(clampMaxFetches(150)).toBe(100);
	});

	it('rounds 2.4 down to 2', () => {
		expect(clampMaxFetches(2.4)).toBe(2);
	});

	it('falls back to 5 for NaN', () => {
		expect(clampMaxFetches(NaN)).toBe(5);
	});
});

describe('isValidPermissions', () => {
	it('accepts a minimal valid permissions object', () => {
		expect(isValidPermissions({ fetch: 'none' })).toBe(true);
	});

	it('accepts fetchDepth as a number', () => {
		expect(isValidPermissions({ fetch: 'page-links', fetchDepth: 2 })).toBe(true);
	});

	it('accepts an absent fetchDepth', () => {
		expect(isValidPermissions({ fetch: 'page-links' })).toBe(true);
	});

	it('rejects a string fetchDepth', () => {
		expect(isValidPermissions({ fetch: 'page-links', fetchDepth: '2' })).toBe(false);
	});

	it('accepts maxFetches as a number', () => {
		expect(isValidPermissions({ fetch: 'page-links', maxFetches: 10 })).toBe(true);
	});

	it('accepts an absent maxFetches', () => {
		expect(isValidPermissions({ fetch: 'page-links' })).toBe(true);
	});

	it('rejects a string maxFetches', () => {
		expect(isValidPermissions({ fetch: 'page-links', maxFetches: '10' })).toBe(false);
	});

	it('rejects an invalid fetch value', () => {
		expect(isValidPermissions({ fetch: 'everything' })).toBe(false);
	});

	it('accepts a valid storage value', () => {
		expect(isValidPermissions({ fetch: 'none', storage: 'scoped' })).toBe(true);
		expect(isValidPermissions({ fetch: 'none', storage: 'none' })).toBe(true);
	});

	it('accepts an absent storage', () => {
		expect(isValidPermissions({ fetch: 'none' })).toBe(true);
	});

	it('rejects an invalid storage value', () => {
		expect(isValidPermissions({ fetch: 'none', storage: 'everything' })).toBe(false);
		expect(isValidPermissions({ fetch: 'none', storage: true })).toBe(false);
	});
});

describe('normalizeStoreId', () => {
	it('accepts a canonical lowercase uuid unchanged', () => {
		const id = '11111111-2222-4333-8444-555555555555';
		expect(normalizeStoreId(id)).toBe(id);
	});

	it('normalizes an uppercase uuid to lowercase', () => {
		expect(normalizeStoreId('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
	});

	it('accepts a real crypto.randomUUID()', () => {
		const id = crypto.randomUUID();
		expect(normalizeStoreId(id)).toBe(id);
	});

	it('rejects a non-uuid string', () => {
		expect(normalizeStoreId('not-a-uuid')).toBeNull();
		expect(normalizeStoreId('11111111-2222-4333-8444-55555555555')).toBeNull(); // one short
		expect(normalizeStoreId('__registry__')).toBeNull(); // reserved sentinel is not a uuid
	});

	it('rejects non-string input', () => {
		expect(normalizeStoreId(undefined)).toBeNull();
		expect(normalizeStoreId(123)).toBeNull();
		expect(normalizeStoreId(null)).toBeNull();
	});
});

describe('deriveStoreKey', () => {
	it('uses the example id for an example run', () => {
		expect(deriveStoreKey({ type: 'example', exampleId: 'url-history' })).toBe('url-history');
	});

	it('prefixes the code hash for a custom run', () => {
		expect(deriveStoreKey({ type: 'custom', codeHash: 'abc123' })).toBe('custom:abc123');
	});

	it('gives different custom code different store keys (edited code = different store)', () => {
		expect(deriveStoreKey({ type: 'custom', codeHash: 'aaa' })).not.toBe(deriveStoreKey({ type: 'custom', codeHash: 'bbb' }));
	});
});

describe('checkDatabaseSize', () => {
	it('accepts a query that remains within the limit', () => {
		expect(checkDatabaseSize({ databaseSizeBefore: 1000, databaseSizeAfter: 2000 })).toEqual({ ok: true });
	});

	it('rejects growth beyond the database limit', () => {
		const result = checkDatabaseSize({
			databaseSizeBefore: STORE_MAX_BYTES - 1,
			databaseSizeAfter: STORE_MAX_BYTES + 4096,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('database full');
	});

	it('allows queries that do not grow an already-oversized database', () => {
		expect(
			checkDatabaseSize({
				databaseSizeBefore: STORE_MAX_BYTES + 4096,
				databaseSizeAfter: STORE_MAX_BYTES + 4096,
			}),
		).toEqual({ ok: true });
	});

	it('allows cleanup that shrinks an already-oversized database', () => {
		expect(
			checkDatabaseSize({
				databaseSizeBefore: STORE_MAX_BYTES + 8192,
				databaseSizeAfter: STORE_MAX_BYTES + 4096,
			}),
		).toEqual({ ok: true });
	});
});

describe('selectEvictions', () => {
	it('returns nothing when at or under the cap', () => {
		expect(selectEvictions([{ key: 'a', lastUsed: 1 }], 5)).toEqual([]);
		expect(selectEvictions([], 5)).toEqual([]);
	});

	it('evicts the oldest entries beyond the cap, oldest first', () => {
		const entries = [
			{ key: 'newest', lastUsed: 500 },
			{ key: 'mid', lastUsed: 300 },
			{ key: 'oldest', lastUsed: 100 },
			{ key: 'old', lastUsed: 200 },
		];
		// cap 2 → keep the 2 newest (newest, mid); evict old(200) then oldest(100)? oldest-first.
		expect(selectEvictions(entries, 2)).toEqual(['oldest', 'old']);
	});

	it('evicts exactly one when one over the cap', () => {
		const entries = [
			{ key: 's1', lastUsed: 10 },
			{ key: 's2', lastUsed: 20 },
			{ key: 's3', lastUsed: 30 },
			{ key: 's4', lastUsed: 40 },
			{ key: 's5', lastUsed: 50 },
			{ key: 's6', lastUsed: 60 },
		];
		expect(selectEvictions(entries, 5)).toEqual(['s1']);
	});

	it('breaks lastUsed ties on key for determinism', () => {
		const entries = [
			{ key: 'b', lastUsed: 100 },
			{ key: 'a', lastUsed: 100 },
			{ key: 'c', lastUsed: 100 },
		];
		// cap 2: newest-first sort keeps 'a','b' (tie broken by key asc), evicts 'c'.
		expect(selectEvictions(entries, 2)).toEqual(['c']);
	});
});
