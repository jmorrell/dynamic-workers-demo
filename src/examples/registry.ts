import type { Permissions } from '../runtime/types';

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
	// Capability grant this example runs with. Absent → the default no-network
	// grant. A page-links grant unlocks env.fetch against the fetched page's links.
	readonly permissions?: Permissions;
	// Non-JS modules the loader must inject alongside the bundled code (e.g. a
	// wasm binary the entry imports via a relative specifier). `file` is a
	// repo-relative path to the committed binary, read + base64-encoded at build
	// time (scripts/build-examples.mjs) into the manifest entry.
	readonly modules?: ReadonlyArray<{ readonly name: string; readonly kind: 'wasm'; readonly file: string }>;
};

// Modules injected into the loader for edited (custom) example code, since
// its imports ('linkedom', 'defuddle/node', './markdown-dom-polyfill') only
// resolve at bundle time for pristine examples (baked into manifest.code).
// Single source of truth for scripts/build-examples.mjs (bundles each entry
// into deps.generated.ts) and src/index.ts (selects by specifier at runtime).
export const SHARED_DEP_SPECIFIERS: ReadonlyArray<{ readonly specifier: string; readonly entry: string }> = [
	{ specifier: 'linkedom', entry: 'linkedom' },
	{ specifier: 'defuddle/node', entry: 'defuddle/node' },
	{ specifier: 'markdown-dom-polyfill', entry: 'src/examples/markdown-dom-polyfill.ts' },
];

export const EXAMPLE_REGISTRY: ReadonlyArray<ExampleMeta> = [
	{
		id: 'markdown',
		title: 'Readable Markdown',
		description: 'Extracts clean, readable markdown content from any article or webpage using Defuddle.',
		suggestedUrls: ['https://www.theverge.com/column/960600/xbox-is-a-disaster', 'https://en.wikipedia.org/wiki/Cloudflare'],
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
	{
		id: 'wasm-add',
		title: 'WebAssembly (out of the box)',
		description: 'The sandbox loads WebAssembly modules natively — no runtime compilation needed.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/wasm-add.ts',
		compatDate: '2026-06-22',
		modules: [{ name: 'add.wasm', kind: 'wasm', file: 'src/examples/add.wasm' }],
	},
];
