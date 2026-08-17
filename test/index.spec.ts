import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { setTurnstileVerifier } from '../src/index';
import { getExample } from '../src/examples/manifest';
import articleHtml from './examples/fixtures/article.html?raw';
import dummyPdfBase64 from './examples/fixtures/dummy-pdf.base64.txt?raw';
import { API_PREFIX, ASSET_PREFIX } from '../src/paths';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Fetches a module's bytes via the ASSETS binding (same host-side path
// src/index.ts's example-run wasmModules injection uses) and base64-encodes
// them — a stand-in for what the frontend does client-side against the same
// asset, now that manifest module entries carry assetPath instead of base64.
async function fetchModuleBase64(assetPath: string): Promise<string> {
	const res = await env.ASSETS.fetch(new URL(assetPath, 'https://assets.local'));
	expect(res.ok).toBe(true);
	const bytes = new Uint8Array(await res.arrayBuffer());
	return Buffer.from(bytes).toString('base64');
}

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
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/examples`, {
			method: 'GET',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');

		const data = await response.json<Array<{ id: string; title: string; description: string }>>();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBe(13);

		// Should not contain code field
		for (const example of data) {
			expect('code' in example).toBe(false);
		}
	});

	it('surfaces maxFetches in the digest examples permissions (round-tripped through the manifest)', async () => {
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/examples`, { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const data = await response.json<Array<{ id: string; permissions?: { fetch: string; fetchDepth?: number; maxFetches?: number } }>>();
		const rssDigest = data.find((e) => e.id === 'rss-digest');
		const arxivDigest = data.find((e) => e.id === 'arxiv-digest');
		expect(rssDigest?.permissions?.maxFetches).toBe(6);
		expect(arxivDigest?.permissions?.maxFetches).toBe(6);
		expect(arxivDigest?.permissions?.fetchDepth).toBe(2);
	});

	it('ships only a small wasm preview in the listing', async () => {
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/examples`, { method: 'GET' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const body = await response.text();
		// Regression guard: shipping wasm base64 in the listing previously blew
		// this up to ~8.5 MB for every widget load.
		expect(body.length).toBeLessThan(100 * 1024);

		const data = JSON.parse(body) as Array<{
			id: string;
			modules?: Array<{
				name: string;
				kind: string;
				assetPath?: string;
				previewBase64?: string;
				byteSize?: number;
				base64?: string;
			}>;
		}>;
		const imageHash = data.find((e) => e.id === 'image-hash');
		expect(imageHash?.modules).toHaveLength(1);
		expect(imageHash?.modules?.[0]).toEqual(
				expect.objectContaining({
					name: 'photon.wasm',
					kind: 'wasm',
					assetPath: `${ASSET_PREFIX}/modules/image-hash/photon.wasm`,
					byteSize: expect.any(Number),
				}),
			);
		expect(imageHash?.modules?.[0]?.byteSize).toBeGreaterThan(1_000_000);
		expect(atob(imageHash?.modules?.[0]?.previewBase64 ?? '').length).toBe(1536);
	});

	it('returns 405 for POST /api/examples', async () => {
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/examples`, {
			method: 'POST',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
	});

	it('GET /api/examples still returns manifest with assets binding enabled (routing correct)', async () => {
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/examples`, {
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
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/config`, {
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
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/config`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'GET',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(405);
		});

		it('returns 400 for malformed JSON body', async () => {
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				body: 'invalid json',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when worker is missing', async () => {
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				body: JSON.stringify({ url: 'http://example.com' }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(400);
		});

		it('returns 400 when url is missing', async () => {
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

		it('refuses the cpu-spin example in local development before invoking the loader', async () => {
			const developmentEnv = { ...env, ENVIRONMENT: 'development' } as Env;
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.205' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'cpu-spin' },
					url: 'http://example.com',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, developmentEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; error?: { kind: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('local_cpu_limits_unavailable');
		});

		it('also refuses locally edited code originating from the cpu-spin example', async () => {
			const developmentEnv = { ...env, ENVIRONMENT: 'development' } as Env;
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.206' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: 'while (true) {}',
						sourceExampleId: 'cpu-spin',
					},
					url: 'http://example.com',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, developmentEnv, ctx);
			await waitOnExecutionContext(ctx);

			const data = await response.json<{ ok: boolean; error?: { kind: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('local_cpu_limits_unavailable');
		});
	});

	describe('happy path - successful transform', () => {
		it('POST /api/run with customCode returns 200 and result structure', async () => {
			const transformCode = 'export default (env, input) => input.status';
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

	describe('resultHtml (markdown rendering)', () => {
		it('a success result shaped like { markdown } gains a rendered resultHtml field', async () => {
			stubTargetFetch('<html>hi</html>');

			const customCode = "export default (env, input) => ({ markdown: '# hi' })";
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.230' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: unknown; resultHtml?: string }>();
			expect(data.ok).toBe(true);
			expect(typeof data.resultHtml).toBe('string');
			expect(data.resultHtml).toContain('<h1>');
		});

		it('a non-markdown-shaped success result has no resultHtml field', async () => {
			stubTargetFetch('<html>hi</html>');

			const customCode = 'export default (env, input) => input.status';
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.231' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: unknown; resultHtml?: string }>();
			expect(data.ok).toBe(true);
			expect(data.resultHtml).toBeUndefined();
		});
	});

	describe('capabilities: page-links resource permission (end-to-end)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('custom run with fetch:page-links can read a resource capability granted by the fetched page', async () => {
			const linked = 'https://example.com/linked-doc';
			// One stub serves both the target page fetch (fetchTarget) and the granted
			// resource's read(), keyed by URL.
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
				const resource = env.resources.get('${linked}');
				if (!resource) throw new Error('linked resource was not granted');
				const res = await resource.read();
				if (res.kind !== 'text') throw new Error('expected text resource');
				return { fetchedStatus: res.status, fetchedBody: res.body };
			}`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

		it('a URL not linked from the page has no resource capability', async () => {
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

			const customCode = `export default async (env, input) =>
				env.resources.has('https://example.com/not-linked');`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

			const data = await response.json<{ ok: boolean; result?: boolean }>();
			expect(data.ok).toBe(true);
			expect(data.result).toBe(false);
		});

		it('custom run with fetchDepth 2 can read a resource discovered from another resource (B then C)', async () => {
			const linkedB = 'https://example.com/linked-b';
			const linkedC = 'https://example.com/linked-c';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === linkedB) {
						return Promise.resolve(
							new Response(`<html><body><a href="${linkedC}">c</a></body></html>`, {
								status: 200,
								headers: { 'content-type': 'text/html' },
							}),
						);
					}
					if (u === linkedC) {
						return Promise.resolve(new Response('LINKED C CONTENT', { status: 200, headers: { 'content-type': 'text/plain' } }));
					}
					return Promise.resolve(
						new Response(`<html><body><a href="${linkedB}">b</a></body></html>`, {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);

			const customCode = `export default async (env, input) => {
				const bResource = env.resources.get('${linkedB}');
				if (!bResource) throw new Error('B resource was not granted');
				const b = await bResource.read();
				if (b.kind !== 'text') throw new Error('expected B to be text');
				const cResource = b.resources.get('${linkedC}');
				if (!cResource) throw new Error('C resource was not granted');
				const c = await cResource.read();
				return { bStatus: b.status, cStatus: c.status };
			}`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.223' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/page',
					permissions: { fetch: 'page-links', fetchDepth: 2 },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: { bStatus: number; cStatus: number } }>();
			expect(data.ok).toBe(true);
			expect(data.result?.bStatus).toBe(200);
			expect(data.result?.cStatus).toBe(200);
		});

		it('control: without fetchDepth (default 1), a read resource does not grant its child C capability', async () => {
			const linkedB = 'https://example.com/linked-b-2';
			const linkedC = 'https://example.com/linked-c-2';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === linkedB) {
						return Promise.resolve(
							new Response(`<html><body><a href="${linkedC}">c</a></body></html>`, {
								status: 200,
								headers: { 'content-type': 'text/html' },
							}),
						);
					}
					return Promise.resolve(
						new Response(`<html><body><a href="${linkedB}">b</a></body></html>`, {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);

			const customCode = `export default async (env, input) => {
				const bResource = env.resources.get('${linkedB}');
				if (!bResource) throw new Error('B resource was not granted');
				const b = await bResource.read();
				if (b.kind !== 'text') throw new Error('expected B to be text');
				const cResource = b.resources.get('${linkedC}');
				if (!cResource) throw new Error('C resource was not granted');
				return 'should-not-reach';
			}`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.224' },
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
			const data = await response.json<{ ok: boolean; error?: { kind: string; message: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('transform_threw');
			expect(data.error?.message).toContain('C resource was not granted');
		});

		it('custom run with maxFetches: 2 is denied on the third of three granted resource reads, naming the granted limit', async () => {
			const urlA = 'https://example.com/max-fetches-a';
			const urlB = 'https://example.com/max-fetches-b';
			const urlC = 'https://example.com/max-fetches-c';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === urlA || u === urlB || u === urlC) {
						return Promise.resolve(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
					}
					return Promise.resolve(
						new Response(
							`<html><body><a href="${urlA}">a</a><a href="${urlB}">b</a><a href="${urlC}">c</a></body></html>`,
							{ status: 200, headers: { 'content-type': 'text/html' } },
						),
					);
				}),
			);

			const customCode = `export default async (env, input) => {
				try {
					const a = env.resources.get('${urlA}');
					const b = env.resources.get('${urlB}');
					const c = env.resources.get('${urlC}');
					if (!a || !b || !c) throw new Error('expected all resource grants');
					await a.read();
					await b.read();
					await c.read();
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.225' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode },
					url: 'http://example.com/page',
					permissions: { fetch: 'page-links', maxFetches: 2 },
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: string }>();
			expect(data.ok).toBe(true);
			expect(data.result).toContain('2-read limit');
		});

		it('rejects a custom run with a malformed permissions shape (400 bad_request)', async () => {
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

	describe('JavaScript modules', () => {
		it('uses an edited support module in a custom run', async () => {
			stubTargetFetch('<html>hi</html>');
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.230' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: "import { answer } from './helper'; export default () => answer;",
						modules: [{ name: 'helper', kind: 'js', source: 'export const answer: number = 42;' }],
					},
					url: 'http://example.com/test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{ ok: boolean; result?: number }>();
			expect(data).toMatchObject({ ok: true, result: 42 });
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

	describe('image-hash example (photon wasm + image resource capability)', () => {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const photonBase64 = await fetchModuleBase64(photonModule.assetPath);

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.241' },
				body: JSON.stringify({
					worker: {
						type: 'custom',
						customCode: example.source,
						modules: [{ name: 'photon.wasm', kind: 'wasm', base64: photonBase64 }],
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

	describe('arxiv-pdf example (liteparse wasm + PDF resource capability)', () => {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
				result?: {
					markdown: string;
					json: { title: string | null; pages: number; markdownTruncated: boolean };
				};
				error?: { kind: string; message: string };
			}>();
			expect(data.ok).toBe(true);
			expect(data.result?.json.title).toBe('Dummy PDF file');
			expect(data.result?.json.pages).toBe(1);
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

	describe('arxiv-digest example (resource depth 2: page -> abstract -> PDF)', () => {
		const pageUrl = 'http://example.com/citing-page';
		const absUrl = 'https://arxiv.org/abs/1234.5678';
		const pdfUrl = 'https://arxiv.org/pdf/1234.5678';

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubPageAbsAndPdf(): void {
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === pdfUrl) {
						const bytes = Uint8Array.from(atob(dummyPdfBase64), (c) => c.charCodeAt(0));
						return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }));
					}
					if (u === absUrl) {
						return Promise.resolve(
							new Response(
								`<html><head>
<meta name="citation_title" content="A Great Paper">
<meta name="citation_author" content="Alice Author">
<meta name="citation_pdf_url" content="${pdfUrl}">
</head><body><blockquote class="abstract">Abstract: This paper is great.</blockquote></body></html>`,
								{ status: 200, headers: { 'content-type': 'text/html' } },
							),
						);
					}
					return Promise.resolve(
						new Response(`<html><body><a href="${absUrl}">See the paper</a></body></html>`, {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
				}),
			);
		}

		it('POST /api/run { type: "example", exampleId: "arxiv-digest" } grants resources from the citing page to the abstract page to the PDF', async () => {
			stubPageAbsAndPdf();

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.245' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'arxiv-digest' },
					url: pageUrl,
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: {
					papersFound: number;
					papers: Array<{ absUrl: string; title?: string | null; excerpt?: string; error?: string }>;
				};
				error?: { kind: string; message: string };
			}>();

			expect(data.ok).toBe(true);
			expect(data.result?.papersFound).toBe(1);
			const paper = data.result?.papers[0];
			expect(paper?.absUrl).toBe(absUrl);
			expect(paper?.error).toBeUndefined();
			expect(paper?.title).toBe('A Great Paper');
			expect(paper?.excerpt).toContain('Dummy PDF file');
		});
	});

	describe('github-repo example (resource capability, embedded-URL following)', () => {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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

	describe('rss-digest example (resource capability, feed item following)', () => {
		const feedUrl = 'http://example.com/feed.rss';
		const article1Url = 'http://example.com/article1';
		const article2Url = 'http://example.com/article2';

		function feedBody(): string {
			return `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title>Example Feed</title>
<item>
<title><![CDATA[First Article]]></title>
<link>${article1Url}</link>
</item>
<item>
<title>Second Article</title>
<link>${article2Url}</link>
</item>
</channel>
</rss>`;
		}

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('POST /api/run { type: "example", exampleId: "rss-digest" } follows item links, tolerating a per-item failure', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === article1Url) {
						return Promise.resolve(
							new Response('<html><body><article><h1>Hello</h1><p>Some words here.</p></article></body></html>', {
								status: 200,
								headers: { 'content-type': 'text/html' },
							}),
						);
					}
					if (u === article2Url) {
						return Promise.resolve(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
					}
					return Promise.resolve(new Response(feedBody(), { status: 200, headers: { 'content-type': 'application/rss+xml' } }));
				}),
			);

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.244' },
				body: JSON.stringify({
					worker: { type: 'example', exampleId: 'rss-digest' },
					url: feedUrl,
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<{
				ok: boolean;
				result?: {
					markdown: string;
					json: {
						feedTitle: string | null;
						itemCount: number;
						items: Array<{ title: string | null; url: string; markdown?: string; error?: string }>;
					};
				};
				error?: { kind: string; message: string };
			}>();

			expect(data.ok).toBe(true);
			expect(data.result?.json.feedTitle).toBe('Example Feed');
			expect(data.result?.json.itemCount).toBe(2);

			const first = data.result?.json.items.find((i) => i.url === article1Url);
			expect(first?.title).toBe('First Article');
			expect(first?.markdown).toBeTruthy();
			expect(first?.error).toBeUndefined();

			const second = data.result?.json.items.find((i) => i.url === article2Url);
			expect(second?.title).toBe('Second Article');
			expect(second?.error).toContain('404');
		});
	});

	describe('trace (per-invocation span waterfall)', () => {
		type TraceSpan = {
			traceId: string;
			spanId: string;
			parentSpanId?: string;
			startMs: number;
			durMs: number;
			status: 'ok' | 'error';
			attrs: Record<string, string | number | boolean>;
		};
		type TraceBody = {
			ok: boolean;
			trace?: { traceId: string; totalMs: number; spans: TraceSpan[] };
		};

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('a page-links run carries a full trace: root + target_fetch + loader + logs_read + resource read span, correctly parented and monotonic', async () => {
			const linked = 'https://example.com/traced-linked';
			const notLinked = 'https://example.com/traced-not-linked';
			vi.stubGlobal(
				'fetch',
				vi.fn((input: RequestInfo | URL) => {
					const u = typeof input === 'string' ? input : input.toString();
					if (u === linked) {
						return Promise.resolve(new Response('LINKED', { status: 200, headers: { 'content-type': 'text/plain' } }));
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
				const resource = env.resources.get('${linked}');
				if (!resource) throw new Error('linked resource was not granted');
				const res = await resource.read();
				if (res.kind !== 'text') throw new Error('expected text resource');
				return { status: res.status, notLinkedIsGranted: env.resources.has('${notLinked}') };
			}`;

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.250' },
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
			const data = await response.json<TraceBody>();
			expect(data.ok).toBe(true);
			expect(data.trace).toBeDefined();
			const trace = data.trace!;
			const spans = trace.spans;

			// Every span shares the run's traceId, and spanIds are unique.
			expect(spans.every((s) => s.traceId === trace.traceId)).toBe(true);
			expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);

			const byName = (name: string) => spans.filter((s) => s.attrs.name === name);
			const root = byName('run')[0];
			const targetFetch = byName('target_fetch')[0];
			const loader = byName('loader')[0];
			const logsRead = byName('logs_read')[0];
			expect(root).toBeDefined();
			expect(targetFetch).toBeDefined();
			expect(loader).toBeDefined();
			expect(logsRead).toBeDefined();

			// Parenting: root has no parent; host phases parent to root; resource-read
			// spans parent to the loader span.
			expect(root.parentSpanId).toBeUndefined();
			expect(targetFetch.parentSpanId).toBe(root.spanId);
			expect(loader.parentSpanId).toBe(root.spanId);
			expect(logsRead.parentSpanId).toBe(root.spanId);

			const resourceReadSpans = spans.filter((s) => s.parentSpanId === loader.spanId);
			expect(resourceReadSpans).toHaveLength(1);
			expect(resourceReadSpans[0]?.status).toBe('ok');
			expect(resourceReadSpans[0]?.attrs).toMatchObject({
				name: 'resource.read',
				kind: 'gate_resource_read',
				url: linked,
				httpStatus: 200,
			});

			// totalMs is the root span's own duration.
			expect(trace.totalMs).toBe(root.durMs);

			// Spans arrive sorted by startMs (monotonic non-decreasing), root first.
			expect(spans[0].spanId).toBe(root.spanId);
			for (let i = 1; i < spans.length; i++) {
				expect(spans[i].startMs).toBeGreaterThanOrEqual(spans[i - 1].startMs);
			}
			for (const s of spans) {
				expect(s.startMs).toBeGreaterThanOrEqual(0);
				expect(s.durMs).toBeGreaterThanOrEqual(0);
			}
			expect(targetFetch.status).toBe('ok');
			expect(targetFetch.attrs.httpStatus).toBe(200);
		});

		it('a plain no-network run has a trace with the host phases and no gate spans', async () => {
			stubTargetFetch('<html>hi</html>');

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.251' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: 'export default (env, input) => input.status' },
					url: 'http://example.com/page',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<TraceBody>();
			expect(data.ok).toBe(true);
			expect(data.trace).toBeDefined();
			const spans = data.trace!.spans;

			const names = spans.map((s) => s.attrs.name).sort();
			expect(names).toEqual(['loader', 'logs_read', 'run', 'target_fetch']);
			const loader = spans.find((s) => s.attrs.name === 'loader')!;
			expect(spans.filter((s) => s.parentSpanId === loader.spanId)).toHaveLength(0);
		});

		it('a transpile failure still carries a trace (root-only)', async () => {
			stubTargetFetch('<html>hi</html>');

			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.252' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: 'export default (env, input) => { const x = ; }' },
					url: 'http://example.com/page',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<TraceBody & { error?: { kind: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('compile_failed');
			expect(data.trace).toBeDefined();
			const spans = data.trace!.spans;
			expect(spans).toHaveLength(1);
			expect(spans[0].attrs.name).toBe('run');
			expect(spans[0].status).toBe('error');
		});

		it('a target-fetch failure carries a trace with root + an error target_fetch span', async () => {
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.253' },
				body: JSON.stringify({
					worker: { type: 'custom', customCode: 'export default (env, input) => 1' },
					url: 'http://invalid-url-that-does-not-exist.test',
				}),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const data = await response.json<TraceBody & { error?: { kind: string } }>();
			expect(data.ok).toBe(false);
			expect(data.error?.kind).toBe('fetch_failed');
			const spans = data.trace!.spans;
			expect(spans.map((s) => s.attrs.name).sort()).toEqual(['run', 'target_fetch']);
			const targetFetch = spans.find((s) => s.attrs.name === 'target_fetch')!;
			expect(targetFetch.status).toBe('error');
			expect(targetFetch.attrs.errorKind).toBe('fetch_failed');
			expect(typeof targetFetch.attrs.error).toBe('string');
		});
	});

	describe('fetch failure scenarios', () => {
		it('returns fetch error when target URL fails', async () => {
			const transformCode = 'export default (env, input) => input.status';
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
			const request = new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
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
	// The standalone demo's index.html no longer exists at "/" — the demo is
	// now embedded in blog post pages, not served as its own homepage. These
	// assertions were dropped; in their place, verify the demo's assets
	// (frontend bundle + a wasm module) are still served correctly by the
	// ASSETS binding at their production root-relative paths (SELF here is
	// the blog's router — worker/index.ts — which falls through to
	// env.ASSETS.fetch() for non-/api/* requests).
	it('GET /demos/dynamic-workers/app.js returns 200 with a JS content-type', async () => {
		const response = await SELF.fetch(`http://example.com${ASSET_PREFIX}/app.js`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toMatch(/javascript/);
	});

	it('GET a wasm module asset returns 200 with a wasm content-type', async () => {
		const response = await SELF.fetch(`http://example.com${ASSET_PREFIX}/modules/wasm-add/add.wasm`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toMatch(/wasm/);
	});
});

describe('POST /api/run — storage permission (storeId gate + StorageHost routing)', () => {
	beforeEach(() => {
		setTurnstileVerifier(async () => ({ ok: true, errorCodes: [] }));
		// Target fetch is stubbed (same helper the other run tests use) so these
		// tests never depend on real network reachability of example.com.
		stubTargetFetch('<html>Test page</html>');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		setTurnstileVerifier(async () => ({ ok: false, errorCodes: ['reset'] }));
	});

	// The storage path is exercised through custom runs here so the test can
	// supply a minimal transform whose behavior is easy to assert.
	const storageCode = `export default (env, input) => {
		env.DB.exec('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
		env.DB.exec("INSERT INTO counters VALUES ('runs', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
		return env.DB.exec("SELECT value FROM counters WHERE name = 'runs'").toArray()[0];
	}`;

	function runRequest(body: Record<string, unknown>, ip: string) {
		return new IncomingRequest(`http://example.com${API_PREFIX}/run`, {
			method: 'POST',
			headers: { 'CF-Connecting-IP': ip },
			body: JSON.stringify(body),
		});
	}

	it('returns 400 bad_request when a storage-scoped grant has no storeId', async () => {
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: storageCode },
				permissions: { fetch: 'none', storage: 'scoped' },
			},
			'203.0.113.150',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const data = await response.json<{ ok: boolean; error: { kind: string; message: string } }>();
		expect(data.ok).toBe(false);
		expect(data.error.kind).toBe('bad_request');
		expect(data.error.message).toContain('storeId');
	});

	it('returns 400 bad_request for a malformed storeId', async () => {
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: storageCode },
				permissions: { fetch: 'none', storage: 'scoped' },
				storeId: 'not-a-uuid',
			},
			'203.0.113.151',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const data = await response.json<{ ok: boolean; error: { kind: string } }>();
		expect(data.error.kind).toBe('bad_request');
	});

	it('a storage-granted run reaches the StorageHost path and surfaces the pool facets-absence as a structured error (not a crash)', async () => {
		// DO facets don't exist in the vitest pool (workerd 1.20260310 — see
		// src/runtime/AGENTS.md gotchas), so a run that ROUTES correctly through
		// StorageHost comes back as a run-shaped 200 with a structured
		// loader_failed mentioning facets. This is the pool's routing proof;
		// actual persistence is wrangler-dev/deploy-verified.
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: storageCode },
				permissions: { fetch: 'none', storage: 'scoped' },
				storeId: crypto.randomUUID(),
			},
			'203.0.113.152',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{
			ok: boolean;
			error: { kind: string; message: string } | null;
			logs: unknown[];
			trace?: { spans: Array<{ status: string; attrs: Record<string, unknown> }> };
		}>();
		expect(data.ok).toBe(false);
		expect(data.error?.kind).toBe('loader_failed');
		expect(data.error?.message).toContain('facets');
		// The storage path's loader span carries the distinguishing attr.
		const loaderSpan = data.trace?.spans.find((s) => s.attrs.name === 'loader');
		expect(loaderSpan?.attrs.storage).toBe(true);
	});

	it('accepts an uppercase storeId (normalized server-side) and still routes to StorageHost', async () => {
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: storageCode },
				permissions: { fetch: 'none', storage: 'scoped' },
				storeId: crypto.randomUUID().toUpperCase(),
			},
			'203.0.113.153',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{ ok: boolean; error: { kind: string; message: string } | null }>();
		expect(data.ok).toBe(false);
		expect(data.error?.kind).toBe('loader_failed');
		expect(data.error?.message).toContain('facets');
	});

	it('a non-storage run with an (ignored) storeId keeps the direct path and succeeds', async () => {
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: 'export default (env, input) => input.status' },
				permissions: { fetch: 'none' },
				storeId: crypto.randomUUID(),
			},
			'203.0.113.154',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{ ok: boolean; result: unknown; trace?: { spans: Array<{ attrs: Record<string, unknown> }> } }>();
		expect(data.ok).toBe(true);
		expect(data.result).toBe(200);
		// Direct path: no storage attr on the loader span.
		const loaderSpan = data.trace?.spans.find((s) => s.attrs.name === 'loader');
		expect(loaderSpan?.attrs.storage).toBeUndefined();
	});

	it('an explicit storage:"none" grant behaves exactly like no storage grant', async () => {
		const request = runRequest(
			{
				url: 'http://example.com/test',
				worker: { type: 'custom', customCode: 'export default (env, input) => Object.keys(env)' },
				permissions: { fetch: 'none', storage: 'none' },
			},
			'203.0.113.155',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{ ok: boolean; result: unknown }>();
		expect(data.ok).toBe(true);
		// env stays {} — no storage capability, no gate.
		expect(data.result).toEqual([]);
	});
});

describe('DELETE /api/store handler', () => {
	function storeRequest(body: unknown, ip: string, method = 'DELETE') {
		return new IncomingRequest(`http://example.com${API_PREFIX}/store`, {
			method,
			headers: { 'CF-Connecting-IP': ip, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	it('returns 405 for a non-DELETE method', async () => {
		const request = storeRequest({ storeId: crypto.randomUUID() }, '203.0.113.160', 'POST');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
	});

	it('returns 400 for a missing storeId', async () => {
		const request = storeRequest({}, '203.0.113.161');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const data = await response.json<{ ok: boolean; error: { kind: string } }>();
		expect(data.ok).toBe(false);
		expect(data.error.kind).toBe('bad_request');
	});

	it('returns 400 for a malformed (non-uuid) storeId', async () => {
		const request = storeRequest({ storeId: 'not-a-uuid' }, '203.0.113.162');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const data = await response.json<{ ok: boolean; error: { kind: string } }>();
		expect(data.error.kind).toBe('bad_request');
	});

	it('returns 400 for malformed JSON body', async () => {
		const request = new IncomingRequest(`http://example.com${API_PREFIX}/store`, {
			method: 'DELETE',
			headers: { 'CF-Connecting-IP': '203.0.113.163' },
			body: 'not json',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});

	it('returns 200 { ok: true } for a valid (fresh, never-used) storeId', async () => {
		// selfDestruct on a fresh supervisor DO (no facets ever mounted, no
		// bookkeeping rows) is harmless — it just runs the teardown sequence
		// against empty state. This asserts that doesn't throw.
		const request = storeRequest({ storeId: crypto.randomUUID() }, '203.0.113.164');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{ ok: boolean }>();
		expect(data.ok).toBe(true);
	});

	it('normalizes an uppercase storeId (same casing rule as /api/run)', async () => {
		const request = storeRequest({ storeId: crypto.randomUUID().toUpperCase() }, '203.0.113.165');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json<{ ok: boolean }>();
		expect(data.ok).toBe(true);
	});
});
