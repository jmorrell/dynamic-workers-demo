import { describe, it, expect } from 'vitest';
import { hashCode, truncateBody, classifyTransformError } from '@/runtime/core';

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
