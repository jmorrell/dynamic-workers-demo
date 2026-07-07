// pattern: Imperative Shell

import {
	formatRunResponse,
	exampleOptions,
	formatPermissions,
	needsStoreId,
	exampleTabs,
	isTabSetDirty,
	buildCustomRunPayload,
	bytesToBase64,
	buildTraceLayout,
	type RunResponse,
	type Example,
	type EditorTab,
	type CustomRunModule,
	type Trace,
} from './lib/render';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { indentUnit } from '@codemirror/language';
import { Compartment, type Extension } from '@codemirror/state';

const PLACEHOLDER_CODE = '// Select an example to start (or edit it — edits run as custom code)';

// Anonymous, client-minted store identity (see src/runtime/AGENTS.md's Storage
// contract): a uuid persisted in localStorage so a storage-granted example's
// facet is found again across page loads. Embedded widgets may run without
// storage access (third-party iframe restrictions, private browsing, etc.),
// so any localStorage access is guarded — a failure falls back to a
// per-page-load-only uuid rather than breaking the run.
const STORE_ID_KEY = 'dwd-store-id';
const STORE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getOrCreateStoreId(): string {
	try {
		const existing = localStorage.getItem(STORE_ID_KEY);
		if (existing && STORE_ID_RE.test(existing)) return existing;
		const fresh = crypto.randomUUID();
		localStorage.setItem(STORE_ID_KEY, fresh);
		return fresh;
	} catch {
		// No storage access (or a write failure) — fall back to an id that's
		// stable for this page load only.
		return crypto.randomUUID();
	}
}

const STORE_ID = getOrCreateStoreId();

// Module-singleton UI state; fields are mutated in place by the event handlers
// below (intentional for this thin imperative shell).
type State = {
	examples: Array<Example>;
	selectedExampleId: string | null;
	isRunning: boolean;
	turnstileWidgetId: string | null;
	turnstileReady: boolean;
	// Current tab set (script tab + one per module) for whatever is selected —
	// an example, or just the bare script tab when none is. Tab identity/order
	// come from here; live text lives in tabContents.
	tabs: Array<EditorTab>;
	// The selected example's pristine tabs, or [] when none is selected (which
	// makes isTabSetDirty() always report dirty — see isDirty()).
	pristineTabs: Array<EditorTab>;
	// Per-tab current (possibly edited) text, keyed by tab id. The ACTIVE tab's
	// entry is stale while it's being edited — read live text via editorText()
	// for that one (see currentTabContents()).
	tabContents: Map<string, string>;
	activeTabId: string;
};

const state: State = {
	examples: [],
	selectedExampleId: null,
	isRunning: false,
	turnstileWidgetId: null,
	turnstileReady: false,
	tabs: [],
	pristineTabs: [],
	tabContents: new Map(),
	activeTabId: 'script',
};

// DOM element references
const exampleSelect = document.getElementById('example') as HTMLSelectElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const editorContainer = document.getElementById('editor') as HTMLDivElement;
const editorTabsEl = document.getElementById('editor-tabs') as HTMLDivElement;
const editorStatusEl = document.getElementById('editor-status') as HTMLSpanElement;
const editorPermsEl = document.getElementById('editor-perms') as HTMLDivElement;
const editorResetButton = document.getElementById('editor-reset') as HTMLButtonElement;
const clearStoreButton = document.getElementById('clear-store-button') as HTMLButtonElement;
const clearStoreStatusEl = document.getElementById('clear-store-status') as HTMLSpanElement;
const runButton = document.getElementById('run-button') as HTMLButtonElement;
const resultsSection = document.getElementById('results') as HTMLDivElement;
const resultsTitleEl = document.getElementById('results-title') as HTMLDivElement;
const resultsBodyEl = document.getElementById('results-body') as HTMLDivElement;
const logsContainerEl = document.getElementById('logs-container') as HTMLDivElement;
const timingInfoEl = document.getElementById('timing-info') as HTMLDivElement;
const traceContainerEl = document.getElementById('trace-container') as HTMLDivElement;
const suggestedUrlsSection = document.getElementById('suggested-urls-section') as HTMLDivElement;
const suggestedUrlsEl = document.getElementById('suggested-urls') as HTMLDivElement;
const turnstileDiv = document.getElementById('turnstile') as HTMLDivElement;

// Switches per-tab editor config (language support) without recreating the
// EditorView: the script tab keeps TS-aware `javascript()`; a wasm tab (edited
// as base64 text) gets no language extension plus line wrapping, since it has
// no meaningful syntax to highlight and is typically one long unwrapped line.
const languageCompartment = new Compartment();

function languageExtensionFor(kind: EditorTab['kind']): Extension[] {
	return kind === 'script' ? [javascript({ typescript: true })] : [EditorView.lineWrapping];
}

// Single always-editable CodeMirror instance shared by every tab. Pristine
// example code runs by exampleId (pre-bundled server-side); any edit to any
// tab makes the whole tab set "dirty" and it runs as custom code (transpiled
// from TS server-side — see isDirty()).
const editorView = new EditorView({
	doc: PLACEHOLDER_CODE,
	parent: editorContainer,
	extensions: [
		basicSetup,
		keymap.of([indentWithTab]),
		languageCompartment.of(languageExtensionFor('script')),
		indentUnit.of('\t'),
		EditorView.theme({
			'&': { fontSize: '13px' },
			'.cm-content, .cm-gutter': { minHeight: '260px' },
		}),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				updateEditorStatus();
				updateRunButton();
			}
		}),
	],
});

function editorText(): string {
	return editorView.state.doc.toString();
}

function setEditorText(code: string): void {
	editorView.dispatch({
		changes: { from: 0, to: editorView.state.doc.length, insert: code },
	});
}

function selectedExample(): Example | undefined {
	return state.selectedExampleId ? state.examples.find((ex) => ex.id === state.selectedExampleId) : undefined;
}

// Per-example module fetch, cached so repeated selects/runs don't re-fetch.
// The listing carries assetPath but not bytes (see manifest.ts) — a dirty run
// or a wasm editor tab needs the real bytes, fetched lazily (asset-first
// routing: run_worker_first only covers /api/*, so this hits the CDN, not the
// worker) and base64-encoded client-side.
const moduleCache = new Map<string, Promise<Array<CustomRunModule>>>();

function ensureModules(example: Example): Promise<Array<CustomRunModule>> {
	const cached = moduleCache.get(example.id);
	if (cached) return cached;

	const promise = Promise.all(
		(example.modules ?? []).map(async (m): Promise<CustomRunModule> => {
			const response = await fetch(m.assetPath);
			if (!response.ok) {
				throw new Error(`Failed to load module ${m.assetPath}: HTTP ${response.status}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { name: m.name, kind: m.kind, base64: bytesToBase64(bytes) };
		}),
	);

	// A failed fetch shouldn't poison the cache — delete so a later call retries.
	promise.catch(() => moduleCache.delete(example.id));
	moduleCache.set(example.id, promise);
	return promise;
}

// Swaps loaded module base64 into the live tab state. Idempotent and safe to
// call from both the select-time `.then` and the run-time `await` path: bails
// if the example has since been deselected, and only overwrites a wasm tab
// still sitting on its pre-load placeholder — an already-edited tab is left
// alone (it just stays dirty, same as editing base64 directly).
function applyLoadedModules(exampleId: string, modules: ReadonlyArray<CustomRunModule>): void {
	if (state.selectedExampleId !== exampleId) return;
	const example = selectedExample();
	if (!example) return;

	const contentByName = new Map(modules.map((m) => [m.name, m.base64]));
	const loadedTabs = exampleTabs(example, contentByName);

	for (const tab of loadedTabs) {
		if (tab.kind !== 'wasm') continue;
		const placeholder = state.pristineTabs.find((t) => t.id === tab.id)?.content;
		// The ACTIVE tab's tabContents entry is stale while it's being edited
		// (see State docs) — read live text so an in-progress edit isn't clobbered.
		const current = state.activeTabId === tab.id ? editorText() : state.tabContents.get(tab.id);
		if (current === placeholder) {
			state.tabContents.set(tab.id, tab.content);
			if (state.activeTabId === tab.id) setEditorText(tab.content);
		}
	}

	state.pristineTabs = loadedTabs;
	state.tabs = loadedTabs;

	updateEditorStatus();
	updateRunButton();
}

// A fresh snapshot of every tab's current text: state.tabContents for every
// tab except the active one, whose live text lives in the editor itself.
function currentTabContents(): Map<string, string> {
	const contents = new Map(state.tabContents);
	contents.set(state.activeTabId, editorText());
	return contents;
}

// "Dirty" means the tab set no longer matches the selected example's pristine
// tabs (or there's no selected example at all) — either way, a run must go
// through the custom-code path rather than by exampleId.
function isDirty(): boolean {
	return isTabSetDirty(state.pristineTabs, currentTabContents());
}

function updateEditorStatus(): void {
	const dirty = isDirty();
	editorStatusEl.style.display = dirty && state.selectedExampleId ? 'inline' : 'none';
	editorResetButton.style.display = dirty && state.selectedExampleId ? 'inline-block' : 'none';
}

// Renders the tab bar buttons and shows/hides the whole bar — hidden whenever
// there's nothing but the script tab (no example with modules, no custom
// modules in play).
function renderTabBar(): void {
	editorTabsEl.innerHTML = '';
	editorTabsEl.style.display = state.tabs.length > 1 ? 'flex' : 'none';

	for (const tab of state.tabs) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'editor-tab' + (tab.id === state.activeTabId ? ' active' : '');
		button.textContent = tab.label;
		button.addEventListener('click', () => selectTab(tab.id));
		editorTabsEl.appendChild(button);
	}
}

// Switches the single CodeMirror doc to a different tab: persists the
// outgoing tab's live text, reconfigures the language compartment for the
// incoming tab's kind, then loads its text.
function selectTab(tabId: string): void {
	if (tabId === state.activeTabId) return;

	state.tabContents.set(state.activeTabId, editorText());

	const tab = state.tabs.find((t) => t.id === tabId);
	if (!tab) return;

	state.activeTabId = tabId;
	editorView.dispatch({ effects: languageCompartment.reconfigure(languageExtensionFor(tab.kind)) });
	setEditorText(state.tabContents.get(tabId) ?? '');

	renderTabBar();
	updateEditorStatus();
	updateRunButton();
}

// Static hint reflecting the selected example's capability grant. A dirty custom
// run inherits these permissions (see onRunClick), so the line stays accurate.
// The "clear stored data" affordance rides the same permissions object — a
// dirty/custom run sends the identical grant back to the server (see
// onRunClick's `inherited` logic), so whether the button is offered stays in
// sync with whether the run actually carries a storeId.
function updatePermissionsHint(): void {
	const permissions = selectedExample()?.permissions;
	const line = formatPermissions(permissions);
	editorPermsEl.textContent = line ?? '';
	editorPermsEl.style.display = line ? 'block' : 'none';

	const showClear = needsStoreId(permissions);
	clearStoreButton.style.display = showClear ? 'inline-block' : 'none';
	clearStoreStatusEl.textContent = '';
	clearStoreStatusEl.style.display = 'none';
}

// Fire-and-confirm: destroys the current storeId's data for whatever example/
// custom-script identity is selected (the supervisor DO's facets — see
// StorageHost.selfDestruct). Disabled while in flight; result is shown as an
// inert textContent status next to the button.
async function onClearStoreClick(): Promise<void> {
	clearStoreButton.disabled = true;
	clearStoreStatusEl.style.display = 'inline';
	clearStoreStatusEl.textContent = 'Clearing…';

	try {
		const response = await fetch('/api/store', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ storeId: STORE_ID }),
		});
		clearStoreStatusEl.textContent = response.ok ? 'Stored data cleared.' : `Failed: HTTP ${response.status}`;
	} catch (error) {
		clearStoreStatusEl.textContent = `Failed: ${String(error)}`;
	} finally {
		clearStoreButton.disabled = false;
	}
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
	await loadExamples();
	await initializeTurnstile();
	setupEventListeners();
	updateRunButton();
});

async function loadExamples(): Promise<void> {
	try {
		const response = await fetch('/api/examples');
		if (!response.ok) {
			console.error('Failed to load examples:', response.statusText);
			return;
		}
		const examples: Array<Example> = await response.json();
		state.examples = examples;

		// Populate the dropdown
		const options = exampleOptions(examples);
		for (const option of options) {
			const optionEl = document.createElement('option');
			optionEl.value = option.id;
			optionEl.textContent = option.title;
			exampleSelect.appendChild(optionEl);
		}

		// Auto-select the first example so the page never shows a placeholder.
		if (examples.length > 0) {
			exampleSelect.value = examples[0].id;
			selectExample(examples[0].id);
		}
	} catch (error) {
		console.error('Error loading examples:', error);
	}
}

async function initializeTurnstile(): Promise<void> {
	try {
		// Fetch the Turnstile site key from the server
		const configResponse = await fetch('/api/config');
		if (!configResponse.ok) {
			console.error('Failed to load Turnstile config:', configResponse.statusText);
			return;
		}

		const config = (await configResponse.json()) as { turnstileSitekey: string };
		const sitekey = config.turnstileSitekey;

		// The api.js script loads async/defer and exposes no ready event, so we
		// poll for the global before rendering. Bounded so a failed load degrades
		// gracefully (the server still enforces the token).
		let attempts = 0;
		const maxAttempts = 50; // ~5 seconds with 100ms intervals
		while (!window.turnstile && attempts < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			attempts++;
		}

		if (!window.turnstile) {
			console.warn('Turnstile script did not load in time');
			return;
		}

		// Render the widget. The token is read on demand via getResponse() in
		// onRunClick, so no success callback is needed; wire error-callback so a
		// failed challenge marks the widget not-ready rather than failing silently.
		const widgetId = window.turnstile.render('#turnstile', {
			sitekey,
			'error-callback': () => {
				console.warn('Turnstile widget reported an error');
				state.turnstileReady = false;
			},
		});

		state.turnstileWidgetId = widgetId;
		state.turnstileReady = true;
	} catch (error) {
		console.error('Error initializing Turnstile:', error);
	}
}

function setupEventListeners(): void {
	exampleSelect.addEventListener('change', () => selectExample(exampleSelect.value || null));
	editorResetButton.addEventListener('click', onResetClick);
	runButton.addEventListener('click', onRunClick);
	urlInput.addEventListener('input', updateRunButton);
	clearStoreButton.addEventListener('click', onClearStoreClick);
}

function selectExample(selectedId: string | null): void {
	state.selectedExampleId = selectedId;

	const example = selectedId ? state.examples.find((ex) => ex.id === selectedId) : undefined;

	// No example → a single, empty-pristine script tab (isDirty() always true —
	// pristineTabs stays [] rather than exampleTabs(undefined), see State docs).
	const tabs = example ? exampleTabs(example) : [{ id: 'script', label: 'transform.ts', kind: 'script' as const, content: PLACEHOLDER_CODE }];
	state.tabs = tabs;
	state.pristineTabs = example ? tabs : [];
	state.tabContents = new Map(tabs.map((t) => [t.id, t.content]));
	state.activeTabId = 'script';

	editorView.dispatch({ effects: languageCompartment.reconfigure(languageExtensionFor('script')) });
	setEditorText(state.tabContents.get('script') ?? '');
	renderTabBar();

	if (example) {
		displaySuggestedUrls(example.suggestedUrls);
		// Tabs render immediately with '' wasm placeholders; swap in the real
		// base64 once it loads, as long as this example is still selected.
		if (example.modules?.length) {
			ensureModules(example)
				.then((modules) => applyLoadedModules(example.id, modules))
				.catch((error) => console.error('Failed to load example modules:', error));
		}
	} else {
		suggestedUrlsSection.style.display = 'none';
	}

	clearResults();
	updateEditorStatus();
	updatePermissionsHint();
	updateRunButton();
}

function clearResults(): void {
	resultsSection.className = 'empty';
	resultsTitleEl.textContent = '';
	resultsBodyEl.innerHTML = '';
	logsContainerEl.innerHTML = '';
	timingInfoEl.innerHTML = '';
	traceContainerEl.innerHTML = '';
}

// Restores every tab (not just the active one) to its pristine content.
function onResetClick(): void {
	if (state.pristineTabs.length === 0) return;

	state.tabContents = new Map(state.pristineTabs.map((t) => [t.id, t.content]));
	setEditorText(state.tabContents.get(state.activeTabId) ?? '');
	updateEditorStatus();
	updateRunButton();
}

function displaySuggestedUrls(urls: ReadonlyArray<string>): void {
	suggestedUrlsEl.innerHTML = '';

	if (urls.length === 0) {
		suggestedUrlsSection.style.display = 'none';
		return;
	}

	suggestedUrlsSection.style.display = 'block';

	for (const url of urls) {
		const chip = document.createElement('button');
		chip.className = 'chip';
		chip.type = 'button';
		chip.textContent = url;
		chip.addEventListener('click', (e) => {
			e.preventDefault();
			urlInput.value = url;
			updateRunButton();
		});
		suggestedUrlsEl.appendChild(chip);
	}
}

function updateRunButton(): void {
	const hasUrl = urlInput.value.trim().length > 0;
	const scriptText = currentTabContents().get('script') ?? '';
	const hasCode = scriptText.trim().length > 0;
	runButton.disabled = !hasUrl || !hasCode || state.isRunning;
}

async function onRunClick(): Promise<void> {
	if (state.isRunning) return;

	state.isRunning = true;
	updateRunButton();

	const url = urlInput.value.trim();
	const payload: Record<string, unknown> = { url };

	if (!isDirty() && state.selectedExampleId) {
		payload.worker = { type: 'example', exampleId: state.selectedExampleId };
	} else {
		// A dirty/custom run must ship real module bytes, not the '' placeholder
		// tabs render with before ensureModules resolves — wait for it here if
		// there's a selected example with wasm tabs still in play.
		const runExample = selectedExample();
		if (runExample && state.tabs.some((t) => t.kind === 'wasm')) {
			try {
				const modules = await ensureModules(runExample);
				applyLoadedModules(runExample.id, modules);
			} catch (error) {
				resultsSection.className = 'error';
				resultsTitleEl.textContent = 'Error';
				resultsBodyEl.textContent = `Failed to load example modules: ${String(error)}`;
				logsContainerEl.innerHTML = '';
				timingInfoEl.innerHTML = '';
				traceContainerEl.innerHTML = '';
				resultsSection.classList.remove('empty');
				state.isRunning = false;
				updateRunButton();
				return;
			}
		}

		const built = buildCustomRunPayload(state.tabs, currentTabContents());
		payload.worker = { type: 'custom', ...built };
		// A dirty run drops out of the example path, so the server no longer sees
		// the example's registered permissions — send them explicitly so an edited
		// example keeps the same capability grant it had when pristine.
		const inherited = selectedExample()?.permissions;
		if (inherited) payload.permissions = inherited;
	}

	// A storage-scoped grant (pristine or inherited into a dirty run — either
	// way selectedExample()?.permissions is the effective grant, see
	// updatePermissionsHint) requires the server-validated storeId that
	// selects this visitor's supervisor DO.
	if (needsStoreId(selectedExample()?.permissions)) {
		payload.storeId = STORE_ID;
	}

	// Get the Turnstile token if the widget is ready
	if (state.turnstileReady && window.turnstile && state.turnstileWidgetId !== null) {
		const token = window.turnstile.getResponse(state.turnstileWidgetId);
		if (token) {
			payload.turnstileToken = token;
		}
	}

	try {
		const response = await fetch('/api/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			resultsSection.className = 'error';
			resultsTitleEl.textContent = 'Error';
			// textContent renders the string literally (inert) — no escaping needed.
			resultsBodyEl.textContent = `HTTP ${response.status}: ${response.statusText}`;
			logsContainerEl.innerHTML = '';
			timingInfoEl.innerHTML = '';
			traceContainerEl.innerHTML = '';
			resultsSection.classList.remove('empty');
			state.isRunning = false;
			updateRunButton();
			return;
		}

		const data = (await response.json()) as RunResponse;
		renderResults(data);

		// Reset the Turnstile widget for the next run (token is single-use)
		if (state.turnstileReady && window.turnstile && state.turnstileWidgetId !== null) {
			window.turnstile.reset(state.turnstileWidgetId);
		}
	} catch (error) {
		resultsSection.className = 'error';
		resultsTitleEl.textContent = 'Error';
		resultsBodyEl.textContent = `Network error: ${String(error)}`;
		logsContainerEl.innerHTML = '';
		timingInfoEl.innerHTML = '';
		traceContainerEl.innerHTML = '';
		resultsSection.classList.remove('empty');
	}

	state.isRunning = false;
	updateRunButton();
}

function renderResults(data: RunResponse): void {
	const formatted = formatRunResponse(data);

	resultsSection.className = formatted.tone;
	resultsTitleEl.textContent = formatted.title;
	resultsBodyEl.innerHTML = '';

	// Render the value/error via textContent — the security boundary that makes
	// any HTML/script in run output inert (AC6.1). Never innerHTML with run data.
	const bodyPre = document.createElement('pre');
	bodyPre.textContent = formatted.body;
	resultsBodyEl.appendChild(bodyPre);

	// Logs
	logsContainerEl.innerHTML = '';
	if (data.logs.length > 0) {
		const logsLabel = document.createElement('strong');
		logsLabel.textContent = 'Logs:';
		logsContainerEl.appendChild(logsLabel);

		for (const log of data.logs) {
			const logLine = document.createElement('div');
			logLine.style.color = log.level === 'error' ? '#c00' : log.level === 'warn' ? '#d70' : '#666';
			logLine.textContent = `[${log.level}] ${log.message}`;
			logsContainerEl.appendChild(logLine);
		}
	}

	if (data.logsTruncated) {
		const truncated = document.createElement('div');
		truncated.className = 'logs-truncated';
		truncated.textContent = 'Logs were truncated';
		logsContainerEl.appendChild(truncated);
	}

	if (data.inputTruncated) {
		const inputTruncatedWarning = document.createElement('div');
		inputTruncatedWarning.className = 'logs-truncated';
		inputTruncatedWarning.textContent = '⚠ Fetched page exceeded the 2 MiB cap and was truncated before the transform ran.';
		logsContainerEl.appendChild(inputTruncatedWarning);
	}

	// Timing info
	timingInfoEl.innerHTML = '';
	if (typeof data.timingMs === 'number') {
		const timing = document.createElement('div');
		timing.className = 'timing';
		timing.textContent = `Execution time: ${data.timingMs}ms`;
		timingInfoEl.appendChild(timing);
	}

	renderTrace(data.trace);

	resultsSection.classList.remove('empty');
}

// Renders the collapsible waterfall trace section, or nothing when the
// response has no trace/spans (e.g. an older-shaped response). Closed by
// default. All text goes through textContent/title — attrs (urls, error
// messages) are untrusted, same discipline as the rest of renderResults.
function renderTrace(trace: Trace | undefined): void {
	traceContainerEl.innerHTML = '';
	if (!trace || trace.spans.length === 0) return;

	const rows = buildTraceLayout(trace.spans, trace.totalMs);

	const details = document.createElement('details');
	details.className = 'trace-details';

	const summary = document.createElement('summary');
	summary.textContent = `Trace (${trace.spans.length} spans, ${trace.totalMs}ms)`;
	details.appendChild(summary);

	const rowsContainer = document.createElement('div');
	rowsContainer.className = 'trace-rows';

	for (const row of rows) {
		const rowEl = document.createElement('div');
		rowEl.className = 'trace-row';
		rowEl.title = row.detail;

		const labelEl = document.createElement('span');
		labelEl.className = 'trace-label';
		labelEl.style.paddingLeft = `${row.depthLevel * 12}px`;
		labelEl.textContent = row.label;
		rowEl.appendChild(labelEl);

		const trackEl = document.createElement('div');
		trackEl.className = 'trace-track';

		const barEl = document.createElement('div');
		barEl.className = `trace-bar trace-bar-${row.tone}`;
		barEl.style.left = `${row.leftPct}%`;
		barEl.style.width = `${row.widthPct}%`;
		trackEl.appendChild(barEl);

		rowEl.appendChild(trackEl);
		rowsContainer.appendChild(rowEl);
	}

	details.appendChild(rowsContainer);
	traceContainerEl.appendChild(details);
}
