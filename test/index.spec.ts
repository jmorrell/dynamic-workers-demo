import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { setTurnstileVerifier } from '../src/index';
import { getExample } from '../src/examples/manifest';
import articleHtml from './examples/fixtures/article.html?raw';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function stubTargetFetch(body: string, contentType = 'text/html'): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(() =>
			Promise.resolve(
				new Response(body, {
					status: 200,
					headers: { 'content-type': contentType },
				}),
			),
		),
	);
}

describe('GET /api/examples handler', () => {
	it('returns 200 with example list', async () => {
		const request = new IncomingRequest('http://example.com/api/examples', {
			method: 'GET',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');

		const data = await response.json<Array<{ id: string; title: string; description: string }>>();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(6);

		// Should not contain code field
		for (const example of data) {
			expect('code' in example).toBe(false);
		}
	});

	it('returns 405 for POST /api/examples', async () => {
		const request = new IncomingRequest('http://example.com/api/examples', {
			method: 'POST',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
	});

	it('GET /api/examples still returns manifest with assets binding enabled (routing correct)', async () => {
		const request = new IncomingRequest('http://example.com/api/examples', {
			method: 'GET',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const manifest = await response.json<Array<{ id: string; title: string }>>();
		expect(Array.isArray(manifest)).toBe(true);
		expect(manifest.length).toBeGreaterThan(0);
		expect(manifest[0]).toHaveProperty('id');
		expect(manifest[0]).toHaveProperty('title');
	});
});

describe('GET /api/config handler', () => {
	it('returns 200 with turnstileSitekey', async () => {
		const request = new IncomingRequest('http://example.com/api/config', {
			method: 'GET',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');

		const data = await response.json<Record<string, unknown>>();
		expect('turnstileSitekey' in data).toBe(true);
		expect(typeof data.turnstileSitekey).toBe('string');

		// Verify that the secret is NOT exposed
		expect('secret' in data).toBe(false);
		expect('TURNSTILE_SECRET' in data).toBe(false);
		expect('turnstileSecret' in data).toBe(false);
	});

	it('returns 405 for POST /api/config', async () => {
		const request = new IncomingRequest('http://example.com/api/config', {
			method: 'POST',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
	});
});

describe('POST /api/run handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Set up Turnstile verifier to always pass for these tests
		setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
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

		it('returns 400 when worker is missing', async () => {
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
				body: JSON.stringify({ worker: { type: 'custom', customCode: 'export default () => 42' } }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when worker is not an object', async () => {
			// Distinct CF-Connecting-IP so this doesn't share the 'anonymous' rate-limit
			// budget with the other tests in this file (RATE_LIMITER has real per-key
			// state under vitest-pool-workers, unlike the AGENTS.md no-op-locally note
			// which applies to the deployed RATE_LIMITER's actual counting accuracy).
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.201' },
				body: JSON.stringify({ url: 'http://example.com', worker: 'export default () => 42' }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when worker.type is unknown', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.202' },
				body: JSON.stringify({ url: 'http://example.com', worker: { type: 'bogus' } }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when worker.type is example but exampleId is not a string', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.203' },
				body: JSON.stringify({ url: 'http://example.com', worker: { type: 'example', exampleId: 42 } }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when worker.type is custom but customCode is not a string', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.204' },
				body: JSON.stringify({ url: 'http://example.com', worker: { type: 'custom', customCode: 42 } }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 404 for an unknown exampleId without fetching the target or invoking the loader', async () => {
			// The url points at an unreachable host. If the handler proceeded into
			// the pipeline it would call fetchTarget and respond 200 with an
			// ok:false fetch_failed body. A 404 instead proves the unknown id is
			// rejected up front, before any target fetch or loader invocation.
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'nonexistent-example' },
					url: 'http://invalid-url-that-does-not-exist.test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(404);
		});
	});

	describe('happy path - successful transform', () => {
		it('POST /api/run with customCode returns 200 and result structure', async () => {
			const transformCode = 'export default (input) => input.status';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					worker: { type: 'custom', customCode: transformCode },
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

		it('POST /api/run with exampleId resolves and runs the bundled code', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'opengraph' },
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

	describe('TypeScript custom code (transpile pipeline)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('POST /api/run with custom TypeScript code (type annotations) succeeds end-to-end', async () => {
			stubTargetFetch('<html>hi</html>');

			const tsCode = `
				type Input = { status: number };
				interface Result { doubled: number }
				export default (input: Input): Result => ({ doubled: input.status * 2 });
			`;
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				// Distinct CF-Connecting-IP so this doesn't share the 'anonymous'
				// rate-limit bucket with other tests in this file.
				headers: { 'CF-Connecting-IP': '203.0.113.210' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: tsCode },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: unknown; error?: unknown }>();
			expect(data.ok).toBe(true);
			expect(data.result).toEqual({ doubled: 400 });
		});

		it('returns ok:false with compile_failed for custom code with a TS syntax error', async () => {
			stubTargetFetch('<html>hi</html>');

			const brokenCode = 'export default (input) => { const x = ; }';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.211' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: brokenCode },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; error?: { kind: string; message: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('compile_failed');
		});

		it('runs the markdown example source verbatim as edited custom code (sucrase + injected deps + polyfill ordering)', async () => {
			// Simulates a user selecting the markdown example, editing nothing, and
			// running it as custom code — exercising the exact source (with its
			// 'linkedom' / 'defuddle/node' / './markdown-dom-polyfill' imports and
			// `import type` from '../runtime/types') through transpileUserCode +
			// the injected shared dep modules, rather than the pre-bundled path.
			const example = getExample('markdown');
			expect(example).toBeDefined();
			if (!example) return;

			stubTargetFetch(articleHtml);

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.212' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: example.source },
					url: 'http://example.com/article',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: { markdown?: string }; error?: { kind: string; message: string } }>();
			expect(data.ok).toBe(true);
			expect(typeof data.result?.markdown).toBe('string');
			expect((data.result?.markdown ?? '').length).toBeGreaterThan(0);
		});
	});

	describe('fetch failure scenarios', () => {
		it('returns fetch error when target URL fails', async () => {
			const transformCode = 'export default (input) => input.status';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					worker: { type: 'custom', customCode: transformCode },
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
					worker: { type: 'custom', customCode: 'export default () => 42' },
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
					worker: { type: 'custom', customCode: 'export default () => 42' },
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

		it('returns raw <script> tag as unmodified string in JSON (trust boundary)', async () => {
			const transformCode = 'export default (input) => ({ script: "<script>alert(1)</script>" })';
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				body: JSON.stringify({
					worker: { type: 'custom', customCode: transformCode },
					url: 'http://example.com',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: { script: string } }>();
			expect(data.ok).toBe(true);
			if (data.ok && data.result) {
				// Assert the raw string is returned unmodified — client responsibility to escape
				expect(data.result.script).toBe('<script>alert(1)</script>');
				expect(data.result.script).toContain('<script>');
			}
		});
	});
});

describe('Static assets routing', () => {
	it('GET / returns HTML (empirical: assets serve in vitest pool)', async () => {
		// Empirical test to determine if @cloudflare/vitest-pool-workers serves static assets.
		// The ASSETS binding with run_worker_first: ["/api/*"] should serve "/" before the Worker runs.
		// If this test passes, assets ARE served locally in vitest; if it fails, they are NOT
		// (then the serving is deploy/human-verified and documented in test-requirements.md).
		const response = await SELF.fetch('http://example.com/');
		expect(response.status).toBe(200);
		const text = await response.text();
		// Check for basic HTML structure (index.html should contain typical HTML tags)
		expect(text).toMatch(/<html|<!DOCTYPE/i);
		// The widget HTML should reference the app.js file or contain elements from index.html
		expect(text.toLowerCase()).toMatch(/(app\.js|editor|example|widget)/);
	});
});
