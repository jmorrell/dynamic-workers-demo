// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';

export default function transform(input: RunInput): unknown {
	const limit = 10;

	try {
		const data = JSON.parse(input.body);

		if (typeof data !== 'object' || data === null) {
			return [];
		}

		const comments: Array<{ author: string; points: number | null; text: string }> = [];

		// Recursively flatten the nested children array into a flat comment list
		function flatten(item: unknown): void {
			if (typeof item !== 'object' || item === null) {
				return;
			}

			const obj = item as Record<string, unknown>;

			// If this item has text, include it
			if (typeof obj.text === 'string' && obj.text.length > 0) {
				const author = obj.author;
				const points = obj.points;

				if (typeof author === 'string' && author.length > 0) {
					comments.push({
						author,
						points: typeof points === 'number' || points === null ? points : null,
						text: obj.text,
					});
				}
			}

			// Process children recursively
			if (Array.isArray(obj.children)) {
				for (const child of obj.children) {
					flatten(child);
				}
			}
		}

		// Start flattening from root children
		if (Array.isArray(data.children)) {
			for (const child of data.children) {
				flatten(child);
			}
		}

		// Sort by points descending (nulls last)
		comments.sort((a, b) => {
			if (a.points === null && b.points === null) return 0;
			if (a.points === null) return 1; // b before a
			if (b.points === null) return -1; // a before b
			return b.points - a.points;
		});

		return comments.slice(0, limit);
	} catch {
		// On any parse error, return empty array (total function)
		return [];
	}
}
