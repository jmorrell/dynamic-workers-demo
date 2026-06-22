import { describe, it, expect, vi } from 'vitest';
import { verifyTurnstile, type VerifyResult } from '../../src/runtime/turnstile';

describe('verifyTurnstile', () => {
	it('returns ok:false without calling fetch when token is missing', async () => {
		const mockFetch = vi.fn();
		const result = await verifyTurnstile(undefined, 'test-secret', '127.0.0.1', mockFetch);

		expect(result.ok).toBe(false);
		expect(result.errorCodes).toContain('missing-input-response');
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('returns ok:false when siteverify returns success:false', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
		});

		const result = await verifyTurnstile('bad-token', 'test-secret', '127.0.0.1', mockFetch);

		expect(result.ok).toBe(false);
		expect(result.errorCodes).toContain('invalid-input-response');
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it('returns ok:true when siteverify returns success:true', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true }),
		});

		const result = await verifyTurnstile('valid-token', 'test-secret', '127.0.0.1', mockFetch);

		expect(result.ok).toBe(true);
		expect(result.errorCodes).toEqual([]);
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it('includes remoteip in request body when provided', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true }),
		});

		await verifyTurnstile('token', 'secret', '192.168.1.1', mockFetch);

		const callArgs = mockFetch.mock.calls[0];
		expect(callArgs[0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
		expect(callArgs[1]?.method).toBe('POST');

		const body = callArgs[1]?.body as FormData;
		expect(body.get('secret')).toBe('secret');
		expect(body.get('response')).toBe('token');
		expect(body.get('remoteip')).toBe('192.168.1.1');
	});

	it('omits remoteip from request body when not provided', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true }),
		});

		await verifyTurnstile('token', 'secret', undefined, mockFetch);

		const callArgs = mockFetch.mock.calls[0];
		const body = callArgs[1]?.body as FormData;
		expect(body.get('remoteip')).toBeNull();
	});

	it('never logs the secret', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true }),
		});

		// This test is more of a code-inspection test - the actual secret should never appear
		// in any log statement in the function. We verify this by ensuring no console calls happen.
		const consoleSpy = vi.spyOn(console, 'log');
		const consoleErrorSpy = vi.spyOn(console, 'error');
		const consoleWarnSpy = vi.spyOn(console, 'warn');

		await verifyTurnstile('token', 'super-secret-key-12345', '127.0.0.1', mockFetch);

		expect(consoleSpy).not.toHaveBeenCalled();
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(consoleWarnSpy).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it('handles empty error-codes array from siteverify', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true, 'error-codes': [] }),
		});

		const result = await verifyTurnstile('token', 'secret', '127.0.0.1', mockFetch);

		expect(result.ok).toBe(true);
		expect(result.errorCodes).toEqual([]);
	});

	it('includes multiple error codes from siteverify response', async () => {
		const mockFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({
				success: false,
				'error-codes': ['invalid-input-response', 'timeout-or-duplicate'],
			}),
		});

		const result = await verifyTurnstile('token', 'secret', '127.0.0.1', mockFetch);

		expect(result.ok).toBe(false);
		expect(result.errorCodes).toContain('invalid-input-response');
		expect(result.errorCodes).toContain('timeout-or-duplicate');
	});

	it('defaults to globalThis.fetch when fetchImpl is not provided', async () => {
		const mockGlobalFetch = vi.fn().mockResolvedValueOnce({
			json: async () => ({ success: true }),
		});

		// Temporarily replace global fetch
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mockGlobalFetch as any;

		try {
			const result = await verifyTurnstile('token', 'secret', '127.0.0.1');
			expect(result.ok).toBe(true);
			expect(mockGlobalFetch).toHaveBeenCalledOnce();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
