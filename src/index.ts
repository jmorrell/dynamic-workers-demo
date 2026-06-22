// pattern: Imperative Shell

import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import type { RunResult } from './runtime/types';

// pattern: Imperative Shell
async function handleRun(request: Request, env: Env): Promise<Response> {
	// Validate method
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}

	// Parse JSON body
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'content-type': 'application/json' } });
	}

	// Validate request shape
	if (typeof body !== 'object' || body === null || !('customCode' in body) || !('url' in body)) {
		return new Response(
			JSON.stringify({
				error: 'Missing required fields: customCode, url',
			}),
			{ status: 400, headers: { 'content-type': 'application/json' } },
		);
	}

	const { customCode, url } = body as { customCode: unknown; url: unknown };

	if (typeof customCode !== 'string' || typeof url !== 'string') {
		return new Response(
			JSON.stringify({
				error: 'customCode and url must be strings',
			}),
			{ status: 400, headers: { 'content-type': 'application/json' } },
		);
	}

	// Fetch target URL
	const fetchOutcome = await fetchTarget(url);

	if (!fetchOutcome.ok) {
		// Fetch failed - return error without invoking loader
		return new Response(
			JSON.stringify({
				ok: false,
				error: fetchOutcome.error,
				timingMs: 0,
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}

	// Run code in loader
	const startTime = performance.now();
	const result = await runInLoader(env, fetchOutcome.input, customCode);
	const timingMs = Math.round(performance.now() - startTime);

	return new Response(
		JSON.stringify({
			ok: result.ok,
			result: result.ok ? result.value : null,
			error: !result.ok ? result.error : null,
			timingMs,
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Route POST /api/run
		if (url.pathname === '/api/run') {
			return handleRun(request, env);
		}

		// Unknown path
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
