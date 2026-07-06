import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import { releaseGateRun } from '../../src/runtime/capability-gate';
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
				expect(String(result.value)).toContain('not reachable within the granted fetch depth from the fetched page');
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

		it('honors a granted maxFetches: 2, denying the third fetch and naming the granted number', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));

			const allowed = 'https://example.com/linked';
			const code = `export default async (env, input) => {
				const outcomes = [];
				for (let i = 0; i < 3; i++) {
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
				permissions: { fetch: 'page-links', maxFetches: 2 },
				allowedUrls: [allowed],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const outcomes = result.value as string[];
				expect(outcomes[0]).toBe('ok:200');
				expect(outcomes[1]).toBe('ok:200');
				expect(outcomes[2]).toContain('2-fetch limit');
			}
		});
	});

	describe('fetchDepth (transitive allowlist growth)', () => {
		const pageA = 'https://example.com/page-a'; // the fetched page (implicit; not a gate fetch)
		const pageB = 'https://example.com/page-b'; // depth 1 (in the initial allowlist)
		const pageC = 'https://example.com/page-c'; // linked only from B
		const pageD = 'https://example.com/page-d'; // linked only from C

		function stubLinks(linksByUrl: Record<string, string[]>): void {
			stubGateFetch((url) => {
				const links = linksByUrl[url] ?? [];
				const body = `<html><body>${links.map((l) => `<a href="${l}">l</a>`).join('')}</body></html>`;
				return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
			});
		}

		it('default depth 1: a URL only linked from a fetched page (not the original allowlist) is denied', async () => {
			stubLinks({ [pageB]: [pageC] });

			const code = `export default async (env, input) => {
				await env.fetch('${pageB}');
				try {
					await env.fetch('${pageC}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [pageB],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('not reachable within the granted fetch depth');
			}
		});

		it('depth 2: C is denied before B is fetched, then allowed after (growth happens on fetch, not upfront)', async () => {
			stubLinks({ [pageB]: [pageC] });

			const code = `export default async (env, input) => {
				let beforeStatus;
				try {
					await env.fetch('${pageC}');
					beforeStatus = 'should-not-reach';
				} catch (e) {
					beforeStatus = String(e.message || e);
				}
				await env.fetch('${pageB}');
				const after = await env.fetch('${pageC}');
				return { beforeStatus, afterStatus: after.status };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const value = result.value as { beforeStatus: string; afterStatus: number };
				expect(value.beforeStatus).toContain('not reachable within the granted fetch depth');
				expect(value.afterStatus).toBe(200);
			}
		});

		it('depth bound: with depth 2, a URL only linked from C (depth 3) stays denied even after fetching C', async () => {
			stubLinks({ [pageB]: [pageC], [pageC]: [pageD] });

			const code = `export default async (env, input) => {
				await env.fetch('${pageB}');
				await env.fetch('${pageC}');
				try {
					await env.fetch('${pageD}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('not reachable within the granted fetch depth');
			}
		});

		it('a non-ok response does not grow the allowlist', async () => {
			stubGateFetch((url) => {
				if (url === pageB) {
					return new Response(`<html><body><a href="${pageC}">l</a></body></html>`, {
						status: 500,
						headers: { 'content-type': 'text/html' },
					});
				}
				return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
			});

			const code = `export default async (env, input) => {
				await env.fetch('${pageB}');
				try {
					await env.fetch('${pageC}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('not reachable within the granted fetch depth');
			}
		});

		it('fetchFile does not grow the allowlist even at depth 2', async () => {
			stubGateFetch((url) => {
				if (url === pageB) {
					return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
				}
				return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
			});

			const code = `export default async (env, input) => {
				await env.fetchFile('${pageB}');
				try {
					await env.fetch('${pageC}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(String(result.value)).toContain('not reachable within the granted fetch depth');
			}
		});

		it('grown allowlist entries are scoped per runId', async () => {
			stubLinks({ [pageB]: [pageC] });

			const runA = crypto.randomUUID();
			const codeA = `export default async (env, input) => {
				await env.fetch('${pageB}');
				return 'grown';
			}`;
			const resultA = await runInLoader(env, makeInput(), codeA, runA, ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});
			expect(resultA.type).toBe('success');

			// A fresh run (different runId) never fetched B, so C stays denied even
			// though run A grew its OWN allowlist to include C.
			const runB = crypto.randomUUID();
			const codeB = `export default async (env, input) => {
				try {
					await env.fetch('${pageC}');
					return 'should-not-reach';
				} catch (e) {
					return String(e.message || e);
				}
			}`;
			const resultB = await runInLoader(env, makeInput(), codeB, runB, ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 },
				allowedUrls: [pageB],
			});

			expect(resultB.type).toBe('success');
			if (resultB.type === 'success') {
				expect(String(resultB.value)).toContain('not reachable within the granted fetch depth');
			}
		});
	});

	describe('releaseGateRun', () => {
		const pageB = 'https://example.com/release-page-b';

		it('clears both the fetch-count and grown-allowlist maps for a runId', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));

			const runId = crypto.randomUUID();
			const codeUseUp = `export default async (env, input) => {
				const outcomes = [];
				for (let i = 0; i < 5; i++) {
					const res = await env.fetch('${pageB}');
					outcomes.push(res.status);
				}
				return outcomes;
			}`;
			const result1 = await runInLoader(env, makeInput(), codeUseUp, runId, ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [pageB],
			});
			expect(result1.type).toBe('success');
			if (result1.type === 'success') {
				expect((result1.value as number[]).every((s) => s === 200)).toBe(true);
			}

			// The 6th fetch on this runId would be denied by the count cap — prove it,
			// then release, then prove a fresh count is available for the SAME runId.
			const codeOneMore = `export default async (env, input) => {
				try {
					await env.fetch('${pageB}');
					return 'ok';
				} catch (e) {
					return String(e.message || e);
				}
			}`;
			const beforeRelease = await runInLoader(env, makeInput(), codeOneMore, runId, ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [pageB],
			});
			expect(beforeRelease.type).toBe('success');
			if (beforeRelease.type === 'success') {
				expect(String(beforeRelease.value)).toContain('5-fetch limit');
			}

			releaseGateRun(runId);

			const afterRelease = await runInLoader(env, makeInput(), codeOneMore, runId, ctx, {
				permissions: { fetch: 'page-links' },
				allowedUrls: [pageB],
			});
			expect(afterRelease.type).toBe('success');
			if (afterRelease.type === 'success') {
				expect(afterRelease.value).toBe('ok');
			}
		});
	});
});
