// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput, TransformEnv } from '../runtime/types';

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'redd.it']);

export default function transform(env: TransformEnv, input: RunInput): unknown {
	const limit = 10;

	const rawUrl = input.finalUrl || input.url;
	let hostname = '';
	try {
		hostname = new URL(rawUrl).hostname;
	} catch {
		// Leave hostname empty; falls through to the host check below.
	}

	if (!REDDIT_HOSTS.has(hostname)) {
		throw new Error(`This example only works with Reddit URLs (got ${hostname || rawUrl})`);
	}

	let data: unknown;
	try {
		data = JSON.parse(input.body);
	} catch {
		const corrected = new URL(rawUrl);
		if (corrected.pathname.endsWith('.json')) {
			throw new Error(`Reddit did not return JSON (HTTP ${input.status}) — it may be blocking this request. Try again later.`);
		}
		corrected.pathname = corrected.pathname.replace(/\/$/, '') + '.json';
		throw new Error(
			`This URL returned HTML, not Reddit's JSON API. Append .json to the thread URL, e.g. ${corrected.toString()}`,
		);
	}

	// Reddit API returns [postListing, commentsListing]
	if (!Array.isArray(data) || data.length < 2) {
		throw new Error('Expected a Reddit thread .json URL (got a different Reddit API shape)');
	}

	const commentsListing = data[1];
	if (typeof commentsListing !== 'object' || commentsListing === null) {
		throw new Error('Expected a Reddit thread .json URL (got a different Reddit API shape)');
	}

	const commentsData = (commentsListing as Record<string, unknown>).data;
	if (typeof commentsData !== 'object' || commentsData === null) {
		throw new Error('Expected a Reddit thread .json URL (got a different Reddit API shape)');
	}

	const children = (commentsData as Record<string, unknown>).children;
	if (!Array.isArray(children)) {
		throw new Error('Expected a Reddit thread .json URL (got a different Reddit API shape)');
	}

	const comments: Array<{ author: string; score: number; body: string }> = [];

	for (const child of children) {
		if (typeof child !== 'object' || child === null) {
			continue;
		}

		const childData = (child as Record<string, unknown>).data;
		if (typeof childData !== 'object' || childData === null) {
			continue;
		}

		const author = (childData as Record<string, unknown>).author;
		const score = (childData as Record<string, unknown>).score;
		const body = (childData as Record<string, unknown>).body;

		// Keep only entries with all required fields
		if (typeof author === 'string' && typeof score === 'number' && typeof body === 'string' && body.length > 0) {
			comments.push({ author, score, body });
		}
	}

	// Sort by score descending, then take limit
	comments.sort((a, b) => b.score - a.score);
	return comments.slice(0, limit);
}
