import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { setTurnstileVerifier } from '../../src/index';
import { verifyTurnstile } from '../../src/runtime/turnstile';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Abuse controls on /api/run', () => {
	// The verifier is a module-level seam; restore the real implementation after
	// every test so no test leaves it in an always-pass state for the next one.
	afterEach(() => {
		setTurnstileVerifier(verifyTurnstile);
	});

	describe('AC6.2: Turnstile verification', () => {
		it('rejects request with no turnstileToken and returns 403', async () => {
			// Override verifier to simulate verification failure
			setTurnstileVerifier(async () => ({ ok: false, errorCodes: ['missing-input-response'] }));

			try {
				const request = new IncomingRequest('http://example.com/api/run', {
					method: 'POST',
					body: JSON.stringify({
						worker: { type: 'example', exampleId: 'reddit' },
						url: 'https://example.com',
						// missing turnstileToken
					}),
				});
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);

				expect(response.status).toBe(403);
				const data = await response.json<any>();
				expect(data.ok).toBe(false);
				expect(data.error?.kind).toBe('turnstile_failed');
				// Loader NOT invoked: response should not have result/timingMs/logs
				expect('result' in data).toBe(false);
				expect('timingMs' in data).toBe(false);
				expect('logs' in data).toBe(false);
			} finally {
				// Reset to identity verifier (accepts all) for next tests
				setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			}
		});

		it('rejects request with invalid turnstileToken and returns 403', async () => {
			// Override verifier to simulate verification failure
			setTurnstileVerifier(async () => ({ ok: false, errorCodes: ['invalid-input-response'] }));

			try {
				const request = new IncomingRequest('http://example.com/api/run', {
					method: 'POST',
					body: JSON.stringify({
						worker: { type: 'example', exampleId: 'reddit' },
						url: 'https://example.com',
						turnstileToken: 'invalid-token',
					}),
				});
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);

				expect(response.status).toBe(403);
				const data = await response.json<any>();
				expect(data.ok).toBe(false);
				expect(data.error?.kind).toBe('turnstile_failed');
				// Loader NOT invoked
				expect('result' in data).toBe(false);
				expect('timingMs' in data).toBe(false);
				expect('logs' in data).toBe(false);
			} finally {
				// Reset to identity verifier for next tests
				setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			}
		});

		it('accepts request with valid turnstileToken and processes normally', async () => {
			// Override verifier to always pass
			setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));

			try {
				const request = new IncomingRequest('http://example.com/api/run', {
					method: 'POST',
					body: JSON.stringify({
						worker: { type: 'example', exampleId: 'reddit' },
						url: 'https://example.com',
						turnstileToken: '1x00000000000000000000AA',
					}),
				});
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);

				// Should succeed (fetch may fail for example.com, but not because of Turnstile)
				// At minimum, should not be 403
				expect(response.status).not.toBe(403);
				const data = await response.json<any>();
				expect(data.ok !== undefined).toBe(true);
				// Response should have either result or error
				expect('result' in data || 'error' in data).toBe(true);
			} finally {
				// Reset to identity verifier for next tests
				setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			}
		});
	});

	describe('AC6.3: Rate limiting', () => {
		it('returns 429 and does not invoke the loader when the per-IP limit is exceeded', async () => {
			// Turnstile passes so we isolate the rate-limit gate. The RATE_LIMITER
			// binding is a no-op stub in vitest-pool-workers (limit() always returns
			// success — real per-IP counting is enforced only on deployed Cloudflare
			// infra, see test-requirements.md), so force the limit-exceeded branch
			// deterministically by mocking limit(). This proves the gate's response
			// (429 + rate_limited) and that the loader is not invoked.
			setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			const limitSpy = vi.spyOn(env.RATE_LIMITER, 'limit').mockResolvedValue({ success: false });

			try {
				const request = new IncomingRequest('http://example.com/api/run', {
					method: 'POST',
					body: JSON.stringify({
						worker: { type: 'custom', customCode: 'export default (env, input) => input.status' },
						url: 'https://example.com/test',
						turnstileToken: '1x00000000000000000000AA',
					}),
					headers: {
						'CF-Connecting-IP': '203.0.113.42',
					},
				});
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);

				expect(response.status).toBe(429);
				const data = await response.json<any>();
				expect(data.ok).toBe(false);
				expect(data.error?.kind).toBe('rate_limited');
				expect(data.error?.message).toContain('Too many runs');
				// Loader NOT invoked: the rate-limit gate runs before fetch/loader, so
				// the response carries none of the run fields.
				expect('result' in data).toBe(false);
				expect('timingMs' in data).toBe(false);
				expect('logs' in data).toBe(false);
				// The gate keys the limiter on the client IP.
				expect(limitSpy).toHaveBeenCalledWith({ key: '203.0.113.42' });
			} finally {
				limitSpy.mockRestore();
				setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			}
		});
	});

	describe('Happy path regression', () => {
		it('valid token + under limit allows normal run flow', async () => {
			// Override verifier to always pass
			setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));

			try {
				const request = new IncomingRequest('http://example.com/api/run', {
					method: 'POST',
					body: JSON.stringify({
						worker: { type: 'example', exampleId: 'markdown' },
						url: 'https://example.com/test',
						turnstileToken: '1x00000000000000000000AA',
					}),
				});
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);

				expect(response.status).toBe(200);
				const data = await response.json<any>();
				expect(data.ok !== undefined).toBe(true);
				// Response should have result/error (loader was invoked)
				expect('result' in data || 'error' in data).toBe(true);
			} finally {
				// Reset to identity verifier for next tests
				setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
			}
		});
	});
});
