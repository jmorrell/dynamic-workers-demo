// pattern: Imperative Shell

import { fetchTarget } from './runtime/fetch-target';
import { runInLoader } from './runtime/loader';
import type { RunResult } from './runtime/types';
import { listExamples, getExample } from './examples/manifest';

async function handleExamples(request: Request): Promise<Response> {
	// Only GET allowed
	if (request.method !== 'GET') {
		return new Response('Method not allowed', { status: 405 });
	}

	const examples = listExamples();
	return new Response(JSON.stringify(examples), { status: 200, headers: { 'content-type': 'application/json' } });
}

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
	if (typeof body !== 'object' || body === null || !('url' in body)) {
		return new Response(
			JSON.stringify({
				error: 'Missing required field: url',
			}),
			{ status: 400, headers: { 'content-type': 'application/json' } },
		);
	}

	const { exampleId, customCode, url } = body as { exampleId: unknown; customCode: unknown; url: unknown };

	// Validate url
	if (typeof url !== 'string') {
		return new Response(
			JSON.stringify({
				error: 'url must be a string',
			}),
			{ status: 400, headers: { 'content-type': 'application/json' } },
		);
	}

	// Resolve code: either from exampleId or customCode, but not both
	let code: string;

	if (exampleId !== undefined) {
		// exampleId provided - look it up
		if (customCode !== undefined) {
			return new Response(
				JSON.stringify({
					error: 'Cannot specify both exampleId and customCode - provide exactly one',
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			);
		}

		if (typeof exampleId !== 'string') {
			return new Response(
				JSON.stringify({
					error: 'exampleId must be a string',
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			);
		}

		const example = getExample(exampleId);
		if (!example) {
			return new Response(
				JSON.stringify({
					error: `Unknown example: ${exampleId}`,
				}),
				{ status: 404, headers: { 'content-type': 'application/json' } },
			);
		}

		code = example.code;
	} else if (customCode !== undefined) {
		// customCode provided
		if (typeof customCode !== 'string') {
			return new Response(
				JSON.stringify({
					error: 'customCode must be a string',
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			);
		}

		code = customCode;
	} else {
		// Neither provided
		return new Response(
			JSON.stringify({
				error: 'Must provide either exampleId or customCode',
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
	const result = await runInLoader(env, fetchOutcome.input, code);
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

		// Route GET /api/examples
		if (url.pathname === '/api/examples') {
			return handleExamples(request);
		}

		// Route POST /api/run
		if (url.pathname === '/api/run') {
			return handleRun(request, env);
		}

		// Unknown path
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
