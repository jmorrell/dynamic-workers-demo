export type ExampleMeta = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly entry: string; // path to the .ts module, relative to repo root
};

export const EXAMPLE_REGISTRY: ReadonlyArray<ExampleMeta> = [
	{
		id: 'markdown',
		title: 'Readable Markdown',
		description: 'Extracts clean, readable markdown content from any article or webpage using Defuddle.',
		suggestedUrls: ['https://www.theverge.com/2024/1/1/24184299/ai-news-2024', 'https://www.cnbc.com/2024/01/01/tech-news-2024/'],
		entry: 'src/examples/markdown.ts',
	},
	{
		id: 'opengraph',
		title: 'OpenGraph Tags',
		description: 'Extracts OpenGraph and Twitter Card metadata tags from a webpage.',
		suggestedUrls: ['https://www.wikipedia.org', 'https://github.com', 'https://news.ycombinator.com'],
		entry: 'src/examples/opengraph.ts',
	},
	{
		id: 'reddit',
		title: 'Reddit Top Comments',
		description: 'Extracts the top-scoring comments from a Reddit thread.',
		suggestedUrls: ['https://www.reddit.com/r/programming/comments/1a1b2c/example.json', 'https://www.reddit.com/r/javascript/hot/.json'],
		entry: 'src/examples/reddit.ts',
	},
	{
		id: 'hackernews',
		title: 'Hacker News Top Comments',
		description: 'Extracts the top-scoring comments from a Hacker News thread using the Algolia API.',
		suggestedUrls: ['https://hn.algolia.com/api/v1/items/37570037', 'https://hn.algolia.com/api/v1/items/39595652'],
		entry: 'src/examples/hackernews.ts',
	},
	{
		id: 'cpu-spin',
		title: 'CPU Spin (killed by platform)',
		description: 'Intentional CPU-intensive workload that demonstrates platform CPU limit enforcement.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/cpu-spin.ts',
	},
	{
		id: 'blocked-fetch',
		title: 'Blocked fetch()',
		description: 'Demonstrates network call blocking in the Dynamic Worker isolate.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/blocked-fetch.ts',
	},
];
