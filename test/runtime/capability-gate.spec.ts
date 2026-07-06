import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import type { RunInput } from '../../src/runtime/types';

function makeInput(overrides: Partial<RunInput> = {}): RunInput {
	return {
		url: 'https://example.com/page',
		finalUrl: 'https://example.com/page',
		status: 200,
		contentType: 'text/html',
		responseHeaders: new Map(),
		body: '<html></html>',
		truncated: false,
		...overrides,
	};
}

// Stub the gate's HOST-side outbound fetch. The gate runs in the test worker
// (host side), so a global fetch stub here intercepts its network calls; the
// sandbox itself never has ambient fetch (globalOutbound: null).
function stubGateFetch(impl: (url: string) => Response): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();
			return Promise.resolve(impl(url));
		}),
	);
}

describe('CapabilityGate', () => {
	let ctx: ExecutionContext;

	beforeEach(() => {
		ctx = createExecutionContext();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('env-loopback verification (empirical)', () => {
		it('a ctx.exports loopback attached in the loaded worker env is callable via RPC from inside the sandbox', async () => {
			stubGateFetch(() => new Response('linked page body', { status: 200, headers: { 'content-type': 'text/plain' } }));

			const allowed = 'https://example.com/linked';
			const code = `export default async (env, input) => {
				const res = await env.fetch('${allowed}');
				return { status: res.status, body: res.body, contentType: res.contentType, truncated: res.truncated };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ status: 200, body: 'linked page body', contentType: 'text/plain', truncated: false });
			}
		});

		it('env is empty (no fetch) when no fetch permission is granted', async () => {
			const code = `export default (env, input) => ({ keys: Object.keys(env), hasFetch: typeof env.fetch });`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx);
			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ keys: [], hasFetch: 'undefined' });
			}
		});
	});

	describe('allowlist enforcement', () => {
		it('rejects a URL not referenced by the fetched page with a clear error', async () => {
			stubGateFetch(() => new Response('nope', { status: 200 }));

			const code = `export default async (env, input) => {
				try {
					await env.fetch('https://example.com/not-linked');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: ['https://example.com/linked'],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('not referenced by the fetched page');
			}
		});

		it('blocks a private/loopback target even if the transform smuggles it into the allowlist', async () => {
			stubGateFetch(() => new Response('secret', { status: 200 }));

			const blocked = 'http://127.0.0.1/admin';
			const code = `export default async (env, input) => {
				try {
					await env.fetch('${blocked}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [blocked],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('blocked host');
			}
		});
	});

	describe('redirect handling', () => {
		it('does not follow redirects: an allowed URL that 302s yields the 3xx status, not the redirect target body', async () => {
			stubGateFetch((url) =>
				new Response('', {
					status: 302,
					headers: { location: 'http://169.254.169.254/latest/meta-data' },
				}),
			);

			const allowed = 'https://example.com/redirector';
			const code = `export default async (env, input) => {
				const res = await env.fetch('${allowed}');
				return { status: res.status, body: res.body };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ status: 302, body: '' });
			}
		});

		it('requests with redirect: manual so the underlying fetch never follows the redirect itself', async () => {
			let capturedInit: RequestInit | undefined;
			vi.stubGlobal(
				'fetch',
				vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
					capturedInit = init;
					return Promise.resolve(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
				}),
			);

			const allowed = 'https://example.com/linked';
			const code = `export default async (env, input) => {
				const res = await env.fetch('${allowed}');
				return res.status;
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			expect(capturedInit?.redirect).toBe('manual');
		});
	});

	describe('fetchFile', () => {
		it('returns bytes for an allowed URL', async () => {
			stubGateFetch(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));

			const allowed = 'https://example.com/file.bin';
			const code = `export default async (env, input) => {
				const res = await env.fetchFile('${allowed}');
				return { status: res.status, len: res.bytes.length, first: res.bytes[0], contentType: res.contentType };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ status: 200, len: 4, first: 1, contentType: 'application/octet-stream' });
			}
		});
	});

	describe('request-count cap', () => {
		it('enforces a per-run cap of 5 gate fetches', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));

			const allowed = 'https://example.com/linked';
			const code = `export default async (env, input) => {
				const outcomes = [];
				for (let i = 0; i < 7; i++) {
					try {
						const res = await env.fetch('${allowed}');
						outcomes.push('ok:' + res.status);
					} catch (e) {
						outcomes.push('err:' + String(e.message || e));
					}
				}
				return outcomes;
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const outcomes = result.value as string[];
				const oks = outcomes.filter((o) => o.startsWith('ok:'));
				const errs = outcomes.filter((o) => o.startsWith('err:'));
				expect(oks).toHaveLength(5);
				expect(errs).toHaveLength(2);
				expect(errs[0]).toContain('5-fetch limit');
			}
		});
	});
});
