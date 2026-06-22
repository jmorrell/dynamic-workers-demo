// pattern: Functional Core

/**
 * Extract OpenGraph and Twitter meta tags from HTML.
 * Returns empty object if no tags found.
 * Never throws - always returns a Record<string, string>.
 */
export function parseOpenGraph(html: string): Record<string, string> {
	const result: Record<string, string> = {};

	try {
		// Match og: and twitter: meta tags. Handles both property="" and name=""
		// attributes. Known tolerance: this expects `content` to follow
		// property/name directly — tags with intervening attributes or reversed
		// order are skipped. That only narrows coverage; the function stays total
		// (returns whatever it matched, never throws — AC2.5).
		const ogRegex = /<meta\s+(?:property|name)=["']([a-z:]+)["']\s+content=["']([^"']*)["']/gi;
		let match;

		while ((match = ogRegex.exec(html)) !== null) {
			const key = match[1];
			const value = match[2];
			if ((key.startsWith('og:') || key.startsWith('twitter:')) && value) {
				result[key] = value;
			}
		}
	} catch {
		// On any parse error, return empty object (total function)
		return {};
	}

	return result;
}

/**
 * Extract top comments from Reddit JSON format.
 * Input: JSON text from reddit.com/r/<sub>/comments/<id>.json
 * Returns array sorted by score descending, limited to limit parameter.
 * Never throws - always returns an array.
 */
export function parseRedditTopComments(jsonText: string, limit = 10): Array<{ author: string; score: number; body: string }> {
	try {
		const data = JSON.parse(jsonText);

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

/**
 * Extract top comments from Hacker News Algolia API JSON format.
 * Input: JSON text from hn.algolia.com/api/v1/items/<id>
 * Returns array sorted by points descending (nulls last), limited to limit parameter.
 * Never throws - always returns an array.
 */
export function parseHnTopComments(jsonText: string, limit = 10): Array<{ author: string; points: number | null; text: string }> {
	try {
		const data = JSON.parse(jsonText);

		if (typeof data !== 'object' || data === null) {
			return [];
		}

		const comments: Array<{ author: string; points: number | null; text: string }> = [];

		// Recursively flatten children array
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
