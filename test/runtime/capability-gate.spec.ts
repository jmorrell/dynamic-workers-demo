import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import { releaseGateRun, collectGateSpans } from '../../src/runtime/capability-gate';
import type { ResourceGrant, RunInput } from '../../src/runtime/types';

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

function resources(...urls: string[]): ResourceGrant[] {
	return urls.map((url, index) => ({ id: `resource-${index}`, url, source: { kind: 'text' } }));
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
		it('a target-bound capability attached in the loaded worker env is callable via RPC from inside the sandbox', async () => {
			stubGateFetch(() => new Response('linked page body', { status: 200, headers: { 'content-type': 'text/plain' } }));

			const allowed = 'https://example.com/linked';
			const code = `export default async (env) => {
				const res = await env.resources.get('${allowed}').read();
				return { kind: res.kind, status: res.status, body: res.body, contentType: res.contentType, truncated: res.truncated };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ kind: 'text', status: 200, body: 'linked page body', contentType: 'text/plain', truncated: false });
			}
		});

		it('env is empty (no resources) when no fetch permission is granted', async () => {
			const code = `export default (env) => ({ keys: Object.keys(env), hasResources: typeof env.resources });`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx);
			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ keys: [], hasResources: 'undefined' });
			}
		});
	});

	describe('capability enforcement', () => {
		it('an arbitrary URL string does not confer authority: it is absent from the resource map', async () => {
			stubGateFetch(() => new Response('nope', { status: 200 }));

			const allowed = 'https://example.com/linked';
			const notLinked = 'https://example.com/not-linked';
			const code = `export default (env) => ({
				hasLinked: env.resources.has('${allowed}'),
				hasNotLinked: env.resources.has('${notLinked}'),
				notLinked: env.resources.get('${notLinked}'),
			});`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.value).toEqual({ hasLinked: true, hasNotLinked: false, notLinked: undefined });
			}
			expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		});

		it('blocks a private/loopback target even if it was granted by the host', async () => {
			stubGateFetch(() => new Response('secret', { status: 200 }));

			const blocked = 'http://127.0.0.1/admin';
			const code = `export default async (env) => {
				try { await env.resources.get('${blocked}').read(); }
				catch (e) { return String(e.message || e); }
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' },
				initialResources: resources(blocked),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') expect(String(result.value)).toContain('blocked host');
		});
	});

	describe('redirect handling', () => {
		it('does not follow redirects: a resource that 302s yields the 3xx status, not the redirect target body', async () => {
			stubGateFetch(() =>
				new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
			);

			const allowed = 'https://example.com/redirector';
			const code = `export default async (env) => {
				const res = await env.resources.get('${allowed}').read();
				return { kind: res.kind, status: res.status, body: res.body };
			}`;

			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ kind: 'text', status: 302, body: '' });
		});

		it('requests with redirect: manual so the underlying fetch never follows the redirect itself', async () => {
			let capturedInit: RequestInit | undefined;
			vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				capturedInit = init;
				return Promise.resolve(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			}));

			const allowed = 'https://example.com/linked';
			const code = `export default async (env) => (await env.resources.get('${allowed}').read()).status;`;
			await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});
			expect(capturedInit?.redirect).toBe('manual');
		});
	});

	describe('content-type result selection', () => {
		it('returns bytes for a binary resource', async () => {
			stubGateFetch(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));

			const allowed = 'https://example.com/file.bin';
			const code = `export default async (env) => {
				const res = await env.resources.get('${allowed}').read();
				return { kind: res.kind, status: res.status, len: res.bytes.length, first: res.bytes[0], contentType: res.contentType };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ kind: 'bytes', status: 200, len: 4, first: 1, contentType: 'application/octet-stream' });
		});
	});

	describe('request-count cap', () => {
		it('enforces a per-run cap of 5 resource reads', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const allowed = 'https://example.com/linked';
			const code = `export default async (env) => {
				const outcomes = []; const resource = env.resources.get('${allowed}');
				for (let i = 0; i < 7; i++) try { outcomes.push('ok:' + (await resource.read()).status); }
				catch (e) { outcomes.push('err:' + String(e.message || e)); }
				return outcomes;
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const outcomes = result.value as string[];
				expect(outcomes.filter((outcome) => outcome.startsWith('ok:'))).toHaveLength(5);
				expect(outcomes.filter((outcome) => outcome.startsWith('err:'))).toHaveLength(2);
				expect(outcomes[5]).toContain('5-read limit');
			}
		});

		it('honors maxFetches: 2, denying the third resource read and naming the granted number', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const allowed = 'https://example.com/linked';
			const code = `export default async (env) => {
				const outcomes = []; const resource = env.resources.get('${allowed}');
				for (let i = 0; i < 3; i++) try { outcomes.push('ok:' + (await resource.read()).status); }
				catch (e) { outcomes.push('err:' + String(e.message || e)); }
				return outcomes;
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', maxFetches: 2 }, initialResources: resources(allowed),
			});

			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual(['ok:200', 'ok:200', expect.stringContaining('2-read limit')]);
		});
	});

	describe('fetchDepth (explicit child capability minting)', () => {
		const pageB = 'https://example.com/page-b'; // depth 1: granted by the initial document
		const pageC = 'https://example.com/page-c'; // depth 2: minted by reading B
		const pageD = 'https://example.com/page-d'; // depth 3: would be minted by C

		function stubLinks(linksByUrl: Record<string, string[]>): void {
			stubGateFetch((url) => {
				const links = linksByUrl[url] ?? [];
				const body = `<html><body>${links.map((link) => `<a href="${link}">l</a>`).join('')}</body></html>`;
				return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
			});
		}

		it('default depth 1: reading B does not mint its links as child capabilities', async () => {
			stubLinks({ [pageB]: [pageC] });
			const code = `export default async (env) => {
				const b = await env.resources.get('${pageB}').read();
				return { rootHasC: env.resources.has('${pageC}'), childHasC: b.resources.has('${pageC}') };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(pageB),
			});
			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ rootHasC: false, childHasC: false });
		});

		it('depth 2: C is absent from the root map and becomes available only from B\'s text result', async () => {
			stubLinks({ [pageB]: [pageC] });
			const code = `export default async (env) => {
				const before = env.resources.has('${pageC}');
				const b = await env.resources.get('${pageB}').read();
				const c = await b.resources.get('${pageC}').read();
				return { before, childStatus: c.status };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ before: false, childStatus: 200 });
		});

		it('depth bound: with depth 2, reading C does not mint its depth-3 links', async () => {
			stubLinks({ [pageB]: [pageC], [pageC]: [pageD] });
			const code = `export default async (env) => {
				const b = await env.resources.get('${pageB}').read();
				const c = await b.resources.get('${pageC}').read();
				return { rootHasD: env.resources.has('${pageD}'), childHasD: c.resources.has('${pageD}') };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ rootHasD: false, childHasD: false });
		});

		it('a non-ok text response does not mint child capabilities', async () => {
			stubGateFetch(() => new Response(`<html><body><a href="${pageC}">l</a></body></html>`, {
				status: 500, headers: { 'content-type': 'text/html' },
			}));
			const code = `export default async (env) => {
				const b = await env.resources.get('${pageB}').read();
				return { status: b.status, childHasC: b.resources.has('${pageC}') };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ status: 500, childHasC: false });
		});

		it('a bytes result never mints child capabilities, even at depth 2', async () => {
			stubGateFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
			const code = `export default async (env) => {
				const b = await env.resources.get('${pageB}').read();
				return { kind: b.kind, hasResources: 'resources' in b };
			}`;
			const result = await runInLoader(env, makeInput(), code, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(result.type).toBe('success');
			if (result.type === 'success') expect(result.value).toEqual({ kind: 'bytes', hasResources: false });
		});

		it('child capabilities are scoped per runId', async () => {
			stubLinks({ [pageB]: [pageC] });
			const codeA = `export default async (env) => {
				const b = await env.resources.get('${pageB}').read(); return b.resources.has('${pageC}');
			}`;
			const resultA = await runInLoader(env, makeInput(), codeA, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(resultA).toMatchObject({ type: 'success', value: true });

			const codeB = `export default (env) => env.resources.has('${pageC}');`;
			const resultB = await runInLoader(env, makeInput(), codeB, crypto.randomUUID(), ctx, {
				permissions: { fetch: 'page-links', fetchDepth: 2 }, initialResources: resources(pageB),
			});
			expect(resultB).toMatchObject({ type: 'success', value: false });
		});
	});

	describe('gate spans (collectGateSpans)', () => {
		it('records an ok span for a successful resource read with url/httpStatus/bytes/truncated/depth attrs', async () => {
			stubGateFetch(() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const allowed = 'https://example.com/linked';
			const runId = crypto.randomUUID();
			const code = `export default async (env) => { await env.resources.get('${allowed}').read(); return 'ok'; }`;
			const result = await runInLoader(env, makeInput(), code, runId, ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});
			expect(result.type).toBe('success');

			const spans = collectGateSpans(runId);
			expect(spans).toHaveLength(1);
			expect(spans[0].status).toBe('ok');
			expect(spans[0].attrs).toMatchObject({
				name: 'resource.read', kind: 'gate_resource_read', url: allowed, httpStatus: 200,
				truncated: false, depth: 1, resourceKind: 'text',
			});
			expect(typeof spans[0].attrs.bytes).toBe('number');
			expect(spans[0].startAbsMs).toBeLessThanOrEqual(spans[0].endAbsMs);
		});

		it('records a bytes resource read with the same resource.read span kind', async () => {
			stubGateFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
			const allowed = 'https://example.com/file.bin';
			const runId = crypto.randomUUID();
			const code = `export default async (env) => { await env.resources.get('${allowed}').read(); return 'ok'; }`;
			await runInLoader(env, makeInput(), code, runId, ctx, {
				permissions: { fetch: 'page-links' }, initialResources: resources(allowed),
			});

			const spans = collectGateSpans(runId);
			expect(spans).toHaveLength(1);
			expect(spans[0].attrs).toMatchObject({
				name: 'resource.read', kind: 'gate_resource_read', url: allowed, httpStatus: 200,
				bytes: 3, truncated: false, resourceKind: 'bytes',
			});
		});

		it('scopes spans per runId', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const allowed = 'https://example.com/linked';
			const runA = crypto.randomUUID();
			const runB = crypto.randomUUID();
			const code = `export default async (env) => { await env.resources.get('${allowed}').read(); return 'ok'; }`;
			await runInLoader(env, makeInput(), code, runA, ctx, { permissions: { fetch: 'page-links' }, initialResources: resources(allowed) });
			expect(collectGateSpans(runA)).toHaveLength(1);
			expect(collectGateSpans(runB)).toHaveLength(0);
		});
	});

	describe('releaseGateRun', () => {
		const pageB = 'https://example.com/release-page-b';
		const code = `export default async (env) => { await env.resources.get('${pageB}').read(); return 'ok'; }`;

		it('clears the gate-span map too: collectGateSpans is empty for the runId after release', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const runId = crypto.randomUUID();
			await runInLoader(env, makeInput(), code, runId, ctx, { permissions: { fetch: 'page-links' }, initialResources: resources(pageB) });
			expect(collectGateSpans(runId)).toHaveLength(1);
			releaseGateRun(runId);
			expect(collectGateSpans(runId)).toHaveLength(0);
		});

		it('clears the resource-read count for a runId', async () => {
			stubGateFetch(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
			const runId = crypto.randomUUID();
			const useUp = `export default async (env) => {
				const r = env.resources.get('${pageB}'); for (let i = 0; i < 5; i++) await r.read(); return 'used';
			}`;
			const result1 = await runInLoader(env, makeInput(), useUp, runId, ctx, { permissions: { fetch: 'page-links' }, initialResources: resources(pageB) });
			expect(result1).toMatchObject({ type: 'success', value: 'used' });

			const beforeRelease = await runInLoader(env, makeInput(), code, runId, ctx, { permissions: { fetch: 'page-links' }, initialResources: resources(pageB) });
			expect(beforeRelease.type).toBe('failure');
			if (beforeRelease.type === 'failure') expect(beforeRelease.error.message).toContain('5-read limit');

			releaseGateRun(runId);
			const afterRelease = await runInLoader(env, makeInput(), code, runId, ctx, { permissions: { fetch: 'page-links' }, initialResources: resources(pageB) });
			expect(afterRelease).toMatchObject({ type: 'success', value: 'ok' });
		});
	});
});
