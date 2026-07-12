// pattern: Imperative Shell

import {
	formatRunResponse,
	exampleOptions,
	permissionBadges,
	needsStoreId,
	exampleTabs,
	isTabSetDirty,
	buildCustomRunPayload,
	bytesToBase64,
	buildTraceLayout,
	tabStripItems,
	type RunResponse,
	type Example,
	type EditorTab,
	type CustomRunModule,
	type Trace,
	type ResultTabId,
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
	// The most recent run's response (null before any run), which drives whether
	// the result tabs appear in the strip and what the result panes render.
	lastRun: RunResponse | null;
	// The result pane currently showing (null → the editor/source tab is showing).
	activeResultTab: ResultTabId | null;
	// Output view mode: whether showing the rendered HTML or JSON representation.
	outputView: 'rendered' | 'json';
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
	lastRun: null,
	activeResultTab: null,
	outputView: 'json',
};

// DOM element references
const exampleSelect = document.getElementById('example') as HTMLSelectElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const urlDatalistEl = document.getElementById('url-suggestions') as HTMLDataListElement;
const editorContainer = document.getElementById('editor') as HTMLDivElement;
const tabStripEl = document.getElementById('tab-strip-tabs') as HTMLDivElement;
const editorStatusEl = document.getElementById('editor-status') as HTMLSpanElement;
const editorPermsEl = document.getElementById('editor-perms') as HTMLDivElement;
const editorResetButton = document.getElementById('editor-reset') as HTMLButtonElement;
const clearStoreButton = document.getElementById('clear-store-button') as HTMLButtonElement;
const clearStoreStatusEl = document.getElementById('clear-store-status') as HTMLSpanElement;
const runButton = document.getElementById('run-button') as HTMLButtonElement;
const outputPaneEl = document.getElementById('output-pane') as HTMLDivElement;
const outputJsonEl = document.getElementById('output-json') as HTMLPreElement;
const outputRenderedEl = document.getElementById('output-rendered') as HTMLIFrameElement;
const outputToggleEl = document.getElementById('output-toggle') as HTMLDivElement;
const outputToggleRenderedBtn = outputToggleEl.querySelector('[data-view="rendered"]') as HTMLButtonElement;
const outputToggleJsonBtn = outputToggleEl.querySelector('[data-view="json"]') as HTMLButtonElement;
const resultsTitleEl = document.getElementById('results-title') as HTMLSpanElement;
const logsPaneEl = document.getElementById('logs-pane') as HTMLDivElement;
const tracePaneEl = document.getElementById('trace-pane') as HTMLDivElement;
const timingInfoEl = document.getElementById('timing-info') as HTMLSpanElement;

// Switches per-tab editor config (language support) without recreating the
// EditorView: the script tab keeps TS-aware `javascript()`; a wasm tab (edited
// as base64 text) gets no language extension plus line wrapping, since it has
// no meaningful syntax to highlight and is typically one long unwrapped line.
const languageCompartment = new Compartment();

function languageExtensionFor(kind: EditorTab['kind']): Extension[] {
	return kind === 'script' ? [javascript({ typescript: true })] : [EditorView.lineWrapping];
}

// Toggles which output view shows (rendered HTML or JSON) and updates button states.
function renderOutputView(): void {
	outputRenderedEl.hidden = state.outputView !== 'rendered';
	outputJsonEl.hidden = state.outputView !== 'json';

	// Set active class on the toggle button matching the current view.
	outputToggleRenderedBtn.classList.toggle('active', state.outputView === 'rendered');
	outputToggleJsonBtn.classList.toggle('active', state.outputView === 'json');
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
			'&': { fontSize: '13px', height: '100%' },
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
	const show = isDirty() && state.selectedExampleId !== null;
	editorStatusEl.hidden = !show;
	editorResetButton.hidden = !show;
}

// Renders the single unified strip: source-file tabs followed by the result
// tabs a run produced (see tabStripItems). Always visible — even with just the
// script tab, the strip hosts the dirty status / Reset controls beside it.
function renderTabStrip(): void {
	tabStripEl.innerHTML = '';

	const hasRun = state.lastRun !== null;
	const hasTrace = !!(state.lastRun?.trace && state.lastRun.trace.spans.length > 0);
	const items = tabStripItems(state.tabs, state.activeTabId, state.activeResultTab, { hasRun, hasTrace });

	for (const item of items) {
		const button = document.createElement('button');
		button.type = 'button';
		// The result group is separated from the source group in CSS
		// (.result-tab:first-of-type { margin-left: auto }), not here.
		let className = 'editor-tab' + (item.kind === 'result' ? ' result-tab' : '');
		if (item.active) className += ' active';
		button.className = className;
		button.textContent = item.label;
		button.addEventListener('click', () => (item.kind === 'source' ? selectTab(item.id) : selectResultTab(item.id as ResultTabId)));
		tabStripEl.appendChild(button);
	}
}

// Switches the single CodeMirror doc to a source tab (and back off any result
// pane). Persists the outgoing tab's live text, reconfigures the language
// compartment for the incoming tab's kind, then loads its text. When the tab is
// already active and only a result pane was showing, the doc-swap is skipped
// (its contents are still loaded) — clearing activeResultTab is enough.
function selectTab(tabId: string): void {
	if (tabId === state.activeTabId && state.activeResultTab === null) return;

	state.activeResultTab = null;

	if (tabId !== state.activeTabId) {
		state.tabContents.set(state.activeTabId, editorText());

		const tab = state.tabs.find((t) => t.id === tabId);
		if (!tab) return;

		state.activeTabId = tabId;
		editorView.dispatch({ effects: languageCompartment.reconfigure(languageExtensionFor(tab.kind)) });
		setEditorText(state.tabContents.get(tabId) ?? '');
	}

	renderTabStrip();
	updateEditorStatus();
	updateRunButton();
	showActivePane();
}

// Switches to a result pane without ever touching the editor doc or
// tabContents — the editor keeps holding the active source tab's live text, so
// dirty tracking stays correct while a result is on screen.
function selectResultTab(id: ResultTabId): void {
	state.activeResultTab = id;
	renderTabStrip();
	showActivePane();
}

// Shows exactly one pane — the editor (activeResultTab null) or one result
// pane — by toggling `hidden`. Re-measures the editor after unhiding it, since
// CodeMirror can't size a display:none element.
function showActivePane(): void {
	const active = state.activeResultTab;
	editorContainer.hidden = active !== null;
	outputPaneEl.hidden = active !== 'output';
	logsPaneEl.hidden = active !== 'logs';
	tracePaneEl.hidden = active !== 'trace';

	if (active === null) editorView.requestMeasure();
}

// Static badge strip reflecting the selected example's capability grant (hidden
// when no example is selected). A dirty custom run inherits these permissions
// (see onRunClick), so the strip stays accurate. The "clear stored data"
// affordance rides the same permissions object — a dirty/custom run sends the
// identical grant back to the server (see onRunClick's `inherited` logic), so
// whether the button is offered stays in sync with whether the run actually
// carries a storeId. Badge text is our own registry copy, but render via
// textContent/title anyway, same discipline as the rest of the widget.
function updatePermissionsHint(): void {
	const permissions = selectedExample()?.permissions;

	editorPermsEl.innerHTML = '';
	editorPermsEl.hidden = !state.selectedExampleId;
	if (state.selectedExampleId) {
		const caption = document.createElement('span');
		caption.className = 'perm-caption';
		caption.textContent = 'Permissions:';
		editorPermsEl.appendChild(caption);

		for (const badge of permissionBadges(permissions)) {
			const badgeEl = document.createElement('span');
			badgeEl.className = `perm-badge perm-badge-${badge.tone}`;
			badgeEl.textContent = badge.label;
			badgeEl.title = badge.detail;
			editorPermsEl.appendChild(badgeEl);
		}
	}

	const showClear = needsStoreId(permissions);
	clearStoreButton.hidden = !showClear;
	clearStoreStatusEl.textContent = '';
	clearStoreStatusEl.hidden = true;
}

// Fire-and-confirm: destroys the current storeId's data for whatever example/
// custom-script identity is selected (the supervisor DO's facets — see
// StorageHost.selfDestruct). Disabled while in flight; result is shown as an
// inert textContent status next to the button.
async function onClearStoreClick(): Promise<void> {
	clearStoreButton.disabled = true;
	clearStoreStatusEl.hidden = false;
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
			size: 'flexible',
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

	// Wire output view toggle buttons.
	outputToggleRenderedBtn.addEventListener('click', () => {
		state.outputView = 'rendered';
		renderOutputView();
	});
	outputToggleJsonBtn.addEventListener('click', () => {
		state.outputView = 'json';
		renderOutputView();
	});
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

	// Prefill the URL with the example's first suggested URL (empty when none),
	// and offer the rest as datalist suggestions.
	populateUrlSuggestions(example?.suggestedUrls ?? []);
	urlInput.value = example ? (example.suggestedUrls[0] ?? '') : '';

	if (example?.modules?.length) {
		// Tabs render immediately with '' wasm placeholders; swap in the real
		// base64 once it loads, as long as this example is still selected.
		ensureModules(example)
			.then((modules) => applyLoadedModules(example.id, modules))
			.catch((error) => console.error('Failed to load example modules:', error));
	}

	clearResults();
	updateEditorStatus();
	updatePermissionsHint();
	updateRunButton();
}

// Resets the result state and clears every result pane, returning the widget to
// showing the editor. Leaves the tab strip / editor status to their callers.
function clearResults(): void {
	state.lastRun = null;
	state.activeResultTab = null;
	outputPaneEl.className = 'pane';
	resultsTitleEl.textContent = '';
	outputJsonEl.textContent = '';
	outputRenderedEl.removeAttribute('srcdoc');
	outputToggleEl.hidden = true;
	state.outputView = 'json';
	logsPaneEl.innerHTML = '';
	tracePaneEl.innerHTML = '';
	timingInfoEl.textContent = '';
	renderOutputView();
	renderTabStrip();
	showActivePane();
}

// Restores every tab (not just the active one) to its pristine content.
function onResetClick(): void {
	if (state.pristineTabs.length === 0) return;

	state.tabContents = new Map(state.pristineTabs.map((t) => [t.id, t.content]));
	setEditorText(state.tabContents.get(state.activeTabId) ?? '');
	updateEditorStatus();
	updateRunButton();
}

// Fills the URL field's <datalist> with the example's suggested URLs so they're
// offered as autocomplete options (the field itself is prefilled with the first
// one in selectExample).
function populateUrlSuggestions(urls: ReadonlyArray<string>): void {
	urlDatalistEl.innerHTML = '';
	for (const url of urls) {
		const option = document.createElement('option');
		option.value = url;
		urlDatalistEl.appendChild(option);
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
				showRunError('module_load_failed', `Failed to load example modules: ${String(error)}`);
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
			showRunError('http_error', `HTTP ${response.status}: ${response.statusText}`);
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
		showRunError('network_error', `Network error: ${String(error)}`);
	}

	state.isRunning = false;
	updateRunButton();
}

// Builds a minimal error-shaped RunResponse for a client-side failure (module
// load, non-ok HTTP, network catch) and renders it through the same result
// panes a real run uses, so all three error paths behave identically.
function showRunError(kind: string, message: string): void {
	renderResults({ ok: false, error: { kind, message }, logs: [], logsTruncated: false, timingMs: 0, inputTruncated: false });
}

// Fills the Output / Logs / Trace panes from a run response and focuses the
// Output tab. Which result tabs actually appear is driven by state.lastRun (see
// renderTabStrip / tabStripItems).
function renderResults(data: RunResponse): void {
	state.lastRun = data;

	// Output pane: title + tone class, and the formatted value/error into the
	// JSON view via textContent — the security boundary that makes any HTML/script
	// in run output inert (AC6.1). Never innerHTML with run data.
	const formatted = formatRunResponse(data);
	outputPaneEl.className = `pane ${formatted.tone}`;
	resultsTitleEl.textContent = formatted.title;
	outputJsonEl.textContent = formatted.body;

	// Handle rendered HTML output if available; server-rendered HTML in a sandboxed iframe.
	if (data.ok && typeof data.resultHtml === 'string') {
		outputRenderedEl.srcdoc = data.resultHtml;
		state.outputView = 'rendered';
		outputToggleEl.hidden = false;
	} else {
		outputRenderedEl.removeAttribute('srcdoc');
		state.outputView = 'json';
		outputToggleEl.hidden = true;
	}
	renderOutputView();

	// Logs pane.
	logsPaneEl.innerHTML = '';
	if (data.logs.length > 0) {
		for (const log of data.logs) {
			const logLine = document.createElement('div');
			logLine.style.color = log.level === 'error' ? '#c00' : log.level === 'warn' ? '#d70' : '#666';
			logLine.textContent = `[${log.level}] ${log.message}`;
			logsPaneEl.appendChild(logLine);
		}
	} else {
		const empty = document.createElement('div');
		empty.className = 'logs-empty';
		empty.textContent = 'No logs';
		logsPaneEl.appendChild(empty);
	}

	if (data.logsTruncated) {
		const truncated = document.createElement('div');
		truncated.className = 'logs-truncated';
		truncated.textContent = 'Logs were truncated';
		logsPaneEl.appendChild(truncated);
	}

	if (data.inputTruncated) {
		const inputTruncatedWarning = document.createElement('div');
		inputTruncatedWarning.className = 'logs-truncated';
		inputTruncatedWarning.textContent = '⚠ Fetched page exceeded the 2 MiB cap and was truncated before the transform ran.';
		logsPaneEl.appendChild(inputTruncatedWarning);
	}

	// Trace pane.
	renderTrace(data.trace);

	// Timing → footer.
	timingInfoEl.textContent = typeof data.timingMs === 'number' ? `Execution time: ${data.timingMs}ms` : '';

	selectResultTab('output');
}

// Renders the waterfall trace rows straight into the trace pane, or nothing
// when the response has no trace/spans (e.g. an older-shaped response). All text
// goes through textContent/title — attrs (urls, error messages) are untrusted,
// same discipline as the rest of renderResults.
function renderTrace(trace: Trace | undefined): void {
	tracePaneEl.innerHTML = '';
	if (!trace || trace.spans.length === 0) return;

	const rows = buildTraceLayout(trace.spans, trace.totalMs);

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

	tracePaneEl.appendChild(rowsContainer);
}
