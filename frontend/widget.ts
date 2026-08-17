// pattern: Imperative Shell
//
// <dynamic-workers-demo> — the embeddable widget, light-DOM custom element.
// Each instance owns its full UI state (the old page-singleton shell from
// main.ts, scoped per instance); page-level concerns (examples/config fetch,
// store identity, Turnstile) live in shared.ts.
//
// Attributes:
//   example="hackernews"  pin one example (single mode), or the initial
//                         selection in playground mode
//   playground            boolean; show the example picker
//   features="logs traces permissions llm-prompt"
//                         space-separated opt-ins; omitted features stay
//                         hidden (result tabs never appear, permissions strip
//                         stays off) so a post can introduce concepts gradually
//   url="https://…"       override the initial URL prefill
//   suggested-urls='["https://…"]'
//                         JSON array overriding the example's URL suggestions
//   height="32rem"        override the widget height (any CSS length)

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
	buildTraceAxisTicks,
	tabStripItems,
	LLM_PROMPT,
	orderExamplesForPlayground,
	type RunResponse,
	type Example,
	type EditorTab,
	type CustomRunModule,
	type Trace,
	type ResultTabId,
} from './lib/render';
import { API_PREFIX } from '../src/paths';
import { STORE_ID, fetchExamples, turnstileManager } from './shared';
import { ensureStylesInjected } from './styles';
import { EditorView, basicSetup } from 'codemirror';
import { Decoration, keymap, WidgetType } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { indentUnit } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { Compartment, type Extension } from '@codemirror/state';

const PLACEHOLDER_CODE = '// Select an example to start (or edit it — edits run as custom code)';

function parseSuggestedUrls(value: string | null): ReadonlyArray<string> | null {
	if (value === null) return null;

	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((url) => typeof url === 'string') ? parsed : null;
	} catch {
		return null;
	}
}

// Per-example module fetch, cached page-wide so repeated selects/runs (in any
// instance) don't re-fetch. The listing carries a 1.5 KiB preview plus assetPath
// (see manifest.ts); the full bytes are fetched only on explicit request or
// when a dirty run needs them, then base64-encoded client-side.
type WasmRunModule = Extract<CustomRunModule, { kind: 'wasm' }>;

const moduleCache = new Map<string, Promise<Array<WasmRunModule>>>();

function ensureModules(example: Example): Promise<Array<WasmRunModule>> {
	const cached = moduleCache.get(example.id);
	if (cached) return cached;

	const promise = Promise.all(
		(example.modules ?? []).filter((m) => m.kind === 'wasm').map(async (m): Promise<WasmRunModule> => {
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

function formatModuleSize(byteSize: number): string {
	const kibibytes = byteSize / 1024;
	if (kibibytes < 1024) return `${Math.ceil(kibibytes)} KiB`;
	return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

class LoadFullModuleWidget extends WidgetType {
	constructor(
		private readonly byteSize: number,
		private readonly onLoad: () => void,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = 'dwd-load-full-module';
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = `Load the full file for some reason (${formatModuleSize(this.byteSize)})`;
		button.addEventListener('click', this.onLoad);
		wrapper.appendChild(button);
		return wrapper;
	}

}

type Features = { logs: boolean; traces: boolean; permissions: boolean; llmPrompt: boolean };

type WidgetState = {
	examples: Array<Example>;
	selectedExampleId: string | null;
	isRunning: boolean;
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

export class DynamicWorkersDemoElement extends HTMLElement {
	private state: WidgetState = {
		examples: [],
		selectedExampleId: null,
		isRunning: false,
		tabs: [],
		pristineTabs: [],
		tabContents: new Map(),
		activeTabId: 'script',
		lastRun: null,
		activeResultTab: null,
		outputView: 'json',
	};

	private features: Features = { logs: false, traces: false, permissions: false, llmPrompt: false };
	private playground = false;
	private pinnedExampleId: string | null = null;
	private initialUrl: string | null = null;
	private suggestedUrls: ReadonlyArray<string> | null = null;

	private editorView!: EditorView;
	private languageCompartment = new Compartment();
	private modulePreviewCompartment = new Compartment();
	private loadedWasmModules = new Set<string>();
	private initialized = false;

	// DOM refs (assigned in connectedCallback)
	private exampleSelect!: HTMLSelectElement;
	private exampleDescriptionEl!: HTMLParagraphElement;
	private urlSelect!: HTMLSelectElement;
	private urlInput!: HTMLInputElement;
	private editorContainer!: HTMLDivElement;
	private tabStripEl!: HTMLDivElement;
	private editorStatusEl!: HTMLSpanElement;
	private editorPermsEl!: HTMLDivElement;
	private editorResetButton!: HTMLButtonElement;
	private clearStoreButton!: HTMLButtonElement;
	private clearStoreStatusEl!: HTMLSpanElement;
	private runButton!: HTMLButtonElement;
	private outputPaneEl!: HTMLDivElement;
	private promptPaneEl!: HTMLDivElement;
	private promptTextEl!: HTMLPreElement;
	private copyPromptButton!: HTMLButtonElement;
	private copyPromptStatusEl!: HTMLSpanElement;
	private outputJsonEl!: HTMLPreElement;
	private outputRenderedEl!: HTMLIFrameElement;
	private outputToggleEl!: HTMLDivElement;
	private outputToggleRenderedBtn!: HTMLButtonElement;
	private outputToggleJsonBtn!: HTMLButtonElement;
	private resultsTitleEl!: HTMLSpanElement;
	private logsPaneEl!: HTMLDivElement;
	private tracePaneEl!: HTMLDivElement;
	private timingInfoEl!: HTMLSpanElement;
	private turnstileSlot!: HTMLDivElement;

	connectedCallback(): void {
		// connectedCallback re-fires on DOM moves; build once.
		if (this.initialized) return;
		this.initialized = true;

		ensureStylesInjected();
		this.readAttributes();
		this.buildDom();
		this.createEditor();
		this.setupEventListeners();

		void this.loadExamples();
	}

	private readAttributes(): void {
		this.playground = this.hasAttribute('playground');
		this.pinnedExampleId = this.getAttribute('example');
		this.initialUrl = this.getAttribute('url');
		this.suggestedUrls = parseSuggestedUrls(this.getAttribute('suggested-urls'));

		const features = (this.getAttribute('features') ?? '').split(/\s+/).filter(Boolean);
		this.features = {
			logs: features.includes('logs'),
			traces: features.includes('traces'),
			permissions: features.includes('permissions'),
			llmPrompt: features.includes('llm-prompt'),
		};

		const height = this.getAttribute('height');
		if (height) this.style.height = height;
	}

	private buildDom(): void {
		// Static template — no run data ever passes through here; everything
		// dynamic is rendered later via textContent (see renderResults).
		this.innerHTML = `
			<div class="dwd-topbar" hidden>
				<select class="dwd-example-select" aria-label="Example"></select>
				<div class="dwd-perms" hidden></div>
				<p class="dwd-example-description" hidden></p>
			</div>
			<div class="dwd-url-row">
				<select class="dwd-url-select" aria-label="Target URL"></select>
				<input type="url" class="dwd-url" aria-label="Custom URL" placeholder="https://example.com" hidden />
				<button type="button" class="dwd-run" disabled>Run</button>
			</div>
			<div class="dwd-tab-strip">
				<div class="dwd-tab-strip-tabs"></div>
				<span class="dwd-editor-status" hidden>edited — runs as custom code</span>
				<button type="button" class="dwd-reset" hidden>Reset</button>
			</div>
			<div class="dwd-pane-host">
				<div class="dwd-editor dwd-pane"></div>
				<div class="dwd-prompt-pane dwd-pane" hidden>
					<div class="dwd-prompt-toolbar">
						<span>Describe your transform, then paste this into an LLM.</span>
						<button type="button" class="dwd-copy-prompt">Copy prompt</button>
						<span class="dwd-copy-prompt-status" aria-live="polite"></span>
					</div>
					<pre class="dwd-prompt-text"></pre>
				</div>
				<div class="dwd-output-pane dwd-pane" hidden>
					<div class="dwd-output-toolbar">
						<span class="dwd-results-title"></span>
						<div class="dwd-output-toggle" hidden>
							<button type="button" data-view="rendered">Rendered</button>
							<button type="button" data-view="json">JSON</button>
						</div>
					</div>
					<iframe class="dwd-output-rendered" sandbox="allow-popups allow-popups-to-escape-sandbox" hidden></iframe>
					<pre class="dwd-output-json"></pre>
				</div>
				<div class="dwd-logs-pane dwd-pane" hidden></div>
				<div class="dwd-trace-pane dwd-pane" hidden></div>
			</div>
			<div class="dwd-footer">
				<div class="dwd-turnstile"></div>
				<button type="button" class="dwd-clear-store" hidden>Clear stored data</button>
				<span class="dwd-clear-store-status" hidden></span>
				<span class="dwd-timing"></span>
			</div>
		`;

		const el = <T extends Element>(selector: string): T => {
			const found = this.querySelector<T>(selector);
			if (!found) throw new Error(`dynamic-workers-demo: missing ${selector}`);
			return found;
		};

		this.exampleSelect = el('.dwd-example-select');
		this.exampleDescriptionEl = el('.dwd-example-description');
		this.urlSelect = el('.dwd-url-select');
		this.urlInput = el('.dwd-url');
		this.editorContainer = el('.dwd-editor');
		this.tabStripEl = el('.dwd-tab-strip-tabs');
		this.editorStatusEl = el('.dwd-editor-status');
		this.editorPermsEl = el('.dwd-perms');
		this.editorResetButton = el('.dwd-reset');
		this.clearStoreButton = el('.dwd-clear-store');
		this.clearStoreStatusEl = el('.dwd-clear-store-status');
		this.runButton = el('.dwd-run');
		this.promptPaneEl = el('.dwd-prompt-pane');
		this.promptTextEl = el('.dwd-prompt-text');
		this.copyPromptButton = el('.dwd-copy-prompt');
		this.copyPromptStatusEl = el('.dwd-copy-prompt-status');
		this.promptTextEl.textContent = LLM_PROMPT;
		this.outputPaneEl = el('.dwd-output-pane');
		this.outputJsonEl = el('.dwd-output-json');
		this.outputRenderedEl = el('.dwd-output-rendered');
		this.outputToggleEl = el('.dwd-output-toggle');
		this.outputToggleRenderedBtn = el('.dwd-output-toggle [data-view="rendered"]');
		this.outputToggleJsonBtn = el('.dwd-output-toggle [data-view="json"]');
		this.resultsTitleEl = el('.dwd-results-title');
		this.logsPaneEl = el('.dwd-logs-pane');
		this.tracePaneEl = el('.dwd-trace-pane');
		this.timingInfoEl = el('.dwd-timing');
		this.turnstileSlot = el('.dwd-turnstile');

		// The topbar only exists for playground mode's picker (the permissions
		// strip moves wherever the topbar is, so show the bar if either is on).
		const topbar = el<HTMLDivElement>('.dwd-topbar');
		topbar.hidden = !this.playground && !this.features.permissions;
		this.exampleSelect.hidden = !this.playground;
		this.exampleDescriptionEl.hidden = !this.playground;
	}

	// Single always-editable CodeMirror instance shared by every tab. Pristine
	// example code runs by exampleId (pre-bundled server-side); any edit to any
	// tab makes the whole tab set "dirty" and it runs as custom code (transpiled
	// from TS server-side — see isDirty()).
	private createEditor(): void {
		this.editorView = new EditorView({
			doc: PLACEHOLDER_CODE,
			parent: this.editorContainer,
			extensions: [
				basicSetup,
				keymap.of([indentWithTab]),
				this.languageCompartment.of(languageExtensionFor('script')),
				this.modulePreviewCompartment.of([]),
				oneDark,
				indentUnit.of('\t'),
				EditorView.theme({
					'&': { fontSize: '13px', height: '100%', backgroundColor: '#24292e' },
					'.cm-content': { padding: '0.5rem 0' },
					'.cm-line': { padding: '0 0.5rem 0 0' },
					'.cm-gutters': { backgroundColor: '#24292e', border: 'none', paddingLeft: '0.5rem' },
				}),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						this.updateEditorStatus();
						this.updateRunButton();
					}
				}),
			],
		});
	}

	private setupEventListeners(): void {
		this.exampleSelect.addEventListener('change', () => this.selectExample(this.exampleSelect.value || null));
		this.editorResetButton.addEventListener('click', () => this.onResetClick());
		this.runButton.addEventListener('click', () => void this.onRunClick());
		this.urlSelect.addEventListener('change', () => {
			const custom = this.urlSelect.value === '__custom__';
			this.urlInput.hidden = !custom;
			this.urlInput.value = custom ? '' : this.urlSelect.value;
			this.updateRunButton();
			if (custom) this.urlInput.focus();
		});
		this.urlInput.addEventListener('input', () => this.updateRunButton());
		this.clearStoreButton.addEventListener('click', () => void this.onClearStoreClick());
		this.copyPromptButton.addEventListener('click', () => void this.copyLlmPrompt());

		this.outputToggleRenderedBtn.addEventListener('click', () => {
			this.state.outputView = 'rendered';
			this.renderOutputView();
		});
		this.outputToggleJsonBtn.addEventListener('click', () => {
			this.state.outputView = 'json';
			this.renderOutputView();
		});

		// Lazy third-party load: the Turnstile script is only injected once a
		// reader actually engages with an embed. Priming early (any pointer/
		// keyboard interaction, not just Run) gives the challenge time to
		// complete before the first run needs a token.
		const prime = (): void => turnstileManager.prime(this.turnstileSlot);
		this.addEventListener('pointerdown', prime, { once: true });
		this.addEventListener('focusin', prime, { once: true });
	}

	private async loadExamples(): Promise<void> {
		try {
			const examples = await fetchExamples();
			this.state.examples = this.playground ? orderExamplesForPlayground(examples) : examples;
		} catch (error) {
			console.error('Error loading examples:', error);
			return;
		}

		if (this.playground) {
			for (const option of exampleOptions(this.state.examples)) {
				const optionEl = document.createElement('option');
				optionEl.value = option.id;
				optionEl.textContent = option.title;
				this.exampleSelect.appendChild(optionEl);
			}
		}

		// Pin the requested example, falling back to the first so the widget
		// never shows a bare placeholder.
		const initial =
			(this.pinnedExampleId && this.state.examples.find((ex) => ex.id === this.pinnedExampleId)) || this.state.examples[0];
		if (this.pinnedExampleId && (!initial || initial.id !== this.pinnedExampleId)) {
			console.warn(`dynamic-workers-demo: unknown example "${this.pinnedExampleId}"`);
		}
		if (initial) {
			if (this.playground) this.exampleSelect.value = initial.id;
			this.selectExample(initial.id);
		}
		this.updateRunButton();
	}

	private editorText(): string {
		return this.editorView.state.doc.toString();
	}

	private setEditorText(code: string): void {
		this.editorView.dispatch({
			changes: { from: 0, to: this.editorView.state.doc.length, insert: code },
		});
	}

	private selectedExample(): Example | undefined {
		return this.state.selectedExampleId ? this.state.examples.find((ex) => ex.id === this.state.selectedExampleId) : undefined;
	}

	// Swaps loaded module base64 into the live tab state. Idempotent and safe to
	// call from both the select-time `.then` and the run-time `await` path: bails
	// if the example has since been deselected, and only overwrites a wasm tab
	// still sitting on its pre-load placeholder — an already-edited tab is left
	// alone (it just stays dirty, same as editing base64 directly).
	private applyLoadedModules(exampleId: string, modules: ReadonlyArray<WasmRunModule>): void {
		if (this.state.selectedExampleId !== exampleId) return;
		const example = this.selectedExample();
		if (!example) return;

		const contentByName = new Map(modules.map((m) => [m.name, m.base64]));
		const loadedTabs = exampleTabs(example, contentByName);

		for (const tab of loadedTabs) {
			if (tab.kind !== 'wasm') continue;
			this.loadedWasmModules.add(tab.id);
			const placeholder = this.state.pristineTabs.find((t) => t.id === tab.id)?.content;
			// The ACTIVE tab's tabContents entry is stale while it's being edited
			// (see WidgetState docs) — read live text so an in-progress edit isn't
			// clobbered.
			const current = this.state.activeTabId === tab.id ? this.editorText() : this.state.tabContents.get(tab.id);
			if (current === placeholder) {
				this.state.tabContents.set(tab.id, tab.content);
				if (this.state.activeTabId === tab.id) this.setEditorText(tab.content);
			}
		}

		this.state.pristineTabs = loadedTabs;
		this.state.tabs = loadedTabs;

		this.updateEditorStatus();
		this.updateRunButton();
		this.updateModulePreviewWidget();
	}

	private updateModulePreviewWidget(): void {
		const module = this.selectedExample()?.modules?.find(
			(m) => m.kind === 'wasm' && m.name === this.state.activeTabId,
		);
		const decorations =
			module?.kind === 'wasm' && module.byteSize > 1536 && !this.loadedWasmModules.has(module.name)
				? Decoration.set([
						Decoration.widget({
							widget: new LoadFullModuleWidget(module.byteSize, () => void this.loadFullModule()),
							block: true,
							side: 1,
						}).range(this.editorView.state.doc.length),
					])
				: Decoration.none;
		this.editorView.dispatch({ effects: this.modulePreviewCompartment.reconfigure(EditorView.decorations.of(decorations)) });
	}

	private async loadFullModule(): Promise<void> {
		const example = this.selectedExample();
		if (!example) return;
		try {
			this.applyLoadedModules(example.id, await ensureModules(example));
		} catch (error) {
			this.showRunError('module_load_failed', `Failed to load example modules: ${String(error)}`);
		}
	}

	// A fresh snapshot of every tab's current text: state.tabContents for every
	// tab except the active one, whose live text lives in the editor itself.
	private currentTabContents(): Map<string, string> {
		const contents = new Map(this.state.tabContents);
		contents.set(this.state.activeTabId, this.editorText());
		return contents;
	}

	// "Dirty" means the tab set no longer matches the selected example's pristine
	// tabs (or there's no selected example at all) — either way, a run must go
	// through the custom-code path rather than by exampleId.
	private isDirty(): boolean {
		return isTabSetDirty(this.state.pristineTabs, this.currentTabContents());
	}

	private updateEditorStatus(): void {
		const show = this.isDirty() && this.state.selectedExampleId !== null;
		this.editorStatusEl.hidden = !show;
		this.editorResetButton.hidden = !show;
	}

	// Renders the single unified strip: source-file tabs followed by the result
	// tabs a run produced (see tabStripItems), minus any result tabs this
	// embed's feature flags keep hidden. Always visible — even with just the
	// script tab, the strip hosts the dirty status / Reset controls beside it.
	private renderTabStrip(): void {
		this.tabStripEl.innerHTML = '';

		const hasRun = this.state.lastRun !== null;
		const hasTrace = !!(this.state.lastRun?.trace && this.state.lastRun.trace.spans.length > 0);
		const items = tabStripItems(this.state.tabs, this.state.activeTabId, this.state.activeResultTab, {
			hasRun,
			hasTrace,
			hasPrompt: this.features.llmPrompt && this.state.selectedExampleId === 'write-your-own',
		}).filter(
			(item) => {
				if (item.kind !== 'result') return true;
				if (item.id === 'logs') return this.features.logs;
				if (item.id === 'trace') return this.features.traces;
				return true;
			},
		);

		for (const item of items) {
			const button = document.createElement('button');
			button.type = 'button';
			// The result group is separated from the source group in CSS
			// (.dwd-result-tab:first-of-type { margin-left: auto }), not here.
			let className = 'dwd-tab' + (item.kind === 'result' ? ' dwd-result-tab' : '');
			if (item.active) className += ' active';
			button.className = className;
			button.textContent = item.label;
			button.addEventListener('click', () =>
				item.kind === 'source' ? this.selectTab(item.id) : this.selectResultTab(item.id as ResultTabId),
			);
			this.tabStripEl.appendChild(button);
		}
	}

	// Switches the single CodeMirror doc to a source tab (and back off any result
	// pane). Persists the outgoing tab's live text, reconfigures the language
	// compartment for the incoming tab's kind, then loads its text. When the tab
	// is already active and only a result pane was showing, the doc-swap is
	// skipped (its contents are still loaded) — clearing activeResultTab is enough.
	private selectTab(tabId: string): void {
		if (tabId === this.state.activeTabId && this.state.activeResultTab === null) return;

		this.state.activeResultTab = null;

		if (tabId !== this.state.activeTabId) {
			this.state.tabContents.set(this.state.activeTabId, this.editorText());

			const tab = this.state.tabs.find((t) => t.id === tabId);
			if (!tab) return;

			this.state.activeTabId = tabId;
			this.editorView.dispatch({ effects: this.languageCompartment.reconfigure(languageExtensionFor(tab.kind)) });
			this.setEditorText(this.state.tabContents.get(tabId) ?? '');
		}
		this.updateModulePreviewWidget();

		this.renderTabStrip();
		this.updateEditorStatus();
		this.updateRunButton();
		this.showActivePane();
	}

	// Switches to a result pane without ever touching the editor doc or
	// tabContents — the editor keeps holding the active source tab's live text,
	// so dirty tracking stays correct while a result is on screen.
	private selectResultTab(id: ResultTabId): void {
		this.state.activeResultTab = id;
		this.renderTabStrip();
		this.showActivePane();
	}

	// Shows exactly one pane — the editor (activeResultTab null) or one result
	// pane — by toggling `hidden`. Re-measures the editor after unhiding it,
	// since CodeMirror can't size a display:none element.
	private showActivePane(): void {
		const active = this.state.activeResultTab;
		this.editorContainer.hidden = active !== null;
		this.promptPaneEl.hidden = active !== 'prompt';
		this.outputPaneEl.hidden = active !== 'output';
		this.logsPaneEl.hidden = active !== 'logs';
		this.tracePaneEl.hidden = active !== 'trace';

		if (active === null) this.editorView.requestMeasure();
	}

	private async copyLlmPrompt(): Promise<void> {
		try {
			await navigator.clipboard.writeText(LLM_PROMPT);
			this.copyPromptStatusEl.textContent = 'Copied.';
		} catch {
			this.copyPromptStatusEl.textContent = 'Select the prompt and copy it manually.';
		}
	}

	// Toggles which output view shows (rendered HTML or JSON) and updates
	// button states.
	private renderOutputView(): void {
		this.outputRenderedEl.hidden = this.state.outputView !== 'rendered';
		this.outputJsonEl.hidden = this.state.outputView !== 'json';

		this.outputToggleRenderedBtn.classList.toggle('active', this.state.outputView === 'rendered');
		this.outputToggleJsonBtn.classList.toggle('active', this.state.outputView === 'json');
	}

	// Static badge strip reflecting the selected example's capability grant
	// (hidden entirely unless this embed opted into the `permissions` feature —
	// early posts introduce the concept later). A dirty custom run inherits
	// these permissions (see onRunClick), so the strip stays accurate. The
	// "clear stored data" affordance rides the same permissions object — a
	// dirty/custom run sends the identical grant back to the server, so whether
	// the button is offered stays in sync with whether the run actually carries
	// a storeId. Badge text is our own registry copy, but render via
	// textContent/title anyway, same discipline as the rest of the widget.
	private updatePermissionsHint(): void {
		const permissions = this.selectedExample()?.permissions;

		this.editorPermsEl.innerHTML = '';
		this.editorPermsEl.hidden = !this.features.permissions || !this.state.selectedExampleId;
		if (this.features.permissions && this.state.selectedExampleId) {
			const caption = document.createElement('span');
			caption.className = 'dwd-perm-caption';
			caption.textContent = 'Permissions:';
			this.editorPermsEl.appendChild(caption);

			for (const badge of permissionBadges(permissions)) {
				const badgeEl = document.createElement('span');
				badgeEl.className = `dwd-perm-badge dwd-perm-badge-${badge.tone}`;
				badgeEl.textContent = badge.label;
				badgeEl.title = badge.detail;
				this.editorPermsEl.appendChild(badgeEl);
			}
		}

		const showClear = needsStoreId(permissions);
		this.clearStoreButton.hidden = !showClear;
		this.clearStoreStatusEl.textContent = '';
		this.clearStoreStatusEl.hidden = true;
	}

	// Fire-and-confirm: destroys the current storeId's data for whatever
	// example/custom-script identity is selected (the supervisor DO's facets —
	// see StorageHost.selfDestruct). Disabled while in flight; result is shown
	// as an inert textContent status next to the button.
	private async onClearStoreClick(): Promise<void> {
		this.clearStoreButton.disabled = true;
		this.clearStoreStatusEl.hidden = false;
		this.clearStoreStatusEl.textContent = 'Clearing…';

		try {
			const response = await fetch(`${API_PREFIX}/store`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ storeId: STORE_ID }),
			});
			this.clearStoreStatusEl.textContent = response.ok ? 'Stored data cleared.' : `Failed: HTTP ${response.status}`;
		} catch (error) {
			this.clearStoreStatusEl.textContent = `Failed: ${String(error)}`;
		} finally {
			this.clearStoreButton.disabled = false;
		}
	}

	private selectExample(selectedId: string | null): void {
		this.state.selectedExampleId = selectedId;
		this.loadedWasmModules.clear();

		const example = selectedId ? this.state.examples.find((ex) => ex.id === selectedId) : undefined;
		this.exampleDescriptionEl.textContent = example?.description ?? '';

		// No example → a single, empty-pristine script tab (isDirty() always true
		// — pristineTabs stays [] rather than exampleTabs(undefined), see
		// WidgetState docs).
		const tabs = example
			? exampleTabs(example)
			: [{ id: 'script', label: 'transform.ts', kind: 'script' as const, content: PLACEHOLDER_CODE }];
		this.state.tabs = tabs;
		this.state.pristineTabs = example ? tabs : [];
		this.state.tabContents = new Map(tabs.map((t) => [t.id, t.content]));
		this.state.activeTabId = 'script';

		this.editorView.dispatch({ effects: this.languageCompartment.reconfigure(languageExtensionFor('script')) });
		this.setEditorText(this.state.tabContents.get('script') ?? '');
		this.updateModulePreviewWidget();

		// Prefill the URL with the embed's `url` attribute (first selection
		// only), else the example's first suggested URL (empty when none), and
		// offer the full set in the native URL select.
		const suggestedUrls = this.suggestedUrls ?? example?.suggestedUrls ?? [];
		this.populateUrlSuggestions(suggestedUrls);
		this.selectUrl(this.initialUrl ?? suggestedUrls[0] ?? '');
		this.initialUrl = null;

		this.clearResults();
		this.updateEditorStatus();
		this.updatePermissionsHint();
		this.updateRunButton();
	}

	// Resets the result state and clears every result pane, returning the widget
	// to showing the editor. Leaves the tab strip / editor status to its callers.
	private clearResults(): void {
		this.state.lastRun = null;
		this.state.activeResultTab = null;
		this.outputPaneEl.className = 'dwd-output-pane dwd-pane';
		this.resultsTitleEl.textContent = '';
		this.outputJsonEl.textContent = '';
		this.outputRenderedEl.removeAttribute('srcdoc');
		this.outputToggleEl.hidden = true;
		this.state.outputView = 'json';
		this.logsPaneEl.innerHTML = '';
		this.tracePaneEl.innerHTML = '';
		this.copyPromptStatusEl.textContent = '';
		this.timingInfoEl.textContent = '';
		this.renderOutputView();
		this.renderTabStrip();
		this.showActivePane();
	}

	// Restores every tab (not just the active one) to its pristine content.
	private onResetClick(): void {
		if (this.state.pristineTabs.length === 0) return;

		this.state.tabContents = new Map(this.state.pristineTabs.map((t) => [t.id, t.content]));
		this.setEditorText(this.state.tabContents.get(this.state.activeTabId) ?? '');
		this.updateEditorStatus();
		this.updateRunButton();
	}

	// Uses a native select for the curated targets. "Custom URL…" reveals the
	// editable field, preserving arbitrary input without rebuilding select UI.
	private populateUrlSuggestions(urls: ReadonlyArray<string>): void {
		this.urlSelect.innerHTML = '';
		for (const url of urls) {
			const option = document.createElement('option');
			option.value = url;
			option.textContent = url;
			this.urlSelect.appendChild(option);
		}

		const custom = document.createElement('option');
		custom.value = '__custom__';
		custom.textContent = 'Custom URL…';
		this.urlSelect.appendChild(custom);
	}

	private selectUrl(url: string): void {
		const isSuggestion = Array.from(this.urlSelect.options).some(
			(option) => option.value === url && option.value !== '__custom__',
		);
		this.urlSelect.value = isSuggestion ? url : '__custom__';
		this.urlInput.hidden = isSuggestion;
		this.urlInput.value = url;
	}

	private updateRunButton(): void {
		const hasUrl = this.urlInput.value.trim().length > 0;
		const scriptText = this.currentTabContents().get('script') ?? '';
		const hasCode = scriptText.trim().length > 0;
		this.runButton.disabled = !hasUrl || !hasCode || this.state.isRunning;
	}

	private async onRunClick(): Promise<void> {
		if (this.state.isRunning) return;

		this.state.isRunning = true;
		this.updateRunButton();

		const url = this.urlInput.value.trim();
		const payload: Record<string, unknown> = { url };

		if (!this.isDirty() && this.state.selectedExampleId) {
			payload.worker = { type: 'example', exampleId: this.state.selectedExampleId };
		} else {
			// A dirty/custom run must ship real module bytes, not the 1.5 KiB preview,
			// so load them here if the selected example has wasm tabs.
			const runExample = this.selectedExample();
			if (runExample && this.state.tabs.some((t) => t.kind === 'wasm')) {
				try {
					const modules = await ensureModules(runExample);
					this.applyLoadedModules(runExample.id, modules);
				} catch (error) {
					this.showRunError('module_load_failed', `Failed to load example modules: ${String(error)}`);
					this.state.isRunning = false;
					this.updateRunButton();
					return;
				}
			}

			const built = buildCustomRunPayload(this.state.tabs, this.currentTabContents());
			payload.worker = { type: 'custom', ...built, sourceExampleId: this.state.selectedExampleId ?? undefined };
			// A dirty run drops out of the example path, so the server no longer
			// sees the example's registered permissions — send them explicitly so
			// an edited example keeps the same capability grant it had when
			// pristine.
			const inherited = this.selectedExample()?.permissions;
			if (inherited) payload.permissions = inherited;
		}

		// A storage-scoped grant (pristine or inherited into a dirty run — either
		// way selectedExample()?.permissions is the effective grant, see
		// updatePermissionsHint) requires the server-validated storeId that
		// selects this visitor's supervisor DO.
		if (needsStoreId(this.selectedExample()?.permissions)) {
			payload.storeId = STORE_ID;
		}

		// Attach a Turnstile token if one is available (waits briefly for an
		// in-flight challenge; the widget was primed on first interaction).
		const token = await turnstileManager.getToken();
		if (token) payload.turnstileToken = token;

		try {
			const response = await fetch(`${API_PREFIX}/run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				this.showRunError('http_error', `HTTP ${response.status}: ${response.statusText}`);
				this.state.isRunning = false;
				this.updateRunButton();
				return;
			}

			const data = (await response.json()) as RunResponse;
			this.renderResults(data);

			// Tokens are single-use — reset for the next run (from any embed).
			turnstileManager.reset();
		} catch (error) {
			this.showRunError('network_error', `Network error: ${String(error)}`);
		}

		this.state.isRunning = false;
		this.updateRunButton();
	}

	// Builds a minimal error-shaped RunResponse for a client-side failure
	// (module load, non-ok HTTP, network catch) and renders it through the same
	// result panes a real run uses, so all three error paths behave identically.
	private showRunError(kind: string, message: string): void {
		this.renderResults({ ok: false, error: { kind, message }, logs: [], logsTruncated: false, timingMs: 0, inputTruncated: false });
	}

	// Fills the Output / Logs / Trace panes from a run response and focuses the
	// Output tab. Which result tabs actually appear is driven by state.lastRun
	// plus this embed's feature flags (see renderTabStrip / tabStripItems).
	private renderResults(data: RunResponse): void {
		this.state.lastRun = data;

		// Output pane: title + tone class, and the formatted value/error into
		// the JSON view via textContent — the security boundary that makes any
		// HTML/script in run output inert (AC6.1). Never innerHTML with run data.
		const formatted = formatRunResponse(data);
		this.outputPaneEl.className = `dwd-output-pane dwd-pane ${formatted.tone}`;
		this.resultsTitleEl.textContent = formatted.title;
		this.outputJsonEl.textContent = formatted.body;

		// Handle rendered HTML output if available; server-rendered HTML in a
		// sandboxed iframe.
		if (data.ok && typeof data.resultHtml === 'string') {
			this.outputRenderedEl.srcdoc = data.resultHtml;
			this.state.outputView = 'rendered';
			this.outputToggleEl.hidden = false;
		} else {
			this.outputRenderedEl.removeAttribute('srcdoc');
			this.state.outputView = 'json';
			this.outputToggleEl.hidden = true;
		}
		this.renderOutputView();

		// Logs pane (rendered even when the logs feature is off — cheap, inert,
		// and the tab just never appears).
		this.logsPaneEl.innerHTML = '';
		if (data.logs.length > 0) {
			for (const log of data.logs) {
				const logLine = document.createElement('div');
				logLine.className =
					'dwd-log-line ' + (log.level === 'error' ? 'dwd-log-error' : log.level === 'warn' ? 'dwd-log-warn' : 'dwd-log-info');
				logLine.textContent = log.level === 'error' || log.level === 'warn' ? `[${log.level}] ${log.message}` : log.message;
				this.logsPaneEl.appendChild(logLine);
			}
		} else {
			const empty = document.createElement('div');
			empty.className = 'dwd-logs-empty';
			empty.textContent = 'No logs';
			this.logsPaneEl.appendChild(empty);
		}

		if (data.logsTruncated) {
			const truncated = document.createElement('div');
			truncated.className = 'dwd-logs-truncated';
			truncated.textContent = 'Logs were truncated';
			this.logsPaneEl.appendChild(truncated);
		}

		if (data.inputTruncated) {
			const inputTruncatedWarning = document.createElement('div');
			inputTruncatedWarning.className = 'dwd-logs-truncated';
			inputTruncatedWarning.textContent = '⚠ Fetched page exceeded the 2 MiB cap and was truncated before the transform ran.';
			this.logsPaneEl.appendChild(inputTruncatedWarning);
		}

		// Trace pane.
		this.renderTrace(data.trace);

		// Timing → footer.
		this.timingInfoEl.textContent = typeof data.timingMs === 'number' ? `Execution time: ${data.timingMs}ms` : '';

		this.selectResultTab('output');
	}

	// Renders the waterfall trace rows straight into the trace pane, or nothing
	// when the response has no trace/spans (e.g. an older-shaped response). All
	// text goes through textContent/title — attrs (urls, error messages) are
	// untrusted, same discipline as the rest of renderResults.
	private renderTrace(trace: Trace | undefined): void {
		this.tracePaneEl.innerHTML = '';
		if (!trace || trace.spans.length === 0) return;

		const rows = buildTraceLayout(trace.spans, trace.totalMs);

		const rowsContainer = document.createElement('div');
		rowsContainer.className = 'dwd-trace-rows';

		const axisEl = document.createElement('div');
		axisEl.className = 'dwd-trace-axis';

		const axisLabelSpacer = document.createElement('div');
		axisLabelSpacer.className = 'dwd-trace-axis-label';
		axisEl.appendChild(axisLabelSpacer);

		const axisTrackEl = document.createElement('div');
		axisTrackEl.className = 'dwd-trace-axis-track';
		for (const tick of buildTraceAxisTicks(trace.totalMs)) {
			const tickEl = document.createElement('span');
			tickEl.className = `dwd-trace-axis-tick dwd-trace-axis-tick-${tick.align}`;
			tickEl.style.left = `${tick.leftPct}%`;
			tickEl.textContent = tick.label;
			axisTrackEl.appendChild(tickEl);
		}
		axisEl.appendChild(axisTrackEl);

		const durationHeadingEl = document.createElement('span');
		durationHeadingEl.className = 'dwd-trace-duration-heading';
		durationHeadingEl.textContent = 'Duration';
		axisEl.appendChild(durationHeadingEl);
		rowsContainer.appendChild(axisEl);

		for (const row of rows) {
			const rowEl = document.createElement('div');
			rowEl.className = `dwd-trace-row dwd-trace-row-${row.tone}`;
			rowEl.title = row.detail;

			const labelEl = document.createElement('span');
			labelEl.className = 'dwd-trace-label';
			for (let depth = 0; depth < row.depthLevel; depth++) {
				const guideEl = document.createElement('span');
				guideEl.className = 'dwd-trace-guide';
				guideEl.setAttribute('aria-hidden', 'true');
				labelEl.appendChild(guideEl);
			}
			const labelTextEl = document.createElement('span');
			labelTextEl.className = 'dwd-trace-label-text';
			labelTextEl.textContent = row.label;
			labelEl.appendChild(labelTextEl);
			rowEl.appendChild(labelEl);

			const trackEl = document.createElement('div');
			trackEl.className = 'dwd-trace-track';

			const barEl = document.createElement('div');
			barEl.className = `dwd-trace-bar dwd-trace-bar-${row.tone}`;
			barEl.style.left = `${row.leftPct}%`;
			barEl.style.width = `${row.widthPct}%`;
			trackEl.appendChild(barEl);

			rowEl.appendChild(trackEl);

			const durationEl = document.createElement('span');
			durationEl.className = 'dwd-trace-duration';
			durationEl.textContent = row.durationLabel;
			rowEl.appendChild(durationEl);
			rowsContainer.appendChild(rowEl);
		}

		this.tracePaneEl.appendChild(rowsContainer);
	}
}

// Switches per-tab editor config (language support) without recreating the
// EditorView: the script tab keeps TS-aware `javascript()`; a wasm tab (edited
// as base64 text) gets no language extension plus line wrapping, since it has
// no meaningful syntax to highlight and is typically one long unwrapped line.
function languageExtensionFor(kind: EditorTab['kind']): Extension[] {
	return kind === 'script' ? [javascript({ typescript: true })] : [EditorView.lineWrapping];
}
