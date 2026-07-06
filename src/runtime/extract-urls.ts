import { parseHTML } from 'linkedom';

/** Cap on how many distinct linked URLs a page can contribute to the allowlist. */
const MAX_URLS = 2000;

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Extracts the URLs referenced by a fetched page, forming the exact allowlist the
 * CapabilityGate enforces `env.fetch`/`env.fetchFile` against. Pure: no I/O.
 *
 * HTML is parsed (linkedom, host-side) and URL-bearing attributes are collected;
 * JSON/other text is scanned for absolute http(s) URLs (including JSON-escaped
 * `https:\/\/...` forms). All results are resolved against `baseUrl`, restricted
 * to http/https, normalized via `URL.toString()`, deduped, and capped.
 */
export function extractLinkedUrls(body: string, contentType: string, baseUrl: string): ReadonlyArray<string> {
	const type = contentType.split(';')[0].trim().toLowerCase();
	const raw = HTML_CONTENT_TYPES.includes(type) ? extractFromHtml(body) : extractFromText(body);

	const seen = new Set<string>();
	for (const candidate of raw) {
		const normalized = normalize(candidate, baseUrl);
		if (normalized) {
			seen.add(normalized);
			if (seen.size >= MAX_URLS) break;
		}
	}
	return [...seen];
}

function normalize(rawUrl: string, baseUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl, baseUrl);
	} catch {
		// An empty/invalid base throws even for absolute candidates; retry base-less
		// so absolute URLs still resolve when the base is missing.
		try {
			url = new URL(rawUrl);
		} catch {
			return null;
		}
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	return url.toString();
}

function extractFromHtml(body: string): string[] {
	const out: string[] = [];
	// linkedom's Document type (no DOM lib in this tsconfig); inferred, not annotated.
	let document: ReturnType<typeof parseHTML>['document'];
	try {
		({ document } = parseHTML(body));
	} catch {
		return out;
	}

	const single = (selector: string, attr: string) => {
		for (const el of document.querySelectorAll(selector)) {
			const value = el.getAttribute(attr);
			if (value) out.push(value.trim());
		}
	};
	const srcset = (selector: string) => {
		for (const el of document.querySelectorAll(selector)) {
			const value = el.getAttribute('srcset');
			if (value) out.push(...parseSrcset(value));
		}
	};

	single('a[href]', 'href');
	single('link[href]', 'href');
	single('img[src]', 'src');
	srcset('img[srcset]');
	single('source[src]', 'src');
	srcset('source[srcset]');
	single('script[src]', 'src');
	single('iframe[src]', 'src');
	single('video[src]', 'src');
	single('video[poster]', 'poster');
	single('audio[src]', 'src');

	// meta[content] only when the content itself parses as an absolute URL.
	for (const el of document.querySelectorAll('meta[content]')) {
		const value = el.getAttribute('content');
		if (!value) continue;
		try {
			const parsed = new URL(value.trim());
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') out.push(value.trim());
		} catch {
			// Not an absolute URL; skip.
		}
	}

	return out;
}

/** Each srcset candidate is `url [descriptor]`, comma-separated; keep the URLs. */
function parseSrcset(srcset: string): string[] {
	return srcset
		.split(',')
		.map((candidate) => candidate.trim().split(/\s+/)[0])
		.filter((url) => url.length > 0);
}

// Absolute http(s) URLs, including JSON-escaped slashes (https:\/\/...). We
// unescape `\/` → `/` first so a single regex matches both plain and escaped
// forms. The character class stops at quotes/whitespace/backslashes and a few
// structural JSON/HTML delimiters.
const URL_REGEX = /https?:\/\/[^\s"'\\<>)}\]]+/gi;

function extractFromText(body: string): string[] {
	const unescaped = body.replace(/\\\//g, '/');
	const matches = unescaped.match(URL_REGEX);
	if (!matches) return [];
	// Trim trailing punctuation that commonly abuts a URL in prose/JSON.
	return matches.map((m) => m.replace(/[.,;:]+$/, ''));
}
