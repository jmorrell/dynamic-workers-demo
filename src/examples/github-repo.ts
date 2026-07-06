// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// Point this at a GitHub API repo endpoint, e.g. https://api.github.com/repos/cloudflare/workerd.
// Demonstrates env.fetch following URLs embedded in the fetched JSON payload itself
// (contributors_url, languages_url) rather than spidering arbitrary links.
//
// Known gap: GitHub's URI-template fields (e.g. releases_url: ".../releases{/id}")
// are NOT fetchable here. The host allowlist is built by regex-extracting absolute
// URLs from the payload and normalizing each via `new URL().toString()` — an
// EXACT match is required. The extractor's URL regex stops at `}` but includes the
// leading `{`, so a templated field ends up allowlisted as `.../releases%7B/id`,
// not the trimmed `.../releases` a transform would actually want to call. This
// example therefore only follows untemplated URL fields.
//
// Also intentionally omitted: total commit count. The unauthenticated GitHub API
// has no cheap endpoint for it — you'd need to fetch /commits and parse the last
// page number out of the Link response header, which needs header access this
// sandbox's fetch capability doesn't expose (and would be brittle besides).

import type { RunInput, TransformEnv } from '../runtime/types';

type JsonRecord = Record<string, unknown>;

function githubErrorMessage(body: string): string | null {
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === 'object' && typeof (parsed as JsonRecord).message === 'string') {
			return (parsed as JsonRecord).message as string;
		}
	} catch {
		// Not JSON; fall through.
	}
	return null;
}

function friendlyFetchError(status: number, body: string): string {
	const githubMessage = githubErrorMessage(body);
	if (status === 403 || status === 429) {
		return githubMessage ?? 'GitHub API rate limit exceeded. Try again later, or use an authenticated request.';
	}
	return githubMessage ?? `GitHub API returned HTTP ${status}`;
}

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	if (input.status < 200 || input.status >= 300) {
		throw new Error(`Fetching the URL failed with HTTP ${input.status}`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(input.body);
	} catch {
		throw new Error('Expected a JSON response from the GitHub API');
	}

	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Expected a JSON object from the GitHub API');
	}

	const repo = payload as JsonRecord;

	if (typeof repo.full_name !== 'string') {
		const githubMessage = typeof repo.message === 'string' ? repo.message : null;
		throw new Error(
			githubMessage
				? `GitHub API error: ${githubMessage}`
				: 'Point this example at a GitHub API repo endpoint, e.g. https://api.github.com/repos/{owner}/{repo}',
		);
	}

	const license = repo.license as JsonRecord | null | undefined;

	const summary = {
		fullName: repo.full_name as string,
		description: typeof repo.description === 'string' ? repo.description : null,
		stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
		forks: typeof repo.forks_count === 'number' ? repo.forks_count : null,
		openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : null,
		license: license && typeof license.spdx_id === 'string' ? license.spdx_id : null,
		topics: Array.isArray(repo.topics) ? (repo.topics as unknown[]).filter((t) => typeof t === 'string') : [],
		createdAt: typeof repo.created_at === 'string' ? repo.created_at : null,
		pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
	};

	// Top contributors, by commit count on the default branch.
	async function fetchContributors(): Promise<unknown> {
		if (!env.fetch) return { error: 'env.fetch is unavailable' };
		if (typeof repo.contributors_url !== 'string') return { error: 'No contributors_url on this payload' };

		const result = await env.fetch(repo.contributors_url);
		if (result.status < 200 || result.status >= 300) {
			return { error: friendlyFetchError(result.status, result.body) };
		}

		let contributors: unknown;
		try {
			contributors = JSON.parse(result.body);
		} catch {
			return { error: 'contributors_url did not return valid JSON' };
		}
		if (!Array.isArray(contributors)) {
			return { error: 'Expected an array from contributors_url' };
		}

		return contributors
			.filter((c): c is JsonRecord => typeof c === 'object' && c !== null)
			.map((c) => ({
				login: typeof c.login === 'string' ? c.login : 'unknown',
				contributions: typeof c.contributions === 'number' ? c.contributions : 0,
			}))
			.sort((a, b) => b.contributions - a.contributions)
			.slice(0, 5);
	}

	// Language breakdown, converted from raw byte counts to percentages.
	async function fetchLanguages(): Promise<unknown> {
		if (!env.fetch) return { error: 'env.fetch is unavailable' };
		if (typeof repo.languages_url !== 'string') return { error: 'No languages_url on this payload' };

		const result = await env.fetch(repo.languages_url);
		if (result.status < 200 || result.status >= 300) {
			return { error: friendlyFetchError(result.status, result.body) };
		}

		let languages: unknown;
		try {
			languages = JSON.parse(result.body);
		} catch {
			return { error: 'languages_url did not return valid JSON' };
		}
		if (typeof languages !== 'object' || languages === null) {
			return { error: 'Expected an object from languages_url' };
		}

		const entries = Object.entries(languages as JsonRecord).filter(
			(entry): entry is [string, number] => typeof entry[1] === 'number',
		);
		const totalBytes = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
		if (totalBytes === 0) return {};

		const percentages: Record<string, number> = {};
		for (const [lang, bytes] of entries.sort((a, b) => b[1] - a[1])) {
			percentages[lang] = Math.round((bytes / totalBytes) * 1000) / 10;
		}
		return percentages;
	}

	const [topContributors, languages] = await Promise.all([fetchContributors(), fetchLanguages()]);

	return { repo: summary, topContributors, languages };
}
