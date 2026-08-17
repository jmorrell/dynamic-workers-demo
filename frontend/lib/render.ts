// pattern: Functional Core

export type Permissions = {
	readonly fetch: 'page-links' | 'none';
	readonly cpuMs?: number;
	readonly fetchDepth?: number;
	readonly maxFetches?: number;
	readonly storage?: 'scoped' | 'none';
};

// `assetPath` is a URL path served (asset-first) by the same origin, e.g.
// '/modules/image-hash/photon.wasm' — module bytes are fetched lazily per
// example from there, see ensureModules in main.ts.
export type ExampleModule =
	| { readonly name: string; readonly label?: string; readonly kind: 'js'; readonly source: string }
	| {
			readonly name: string;
			readonly label?: string;
			readonly kind: 'wasm';
			readonly assetPath: string;
			readonly previewBase64: string;
			readonly byteSize: number;
	  };

export type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
	readonly permissions?: Permissions;
	readonly modules?: ReadonlyArray<ExampleModule>;
};

// Playground order is intentionally showcase-first rather than tutorial-first:
// lead with the examples that best demonstrate the finished system, then keep
// every remaining/future registry entry in its original order.
const PLAYGROUND_EXAMPLE_ORDER = [
	'arxiv-pdf',
	'arxiv-digest',
	'image-hash',
	'rss-digest',
	'markdown',
	'github-repo',
	'url-history',
	'opengraph',
	'hackernews',
	'wasm-add',
	'blocked-fetch',
	'cpu-spin',
	'write-your-own',
] as const;

export function orderExamplesForPlayground(examples: ReadonlyArray<Example>): Array<Example> {
	const rank = new Map<string, number>(PLAYGROUND_EXAMPLE_ORDER.map((id, index) => [id, index]));
	return examples
		.map((example, index) => ({ example, index }))
		.sort((a, b) => (rank.get(a.example.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.example.id) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
		.map(({ example }) => example);
}

// A single editor tab: the entrypoint/support source tabs use kind 'script';
// wasm tabs use kind 'wasm' and contain preview or full base64 text.
export type EditorTab = { readonly id: string; readonly label: string; readonly kind: 'script' | 'wasm'; readonly content: string };

// Builds the pristine tab set for a selected example: the script tab first
// (label 'transform.ts'), then one tab per declared module. No example (or no
// modules) yields just the script tab. Module content comes from
// `moduleContents` (keyed by module name) when supplied — the base64 is
// fetched lazily (see ensureModules in widget.ts) — or the 1.5 KiB preview.
export function exampleTabs(example: Example | undefined, moduleContents?: ReadonlyMap<string, string>): Array<EditorTab> {
	const scriptTab: EditorTab = { id: 'script', label: 'transform.ts', kind: 'script', content: example?.source ?? '' };
	const moduleTabs: Array<EditorTab> = (example?.modules ?? []).map((m) => ({
		id: m.name,
		label: m.label ?? m.name,
		kind: m.kind === 'wasm' ? 'wasm' : 'script',
		content: m.kind === 'js' ? m.source : (moduleContents?.get(m.name) ?? m.previewBase64),
	}));
	return [scriptTab, ...moduleTabs];
}

// The run is dirty (must go through the custom-code path) if there's no
// selected example, or if ANY tab's current text differs from its pristine
// content — not just the script tab.
export function isTabSetDirty(pristineTabs: ReadonlyArray<EditorTab>, currentContents: ReadonlyMap<string, string>): boolean {
	if (pristineTabs.length === 0) return true;
	return pristineTabs.some((tab) => currentContents.get(tab.id) !== tab.content);
}

// Base64-encodes raw bytes for wasm tab content / a custom-run payload
// (module bytes are fetched from a static asset — see ensureModules in
// main.ts — and encoded here rather than shipped as base64 from the server).
// String.fromCharCode.apply has an argument-count limit well under a
// multi-MB buffer's length, so this chunks the conversion (0x8000 bytes at a
// time) before handing the whole binary string to btoa.
export function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

// Auxiliary/result panes in strip order. The prompt can appear before a run;
// run results appear afterward, and 'trace' only when the run carried spans.
export type ResultTabId = 'prompt' | 'output' | 'logs' | 'trace';

export const LLM_PROMPT = `You are writing a TypeScript module that will run as untrusted code inside a sandboxed Cloudflare Dynamic Worker.

First, check whether I have described what I want the transform to do in my message. If I have not, ask me what I want to build and wait for my answer. Do not write any code until I have supplied that direction.

Once I have described the transform, return only the complete contents of transform.ts, without Markdown fences or explanation.

The module must default-export:
import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> | unknown

Types:
type RunInput = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  responseHeaders: Map<string, string>;
  body: string;
  truncated: boolean;
};

type TransformEnv = {
  resources?: ReadonlyMap<string, ResourceCapability>;
  DB?: Database;
};

type ResourceCapability = {
  url: string;
  source: { kind: "html"; element: string; attribute: string } | { kind: "text" };
  read(): Promise<ResourceResult>;
};

type ResourceResult =
  | {
      kind: "text";
      status: number;
      contentType: string;
      body: string;
      truncated: boolean;
      resources: ReadonlyMap<string, ResourceCapability>;
    }
  | {
      kind: "bytes";
      status: number;
      contentType: string;
      bytes: Uint8Array;
      truncated: boolean;
    };

type Database = {
  readonly databaseSize: number;
  exec<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): {
    columnNames: string[];
    rowsRead: number;
    rowsWritten: number;
    toArray(): Row[];
  };
};

Runtime constraints:
- There is no ambient fetch. Never call global fetch().
- A URL can only be read if env.resources contains its ResourceCapability. Call capability.read() with no arguments.
- Text reads may return child capabilities in result.resources. This run permits at most 2 link levels and 6 reads.
- env.DB is a private SQLite database for this script, capped at 128 KiB.
- The transform has at most 5000ms of CPU time.
- No npm packages are available. Apart from the type-only import shown above, use built-in JavaScript and TypeScript APIs.
- console.log(), console.warn(), and console.error() are captured.
- input.body is the already-fetched target document. Use input.finalUrl as its base URL.
- Return JSON-serializable data, or { markdown: string, json?: unknown } to render Markdown.
- Check missing capabilities, HTTP status, result.kind, content type, and truncation where relevant.`;

// One entry in the single unified tab strip: the source-file tabs (the script
// tab + any wasm module tabs) followed by the result tabs a run produced. `id`
// is an EditorTab id for a source item, a ResultTabId for a result item; `kind`
// tells the click handler which selector to call.
export type TabStripItem = {
	readonly id: string;
	readonly label: string;
	readonly kind: 'source' | 'result';
	readonly active: boolean;
};

// Builds the unified strip: every source tab first (in the given order), an
// optional pre-run LLM prompt, then — once a run exists — Output and Logs, and
// Trace only when that run carried spans. Exactly one item is active: the active result tab when one is showing
// (`activeResultTab` non-null), otherwise the active source tab. So a result
// tab being active necessarily leaves every source item inactive, and vice versa.
export function tabStripItems(
	sourceTabs: ReadonlyArray<EditorTab>,
	activeSourceTabId: string,
	activeResultTab: ResultTabId | null,
	options: { readonly hasRun: boolean; readonly hasTrace: boolean; readonly hasPrompt?: boolean },
): Array<TabStripItem> {
	const items: Array<TabStripItem> = sourceTabs.map((tab) => ({
		id: tab.id,
		label: tab.label,
		kind: 'source' as const,
		active: activeResultTab === null && tab.id === activeSourceTabId,
	}));

	if (options.hasPrompt) {
		items.push({ id: 'prompt', label: 'LLM prompt', kind: 'result', active: activeResultTab === 'prompt' });
	}

	if (options.hasRun) {
		const resultTabs: Array<{ id: ResultTabId; label: string }> = [
			{ id: 'output', label: 'Output' },
			{ id: 'logs', label: 'Logs' },
		];
		if (options.hasTrace) resultTabs.push({ id: 'trace', label: 'Trace' });

		for (const rt of resultTabs) {
			items.push({ id: rt.id, label: rt.label, kind: 'result', active: activeResultTab === rt.id });
		}
	}

	return items;
}

export type CustomRunModule =
	| { readonly name: string; readonly kind: 'js'; readonly source: string }
	| { readonly name: string; readonly kind: 'wasm'; readonly base64: string };

// Builds the { customCode, modules? } payload shape for a dirty (or no-example)
// custom run from the current tab contents. Wasm tab text has its whitespace
// stripped (the editor may show it wrapped/indented) before being sent as
// base64. `modules` is omitted entirely when there are none, per the wire contract.
export function buildCustomRunPayload(
	tabs: ReadonlyArray<EditorTab>,
	currentContents: ReadonlyMap<string, string>,
): { customCode: string; modules?: Array<CustomRunModule> } {
	const scriptTab = tabs.find((t) => t.id === 'script');
	const customCode = (scriptTab && currentContents.get(scriptTab.id)) ?? '';

	const moduleTabs = tabs.filter((t) => t.id !== 'script');
	if (moduleTabs.length === 0) return { customCode };

	const modules: Array<CustomRunModule> = moduleTabs.map((t) =>
		t.kind === 'wasm'
			? { name: t.id, kind: 'wasm', base64: (currentContents.get(t.id) ?? '').replace(/\s+/g, '') }
			: { name: t.id, kind: 'js', source: currentContents.get(t.id) ?? '' },
	);

	return { customCode, modules };
}

// One badge in the permissions strip under the Code label: `label` is the
// visible chip text, `detail` the tooltip explaining what the grant means,
// `tone` picks the chip color (net = network grant, storage = storage grant,
// limit = a numeric cap on a grant, none = the fully sandboxed default).
export type PermissionBadge = {
	readonly label: string;
	readonly detail: string;
	readonly tone: 'net' | 'storage' | 'limit' | 'none';
};

// Structured badges for the static permissions strip under the Code label.
// The default grant (no permissions, or nothing beyond fetch/storage 'none')
// renders an explicit "no network access" badge rather than nothing — the
// sandbox being locked down is the demo's point, so say so. The depth/fetches/
// cpu segments are gated on a network grant (they cap resource reads, which
// don't exist without one); the storage badge is independent.
export function permissionBadges(permissions: Permissions | undefined): Array<PermissionBadge> {
	const badges: Array<PermissionBadge> = [];
	if (permissions?.fetch === 'page-links') {
		badges.push({
			label: 'network: page links',
			detail: 'Each URL referenced by the page gets a target-bound resource capability with a zero-argument read() method.',
			tone: 'net',
		});
		if (typeof permissions.fetchDepth === 'number' && permissions.fetchDepth > 1) {
			badges.push({
				label: `link depth ${permissions.fetchDepth}`,
				detail: `Text resources return capabilities discovered in that document, up to ${permissions.fetchDepth - 1} hop(s) beyond the original page.`,
				tone: 'limit',
			});
		}
		if (typeof permissions.maxFetches === 'number') {
			badges.push({
				label: `max ${permissions.maxFetches} reads`,
				detail: `At most ${permissions.maxFetches} resource capability reads per run.`,
				tone: 'limit',
			});
		}
		if (typeof permissions.cpuMs === 'number') {
			badges.push({
				label: `cpu ${permissions.cpuMs}ms`,
				detail: `The transform is killed after ${permissions.cpuMs}ms of CPU time.`,
				tone: 'limit',
			});
		}
	} else {
		badges.push({
			label: 'no network access',
			detail: 'The sandbox cannot make any network requests; it only sees the page snapshot the host fetched.',
			tone: 'none',
		});
	}
	if (permissions?.storage === 'scoped') {
		badges.push({
			label: 'storage: scoped',
			detail: 'env.DB — a private per-visitor, per-script SQLite database, capped at 128 KiB and deleted about an hour after the last run.',
			tone: 'storage',
		});
	}
	return badges;
}

// Whether the effective grant requires the widget to send a storeId with the
// run (and to offer the "clear stored data" affordance) — a storage: 'scoped'
// grant, regardless of the network grant alongside it.
export function needsStoreId(permissions: Permissions | undefined): boolean {
	return permissions?.storage === 'scoped';
}

// Frontend copy of the wire type from src/runtime/trace.ts — see that file for
// the authoritative shape/doc comments. attrs values (urls, error messages)
// are UNTRUSTED and must only ever reach the DOM via textContent/title.
export type TraceSpan = {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly startMs: number;
	readonly durMs: number;
	readonly status: 'ok' | 'error';
	readonly attrs: Readonly<Record<string, string | number | boolean>>;
};

export type Trace = {
	readonly traceId: string;
	readonly totalMs: number;
	readonly spans: ReadonlyArray<TraceSpan>;
};

type RunResponseOk = {
	readonly ok: true;
	readonly result: unknown;
	readonly logs: ReadonlyArray<{ readonly level: string; readonly message: string }>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
	readonly inputTruncated: boolean;
	readonly trace?: Trace;
	readonly resultHtml?: string;
};

type RunResponseError = {
	readonly ok: false;
	readonly error: { readonly kind: string; readonly message: string };
	readonly logs: ReadonlyArray<{ readonly level: string; readonly message: string }>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
	readonly inputTruncated: boolean;
	readonly trace?: Trace;
};

export type RunResponse = RunResponseOk | RunResponseError;

type FormatRunResponseResult = {
	readonly title: string;
	readonly body: string;
	readonly tone: 'ok' | 'error';
};

type ExampleOption = {
	readonly id: string;
	readonly title: string;
};

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatResultValue(value: unknown): string {
	try {
		const stringified = JSON.stringify(value, null, 2);
		return stringified === undefined ? 'undefined' : stringified;
	} catch {
		return String(value);
	}
}

// A transform can return both `{ markdown, json }`: markdown powers the
// rendered preview, while the JSON pane should show only the value the author
// deliberately exposed as `json` (not the potentially very large markdown
// source beside it). Direct-value results remain supported for examples and
// custom transforms that do not use the two-view wrapper.
export function outputJsonValue(result: unknown): unknown {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
	return Object.prototype.hasOwnProperty.call(result, 'json') ? (result as Record<string, unknown>).json : result;
}

// Returns the raw display strings. The DOM layer (main.ts) renders these via
// textContent, which is the security boundary that makes hostile HTML inert —
// so we must NOT HTML-escape here, or output would be visibly double-escaped
// (e.g. "&lt;script&gt;" instead of "<script>"). escapeHtml remains available
// for any code path that genuinely builds an HTML string.
export function formatRunResponse(resp: RunResponse): FormatRunResponseResult {
	if (resp.ok) {
		return {
			title: 'Success',
			body: formatResultValue(outputJsonValue(resp.result)),
			tone: 'ok',
		};
	}

	return {
		title: 'Error',
		body: `${resp.error.kind}: ${resp.error.message}`,
		tone: 'error',
	};
}

export function exampleOptions(examples: ReadonlyArray<Example>): Array<ExampleOption> {
	return examples.map((ex) => ({
		id: ex.id,
		title: ex.title,
	}));
}

export type TraceRow = {
	readonly depthLevel: number;
	readonly label: string;
	readonly durationLabel: string;
	readonly leftPct: number;
	readonly widthPct: number;
	readonly tone: 'ok' | 'error' | 'phase';
	readonly detail: string;
};

export type TraceAxisTick = {
	readonly leftPct: number;
	readonly label: string;
	readonly align: 'start' | 'middle' | 'end';
};

// Minimum visible bar width (percent of the shared time axis) so a ~0ms span
// (rounds to 0 duration, e.g. a pure-CPU stretch — see trace.ts's caveat) still
// shows a sliver rather than disappearing.
const MIN_TRACE_BAR_WIDTH_PCT = 0.5;

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max);
}

// Depth from parentSpanId chains: root (no parent, or a parent not present in
// this span set) is depth 0; each hop up adds 1. Guards cycles defensively
// (shouldn't occur in well-formed traces) by treating an already-visited span
// in the current walk as depth 0.
function computeDepths(spans: ReadonlyArray<TraceSpan>): Map<string, number> {
	const bySpanId = new Map(spans.map((s) => [s.spanId, s]));
	const depths = new Map<string, number>();

	function depthOf(spanId: string, seen: Set<string>): number {
		const cached = depths.get(spanId);
		if (cached !== undefined) return cached;

		const span = bySpanId.get(spanId);
		if (!span || !span.parentSpanId || !bySpanId.has(span.parentSpanId) || seen.has(spanId)) {
			depths.set(spanId, 0);
			return 0;
		}

		seen.add(spanId);
		const d = depthOf(span.parentSpanId, seen) + 1;
		depths.set(spanId, d);
		return d;
	}

	for (const s of spans) depthOf(s.spanId, new Set());
	return depths;
}

function traceUrlLabel(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		const path = `${u.pathname}${u.search}`;
		return path === '/' ? u.hostname : path;
	} catch {
		return rawUrl;
	}
}

function humanizeTraceName(name: string): string {
	const knownNames: Readonly<Record<string, string>> = {
		run: 'Run',
		target_fetch: 'Fetch input',
		loader: 'Run worker',
		'resource.read': 'Read',
		logs_read: 'Collect logs',
	};
	return knownNames[name] ?? name.replace(/[._]+/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export function formatTraceDuration(ms: number): string {
	if (ms === 0) return '0 ms';
	if (ms < 1) return `${ms.toFixed(1)} ms`;
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const seconds = ms / 1000;
	return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
}

export function buildTraceAxisTicks(totalMs: number): Array<TraceAxisTick> {
	const safeTotalMs = Math.max(totalMs, 0);
	return [0, 25, 50, 75, 100].map((leftPct) => ({
		leftPct,
		label: formatTraceDuration((safeTotalMs * leftPct) / 100),
		align: leftPct === 0 ? 'start' : leftPct === 100 ? 'end' : 'middle',
	}));
}

// Builds the waterfall rows for the trace UI: nesting depth from the
// parentSpanId chain, left/width as percentages of the shared time axis
// (totalMs <= 0 is treated as 1 to avoid division by zero), a short label, a
// tone for bar coloring, and a hover detail dump. Spans are returned in the
// given (startMs-sorted) order — row order is not otherwise touched.
export function buildTraceLayout(spans: ReadonlyArray<TraceSpan>, totalMs: number): Array<TraceRow> {
	const denom = totalMs > 0 ? totalMs : 1;
	const depths = computeDepths(spans);

	return spans.map((span): TraceRow => {
		const leftPct = clamp((span.startMs / denom) * 100, 0, 100);
		const maxWidthPct = 100 - leftPct;
		const rawWidthPct = clamp((span.durMs / denom) * 100, 0, maxWidthPct);
		const widthPct = Math.min(Math.max(rawWidthPct, Math.min(MIN_TRACE_BAR_WIDTH_PCT, maxWidthPct)), maxWidthPct);

		const kind = typeof span.attrs.kind === 'string' ? span.attrs.kind : '';
		const tone: TraceRow['tone'] = span.status === 'error' ? 'error' : kind.startsWith('gate_') ? 'ok' : 'phase';

		const name = typeof span.attrs.name === 'string' ? span.attrs.name : null;
		const humanName = name === null ? span.spanId : humanizeTraceName(name);
		const label = typeof span.attrs.url === 'string' ? `${humanName} ${traceUrlLabel(span.attrs.url)}` : humanName;

		const detail = [
			...Object.entries(span.attrs).map(([k, v]) => `${k}: ${v}`),
			`${span.durMs}ms at +${span.startMs}ms`,
		].join('\n');

		return {
			depthLevel: depths.get(span.spanId) ?? 0,
			label,
			durationLabel: formatTraceDuration(span.durMs),
			leftPct,
			widthPct,
			tone,
			detail,
		};
	});
}
