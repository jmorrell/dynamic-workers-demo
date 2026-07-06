// pattern: Functional Core

export type Permissions = {
	readonly fetch: 'page-links' | 'none';
	readonly cpuMs?: number;
};

// `assetPath` is a URL path served (asset-first) by the same origin, e.g.
// '/modules/image-hash/photon.wasm' — module bytes are fetched lazily per
// example from there, see ensureModules in main.ts.
export type ExampleModule = { readonly name: string; readonly kind: 'wasm'; readonly assetPath: string };

export type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
	readonly permissions?: Permissions;
	readonly modules?: ReadonlyArray<ExampleModule>;
};

// A single editor tab: the script tab (id 'script', kind 'script') or a wasm
// module tab (id/label = module name, kind 'wasm', content = base64 text).
export type EditorTab = { readonly id: string; readonly label: string; readonly kind: 'script' | 'wasm'; readonly content: string };

// Builds the pristine tab set for a selected example: the script tab first
// (label 'transform.ts'), then one tab per declared module. No example (or no
// modules) yields just the script tab. Module content comes from
// `moduleContents` (keyed by module name) when supplied — the base64 is
// fetched lazily (see ensureModules in main.ts) — or '' before it loads.
export function exampleTabs(example: Example | undefined, moduleContents?: ReadonlyMap<string, string>): Array<EditorTab> {
	const scriptTab: EditorTab = { id: 'script', label: 'transform.ts', kind: 'script', content: example?.source ?? '' };
	const moduleTabs: Array<EditorTab> = (example?.modules ?? []).map((m) => ({
		id: m.name,
		label: m.name,
		kind: 'wasm',
		content: moduleContents?.get(m.name) ?? '',
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

export type CustomRunModule = { readonly name: string; readonly kind: 'wasm'; readonly base64: string };

// Builds the { customCode, modules? } payload shape for a dirty (or no-example)
// custom run from the current tab contents. Wasm tab text has its whitespace
// stripped (the editor may show it wrapped/indented) before being sent as
// base64. `modules` is omitted entirely when there are none, per the wire contract.
export function buildCustomRunPayload(
	tabs: ReadonlyArray<EditorTab>,
	currentContents: ReadonlyMap<string, string>,
): { customCode: string; modules?: Array<CustomRunModule> } {
	const scriptTab = tabs.find((t) => t.kind === 'script');
	const customCode = (scriptTab && currentContents.get(scriptTab.id)) ?? '';

	const moduleTabs = tabs.filter((t) => t.kind === 'wasm');
	if (moduleTabs.length === 0) return { customCode };

	const modules: Array<CustomRunModule> = moduleTabs.map((t) => ({
		name: t.id,
		kind: 'wasm',
		base64: (currentContents.get(t.id) ?? '').replace(/\s+/g, ''),
	}));

	return { customCode, modules };
}

// Human-readable one-liner for the static permissions hint under the Code label.
// Returns null when there's nothing noteworthy to surface (default no-network grant).
export function formatPermissions(permissions: Permissions | undefined): string | null {
	if (!permissions || permissions.fetch === 'none') return null;
	const parts = [`fetch ${permissions.fetch}`];
	if (typeof permissions.cpuMs === 'number') parts.push(`cpu ${permissions.cpuMs}ms`);
	return `permissions: ${parts.join(' · ')}`;
}

type RunResponseOk = {
	readonly ok: true;
	readonly result: unknown;
	readonly logs: ReadonlyArray<{ readonly level: string; readonly message: string }>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
	readonly inputTruncated: boolean;
};

type RunResponseError = {
	readonly ok: false;
	readonly error: { readonly kind: string; readonly message: string };
	readonly logs: ReadonlyArray<{ readonly level: string; readonly message: string }>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
	readonly inputTruncated: boolean;
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

// Returns the raw display strings. The DOM layer (main.ts) renders these via
// textContent, which is the security boundary that makes hostile HTML inert —
// so we must NOT HTML-escape here, or output would be visibly double-escaped
// (e.g. "&lt;script&gt;" instead of "<script>"). escapeHtml remains available
// for any code path that genuinely builds an HTML string.
export function formatRunResponse(resp: RunResponse): FormatRunResponseResult {
	if (resp.ok) {
		return {
			title: 'Success',
			body: formatResultValue(resp.result),
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
