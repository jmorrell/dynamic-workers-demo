// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

import type { RunInput } from '../runtime/types';

export default function transform(input: RunInput): unknown {
	const result: Record<string, string> = {};

	try {
		// Match og: and twitter: meta tags. Handles both property="" and name=""
		// attributes. Known tolerance: this expects `content` to follow
		// property/name directly — tags with intervening attributes or reversed
		// order are skipped. That only narrows coverage; the function stays total
		// (returns whatever it matched, never throws).
		const ogRegex = /<meta\s+(?:property|name)=["']([a-z:]+)["']\s+content=["']([^"']*)["']/gi;
		let match;

		while ((match = ogRegex.exec(input.body)) !== null) {
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
