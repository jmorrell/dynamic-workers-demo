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
	// grant. A page-links grant unlocks target-bound resource capabilities for
	// URLs discovered in the fetched page.
	readonly permissions?: Permissions;
	// Non-JS modules the loader must inject alongside the bundled code (e.g. a
	// wasm binary the entry imports via a relative specifier). `file` is a
	// repo-relative path to the binary; scripts/build-examples.mjs copies it to
	// public/modules/<id>/<name> (a static asset, generated-but-committed) and
	// records the URL path as `assetPath` in the manifest entry. May be a
	// committed binary under src/examples/, or a package-shipped one under
	// node_modules/ (version pinned by the lockfile, e.g. @cf-wasm/photon's wasm
	// binary).
	readonly modules?: ReadonlyArray<
		| { readonly name: string; readonly label?: string; readonly kind: 'js'; readonly file: string }
		| { readonly name: string; readonly label?: string; readonly kind: 'wasm'; readonly file: string }
	>;
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
	{ specifier: '@cf-wasm/photon/others', entry: '@cf-wasm/photon/others' },
	{ specifier: '@llamaindex/liteparse-wasm', entry: '@llamaindex/liteparse-wasm' },
];

export const EXAMPLE_REGISTRY: ReadonlyArray<ExampleMeta> = [
	{
		id: 'markdown',
		title: 'Readable Markdown',
		description: 'Extracts clean, readable markdown content from any article or webpage using Defuddle.',
		suggestedUrls: ['https://www.theverge.com/column/960600/xbox-is-a-disaster', 'https://en.wikipedia.org/wiki/Cloudflare'],
		entry: 'src/examples/markdown.ts',
		compatDate: '2026-06-22',
		modules: [
			{
				name: 'markdown-dom-polyfill',
				label: 'markdown-dom-polyfill.ts',
				kind: 'js',
				file: 'src/examples/markdown-dom-polyfill.ts',
			},
		],
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
		id: 'rss-digest',
		title: 'RSS Feed Digest',
		description:
			"Parses an RSS or Atom feed's items and follows each article's own link (embedded in the feed payload) to summarize it as readable markdown.",
		suggestedUrls: ['https://blog.cloudflare.com/rss/', 'https://hnrss.org/frontpage'],
		entry: 'src/examples/rss-digest.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links', maxFetches: 6, cpuMs: 5000 },
		modules: [
			{
				name: 'markdown-dom-polyfill',
				label: 'markdown-dom-polyfill.ts',
				kind: 'js',
				file: 'src/examples/markdown-dom-polyfill.ts',
			},
		],
	},
	{
		id: 'cpu-spin',
		title: 'CPU Spin',
		description: 'Intentional CPU-intensive workload that demonstrates platform CPU limit enforcement.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/cpu-spin.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'blocked-fetch',
		title: 'Blocked Fetch',
		description: 'Demonstrates network call blocking in the Dynamic Worker isolate.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/blocked-fetch.ts',
		compatDate: '2026-06-22',
	},
	{
		id: 'wasm-add',
		title: 'WebAssembly',
		description: 'The sandbox loads WebAssembly modules natively — no runtime compilation needed.',
		suggestedUrls: ['https://example.com'],
		entry: 'src/examples/wasm-add.ts',
		compatDate: '2026-06-22',
		modules: [{ name: 'add.wasm', kind: 'wasm', file: 'src/examples/add.wasm' }],
	},
	{
		id: 'image-hash',
		title: 'Image Perceptual Hash',
		description: 'Decodes images referenced by the page with the photon wasm library and computes a 64-bit perceptual difference-hash for each.',
		suggestedUrls: ['https://en.wikipedia.org/wiki/Cloudflare', 'https://commons.wikimedia.org/wiki/Main_Page'],
		entry: 'src/examples/image-hash.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links', cpuMs: 2000 },
		modules: [{ name: 'photon.wasm', kind: 'wasm', file: 'node_modules/@cf-wasm/photon/dist/lib/photon_rs_bg.wasm' }],
	},
	{
		id: 'github-repo',
		title: 'GitHub Repo Stats',
		description:
			'Parses a GitHub API repo response and follows the contributors_url and languages_url links embedded in the payload itself to build a stats summary.',
		suggestedUrls: ['https://api.github.com/repos/cloudflare/workerd', 'https://api.github.com/repos/anthropics/claude-code'],
		entry: 'src/examples/github-repo.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links' },
	},
	{
		id: 'arxiv-pdf',
		title: 'arXiv PDF → Markdown',
		description:
			"Follows an arXiv abstract page's PDF capability, reads the paper's bytes, and parses it to markdown with the liteparse wasm library.",
		suggestedUrls: ['https://arxiv.org/abs/1706.03762', 'https://arxiv.org/abs/2005.14165'],
		entry: 'src/examples/arxiv-pdf.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links', cpuMs: 5000 },
		modules: [
			{ name: 'liteparse.wasm', kind: 'wasm', file: 'node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm' },
		],
	},
	{
		id: 'url-history',
		title: 'Submitted URL History',
		description:
			'Appends each submitted URL to a SQLite table and returns the complete history. The demo database is capped at 128 KiB and forgotten after about an hour.',
		suggestedUrls: ['https://example.com', 'https://www.wikipedia.org', 'https://news.ycombinator.com'],
		entry: 'src/examples/url-history.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'none', storage: 'scoped' },
	},
	{
		id: 'arxiv-digest',
		title: 'arXiv Citations Digest',
		description:
			'Finds arXiv paper links on any citing page — a listing, a Wikipedia article, a blog post — then follows each to its abstract page and its PDF to build a digest with liteparse.',
		suggestedUrls: ['https://arxiv.org/list/cs.LG/recent', 'https://en.wikipedia.org/wiki/Attention_Is_All_You_Need'],
		entry: 'src/examples/arxiv-digest.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links', fetchDepth: 2, maxFetches: 6, cpuMs: 5000 },
		modules: [
			{ name: 'liteparse.wasm', kind: 'wasm', file: 'node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm' },
		],
	},
	{
		id: 'write-your-own',
		title: 'Write Your Own',
		description:
			'A starting point with linked-resource capabilities, SQLite storage, logs, and traces. Use the LLM prompt tab to generate a transform, then paste it into transform.ts.',
		suggestedUrls: ['https://jeremymorrell.dev/', 'https://blog.cloudflare.com/', 'https://en.wikipedia.org/wiki/Cloudflare'],
		entry: 'src/examples/write-your-own.ts',
		compatDate: '2026-06-22',
		permissions: { fetch: 'page-links', fetchDepth: 2, maxFetches: 6, cpuMs: 5000, storage: 'scoped' },
	},
];
