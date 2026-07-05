// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';

export default function transform(input: RunInput): unknown {
	const limit = 10;

	try {
		const data = JSON.parse(input.body);

		// Reddit API returns [postListing, commentsListing]
		if (!Array.isArray(data) || data.length < 2) {
			return [];
		}

		const commentsListing = data[1];
		if (typeof commentsListing !== 'object' || commentsListing === null) {
			return [];
		}

		const commentsData = commentsListing.data;
		if (typeof commentsData !== 'object' || commentsData === null) {
			return [];
		}

		const children = commentsData.children;
		if (!Array.isArray(children)) {
			return [];
		}

		const comments: Array<{ author: string; score: number; body: string }> = [];

		for (const child of children) {
			if (typeof child !== 'object' || child === null) {
				continue;
			}

			const childData = child.data;
			if (typeof childData !== 'object' || childData === null) {
				continue;
			}

			const author = childData.author;
			const score = childData.score;
			const body = childData.body;

			// Keep only entries with all required fields
			if (typeof author === 'string' && typeof score === 'number' && typeof body === 'string' && body.length > 0) {
				comments.push({ author, score, body });
			}
		}

		// Sort by score descending, then take limit
		comments.sort((a, b) => b.score - a.score);
		return comments.slice(0, limit);
	} catch {
		// On any parse error, return empty array (total function)
		return [];
	}
}
