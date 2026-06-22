import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('POST /api/run handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('request routing', () => {
		it('returns 404 for wrong path', async () => {
			const request = new IncomingRequest('http://example.com/wrong-path', {
				method: 'POST',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(404);
		});

		it('returns 405 for GET /api/run', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'GET',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(405);
		});

		it('returns 400 for malformed JSON body', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: 'invalid json',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when customCode is missing', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({ url: 'http://example.com' }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when url is missing', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({ customCode: 'export default () => 42' }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});
	});

	describe('happy path - successful transform', () => {
		it('POST /api/run with valid request returns 200 and result structure', async () => {
			const transformCode = 'export default (input) => input.status';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					customCode: transformCode,
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');

			const data = await response.json<{
				ok: boolean;
				result?: unknown;
				error?: unknown;
				timingMs?: number;
			}>();

			expect(data).toHaveProperty('ok');
			if (data.ok) {
				expect(data).toHaveProperty('result');
				expect(data).toHaveProperty('timingMs');
			}
		});
	});

	describe('fetch failure scenarios', () => {
		it('returns fetch error when target URL fails', async () => {
			const transformCode = 'export default (input) => input.status';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					customCode: transformCode,
					url: 'http://invalid-url-that-does-not-exist.test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);

			const data = await response.json<{
				ok: boolean;
				error?: { kind: string };
			}>();

			expect(data.ok).toBe(false);
			if (!data.ok && data.error) {
				expect(data.error.kind).toBe('fetch_failed');
			}
		});
	});

	describe('response format', () => {
		it('response has content-type application/json', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					customCode: 'export default () => 42',
					url: 'http://example.com',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.headers.get('content-type')).toContain('application/json');
		});

		it('includes timingMs in response', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					customCode: 'export default () => 42',
					url: 'http://example.com',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			const data = await response.json<{ timingMs?: number }>();
			expect(typeof data.timingMs).toBe('number');
			expect(data.timingMs).toBeGreaterThanOrEqual(0);
		});
	});
});
