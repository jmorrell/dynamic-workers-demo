import { describe, it, expect } from 'vitest';
import { hashCode, truncateBody, classifyTransformError, classifyLoaderError, clampFetchDepth, isValidPermissions } from '@/runtime/core';

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

	it('rejects an invalid fetch value', () => {
		expect(isValidPermissions({ fetch: 'everything' })).toBe(false);
	});
});
