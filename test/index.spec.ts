import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { setTurnstileVerifier } from '../src/index';
import { getExample } from '../src/examples/manifest';
import articleHtml from './examples/fixtures/article.html?raw';
import dummyPdfBase64 from './examples/fixtures/dummy-pdf.base64.txt?raw';

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
		expect(data.length).toBe(9);

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
			const transformCode = 'export default (env, input) => input.status';
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
				export default (env: unknown, input: Input): Result => ({ doubled: input.status * 2 });
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

			const brokenCode = 'export default (env, input) => { const x = ; }';
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

	describe('capabilities: page-links fetch permission (end-to-end)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('custom run with fetch:page-links can fetch a URL linked from the fetched page and return its content', async () => {
			const linked = 'https://example.com/linked-doc';
			// One stub serves both the target page fetch (fetchTarget) and the gate's
			// fetch, keyed by URL: the page links to `linked`, the gate then fetches it.
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === linked) {
						return Promise.resolve(new Response('LINKED PAGE CONTENT', { status: 200, headers: { 'content-type': 'text/plain' } }));
					}
					return Promise.resolve(
						new Response(`<html><body><a href="${linked}">doc</a></body></html>`, {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);

			const customCode = `export default async (env, input) => {
				const res = await env.fetch('${linked}');
				return { fetchedStatus: res.status, fetchedBody: res.body };
			}`;

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.220' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/page',
					permissions: { fetch: 'page-links' },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: { fetchedStatus: number; fetchedBody: string } }>();
			expect(data.ok).toBe(true);
			expect(data.result?.fetchedStatus).toBe(200);
			expect(data.result?.fetchedBody).toBe('LINKED PAGE CONTENT');
		});

		it('a fetch to a URL NOT linked from the page is denied (transform_threw, not referenced)', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('<html><body><a href="https://example.com/linked">ok</a></body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					),
				),
			);

			const customCode = `export default async (env, input) => {
				return await env.fetch('https://example.com/not-linked');
			}`;

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.221' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/page',
					permissions: { fetch: 'page-links' },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			const data = await response.json<{ ok: boolean; error?: { kind: string; message: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('transform_threw');
			expect(data.error?.message).toContain('not referenced by the fetched page');
		});

		it('rejects a custom run with a malformed permissions shape (400 bad_request)', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.222' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: 'export default (env, input) => 1' },
					url: 'http://example.com/page',
					permissions: { fetch: 'everything' },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});
	});

	describe('wasm modules', () => {
		// 41-byte wasm binary exporting add(i32,i32)->i32 — see AGENTS.md/task spec.
		const ADD_WASM_BASE64 = 'AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=';

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('POST /api/run { type: "example", exampleId: "wasm-add" } succeeds and computes a + b in wasm', async () => {
			stubTargetFetch('<html>hello world</html>');

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.230' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'wasm-add' },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: { a: number; b: number; 'a + b (computed in wasm)': number };
			}>();
			expect(data.ok).toBe(true);
			expect(data.result).toBeDefined();
			if (data.result) {
				expect(data.result['a + b (computed in wasm)']).toBe(data.result.a + data.result.b);
			}
		});

		it('POST custom run with script + modules payload succeeds end-to-end', async () => {
			stubTargetFetch('<html>hi</html>');

			const customCode = `import addModule from './add.wasm';
export default async (env, input) => {
	const { exports } = await WebAssembly.instantiate(addModule);
	return exports.add(2, 3);
};`;

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.231' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode, modules: [{ name: 'add.wasm', kind: 'wasm', base64: ADD_WASM_BASE64 }] },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: number }>();
			expect(data.ok).toBe(true);
			expect(data.result).toBe(5);
		});

		it('rejects invalid base64 with 400 bad_request', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.232' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: 'export default () => 1',
						modules: [{ name: 'add.wasm', kind: 'wasm', base64: '!!!not base64!!!' }],
					},
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
		});

		it('rejects an oversized module with 400 bad_request', async () => {
			// 9 MiB of zero bytes, base64-encoded — over the 8 MiB per-module cap.
			const oversized = new Uint8Array(9 * 1024 * 1024);
			let binary = '';
			for (const byte of oversized) binary += String.fromCharCode(byte);
			const base64 = btoa(binary);

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.233' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: 'export default () => 1', modules: [{ name: 'add.wasm', kind: 'wasm', base64 }] },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
		});

		it('rejects a bad module name with 400 bad_request', async () => {
			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.234' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: 'export default () => 1',
						modules: [{ name: 'user.js', kind: 'wasm', base64: ADD_WASM_BASE64 }],
					},
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
		});
	});

	describe('image-hash example (photon wasm + fetchFile capability)', () => {
		// A real, valid 1x1 PNG (the classic minimal test PNG).
		const PNG_1X1_BASE64 =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubPageAndImage(): void {
			const page = 'http://example.com/page';
			const imageUrl = 'http://example.com/photo.png';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === imageUrl) {
						const bytes = Uint8Array.from(atob(PNG_1X1_BASE64), (c) => c.charCodeAt(0));
						return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }));
					}
					return Promise.resolve(
						new Response(`<html><body><img src="${imageUrl}"><img src="/relative.png"></body></html>`, {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);
		}

		it('POST /api/run { type: "example", exampleId: "image-hash" } fetches images and computes a dhash', async () => {
			stubPageAndImage();

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.240' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'image-hash' },
					url: 'http://example.com/page',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: { images: Array<{ url: string; width?: number; height?: number; dhash?: string; error?: string }> };
				error?: { kind: string; message: string };
			}>();
			expect(data.ok).toBe(true);
			expect(data.result?.images.length).toBeGreaterThan(0);
			const decoded = data.result?.images.find((i) => i.url === 'http://example.com/photo.png');
			expect(decoded).toBeDefined();
			expect(decoded?.width).toBe(1);
			expect(decoded?.height).toBe(1);
			expect(decoded?.dhash).toMatch(/^[0-9a-f]{16}$/);
		});

		it('runs the image-hash example source verbatim as edited custom code (sucrase + injected dep + request-supplied wasm)', async () => {
			stubPageAndImage();

			const example = getExample('image-hash');
			expect(example).toBeDefined();
			if (!example) return;
			const photonModule = example.modules?.find((m) => m.name === 'photon.wasm');
			expect(photonModule).toBeDefined();
			if (!photonModule) return;

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.241' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: example.source,
						modules: [{ name: 'photon.wasm', kind: 'wasm', base64: photonModule.base64 }],
					},
					url: 'http://example.com/page',
					permissions: { fetch: 'page-links', cpuMs: 2000 },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: { images: Array<{ url: string; width?: number; height?: number; dhash?: string; error?: string }> };
				error?: { kind: string; message: string };
			}>();
			expect(data.ok).toBe(true);
			const decoded = data.result?.images.find((i) => i.url === 'http://example.com/photo.png');
			expect(decoded).toBeDefined();
			expect(decoded?.width).toBe(1);
			expect(decoded?.height).toBe(1);
			expect(decoded?.dhash).toMatch(/^[0-9a-f]{16}$/);
		});
	});

	describe('arxiv-pdf example (liteparse wasm + fetchFile capability)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubAbstractAndPdf(): void {
			const abstractUrl = 'http://example.com/abs/1234.5678';
			const pdfUrl = 'http://example.com/pdf/1234.5678';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === pdfUrl) {
						const bytes = Uint8Array.from(atob(dummyPdfBase64), (c) => c.charCodeAt(0));
						return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }));
					}
					return Promise.resolve(
						new Response('<html><body><a href="/pdf/1234.5678">View PDF</a></body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);
		}

		it('POST /api/run { type: "example", exampleId: "arxiv-pdf" } fetches the PDF and parses it to markdown', async () => {
			stubAbstractAndPdf();

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.242' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'arxiv-pdf' },
					url: 'http://example.com/abs/1234.5678',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: { title: string | null; pages: number; markdown: string; markdownTruncated: boolean };
				error?: { kind: string; message: string };
			}>();
			expect(data.ok).toBe(true);
			expect(data.result?.title).toBe('Dummy PDF file');
			expect(data.result?.pages).toBe(1);
			expect(data.result?.markdown).toContain('Dummy PDF file');
		});

		it('POST /api/run { type: "example", exampleId: "arxiv-pdf" } fails readably when the page has no PDF link', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('<html><body><p>No PDF here.</p></body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					),
				),
			);

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.243' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'arxiv-pdf' },
					url: 'http://example.com/abs/1234.5678',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; error?: { kind: string; message: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('transform_threw');
			expect(data.error?.message).toContain('No PDF link');
		});
	});

	describe('github-repo example (env.fetch capability, embedded-URL following)', () => {
		const repoUrl = 'https://api.github.com/repos/cloudflare/workerd';
		const contributorsUrl = 'https://api.github.com/repos/cloudflare/workerd/contributors';
		const languagesUrl = 'https://api.github.com/repos/cloudflare/workerd/languages';

		function repoPayload(): string {
			return JSON.stringify({
				full_name: 'cloudflare/workerd',
				description: 'The JavaScript/Wasm runtime that powers Cloudflare Workers',
				stargazers_count: 6000,
				forks_count: 300,
				open_issues_count: 42,
				license: { spdx_id: 'Apache-2.0' },
				topics: ['javascript', 'webassembly', 'workers'],
				created_at: '2022-09-30T00:00:00Z',
				pushed_at: '2026-07-01T00:00:00Z',
				contributors_url: contributorsUrl,
				languages_url: languagesUrl,
				// URI template (RFC 6570); deliberately NOT fetchable — see github-repo.ts header comment.
				releases_url: 'https://api.github.com/repos/cloudflare/workerd/releases{/id}',
			});
		}

		function contributorsPayload(): string {
			return JSON.stringify([
				{ login: 'alice', contributions: 500 },
				{ login: 'bob', contributions: 400 },
				{ login: 'carol', contributions: 300 },
				{ login: 'dave', contributions: 200 },
				{ login: 'erin', contributions: 100 },
				{ login: 'frank', contributions: 10 },
			]);
		}

		function languagesPayload(): string {
			return JSON.stringify({ 'C++': 750, TypeScript: 200, JavaScript: 50 });
		}

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('POST /api/run { type: "example", exampleId: "github-repo" } follows embedded contributors_url/languages_url', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === contributorsUrl) {
						return Promise.resolve(
							new Response(contributorsPayload(), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
						);
					}
					if (u === languagesUrl) {
						return Promise.resolve(
							new Response(languagesPayload(), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
						);
					}
					return Promise.resolve(
						new Response(repoPayload(), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
					);
				}),
			);

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.242' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'github-repo' },
					url: repoUrl,
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: {
					repo: { fullName: string; stars: number; license: string | null; topics: string[] };
					topContributors: Array<{ login: string; contributions: number }>;
					languages: Record<string, number>;
				};
				error?: { kind: string; message: string };
			}>();

			expect(data.ok).toBe(true);
			expect(data.result?.repo.fullName).toBe('cloudflare/workerd');
			expect(data.result?.repo.stars).toBe(6000);
			expect(data.result?.repo.license).toBe('Apache-2.0');
			expect(data.result?.repo.topics).toEqual(['javascript', 'webassembly', 'workers']);

			expect(data.result?.topContributors).toHaveLength(5);
			expect(data.result?.topContributors[0]).toEqual({ login: 'alice', contributions: 500 });
			expect(data.result?.topContributors.map((c) => c.login)).not.toContain('frank');

			expect(data.result?.languages).toEqual({ 'C++': 75, TypeScript: 20, JavaScript: 5 });
		});

		it('degrades gracefully when a follow-up fetch is rate-limited (403), keeping the rest of the result', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === contributorsUrl) {
						return Promise.resolve(
							new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
								status: 403,
								headers: { 'content-type': 'application/json; charset=utf-8' },
							}),
						);
					}
					if (u === languagesUrl) {
						return Promise.resolve(
							new Response(languagesPayload(), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
						);
					}
					return Promise.resolve(
						new Response(repoPayload(), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }),
					);
				}),
			);

			const request = new IncomingRequest('http://example.com/api/run', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.243' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'github-repo' },
					url: repoUrl,
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: {
					repo: { fullName: string };
					topContributors: { error?: string };
					languages: Record<string, number>;
				};
			}>();

			expect(data.ok).toBe(true);
			expect(data.result?.repo.fullName).toBe('cloudflare/workerd');
			expect(data.result?.topContributors.error).toContain('rate limit exceeded');
			expect(data.result?.languages).toEqual({ 'C++': 75, TypeScript: 20, JavaScript: 5 });
		});
	});

	describe('fetch failure scenarios', () => {
		it('returns fetch error when target URL fails', async () => {
			const transformCode = 'export default (env, input) => input.status';
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
			const transformCode = 'export default (env, input) => ({ script: "<script>alert(1)</script>" })';
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
