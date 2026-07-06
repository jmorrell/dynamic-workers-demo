export type ExampleMeta = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly entry: string; // path to the .ts module, relative to repo root
	// Compat date this example was authored/verified against. Pinned per example
	// (rather than following the loader's global default) so bumping the default
	// doesn't silently change an already-verified example's runtime behavior.
	readonly compatDate: string;
};

export const EXAMPLE_REGISTRY: ReadonlyArray<ExampleMeta> = [
	{
		id: 'markdown',
		title: 'Readable Markdown',
		description: 'Extracts clean, readable markdown content from any article or webpage using Defuddle.',
		suggestedUrls: ['https://www.theverge.com/2024/1/1/24184299/ai-news-2024', 'https://www.cnbc.com/2024/01/01/tech-news-2024/'],
		entry: 'src/examples/markdown.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'opengraph',
		title: 'OpenGraph Tags',
		description: 'Extracts OpenGraph and Twitter Card metadata tags from a webpage.',
		suggestedUrls: ['https://www.wikipedia.org', 'https://github.com', 'https://news.ycombinator.com'],
		entry: 'src/examples/opengraph.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'reddit',
		title: 'Reddit Top Comments',
		description: 'Extracts the top-scoring comments from a Reddit thread.',
		suggestedUrls: ['https://www.reddit.com/r/programming/comments/1a1b2c/example.json', 'https://www.reddit.com/r/javascript/hot/.json'],
		entry: 'src/examples/reddit.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'hackernews',
		title: 'Hacker News Top Comments',
		description: 'Extracts the top-scoring comments from a Hacker News thread using the Algolia API.',
		suggestedUrls: ['https://hn.algolia.com/api/v1/items/37570037', 'https://hn.algolia.com/api/v1/items/39595652'],
		entry: 'src/examples/hackernews.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'cpu-spin',
		title: 'CPU Spin (killed by platform)',
		description: 'Intentional CPU-intensive workload that demonstrates platform CPU limit enforcement.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/cpu-spin.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'blocked-fetch',
		title: 'Blocked fetch()',
		description: 'Demonstrates network call blocking in the Dynamic Worker isolate.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/blocked-fetch.ts',
		compatDate: '2026-06-22',
	},
];
