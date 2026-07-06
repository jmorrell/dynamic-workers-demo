// pattern: Imperative Shell

import { formatRunResponse, exampleOptions, type RunResponse, type Example } from './lib/render';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { indentUnit } from '@codemirror/language';

const PLACEHOLDER_CODE = '// Select an example to start (or edit it — edits run as custom code)';

// Module-singleton UI state; fields are mutated in place by the event handlers
// below (intentional for this thin imperative shell).
type State = {
	examples: Array<Example>;
	selectedExampleId: string | null;
	isRunning: boolean;
	turnstileWidgetId: string | null;
	turnstileReady: boolean;
};

const state: State = {
	examples: [],
	selectedExampleId: null,
	isRunning: false,
	turnstileWidgetId: null,
	turnstileReady: false,
};

// DOM element references
const exampleSelect = document.getElementById('example') as HTMLSelectElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const editorContainer = document.getElementById('editor') as HTMLDivElement;
const editorStatusEl = document.getElementById('editor-status') as HTMLSpanElement;
const editorResetButton = document.getElementById('editor-reset') as HTMLButtonElement;
const runButton = document.getElementById('run-button') as HTMLButtonElement;
const resultsSection = document.getElementById('results') as HTMLDivElement;
const resultsTitleEl = document.getElementById('results-title') as HTMLDivElement;
const resultsBodyEl = document.getElementById('results-body') as HTMLDivElement;
const logsContainerEl = document.getElementById('logs-container') as HTMLDivElement;
const timingInfoEl = document.getElementById('timing-info') as HTMLDivElement;
const suggestedUrlsSection = document.getElementById('suggested-urls-section') as HTMLDivElement;
const suggestedUrlsEl = document.getElementById('suggested-urls') as HTMLDivElement;
const turnstileDiv = document.getElementById('turnstile') as HTMLDivElement;

// Single always-editable CodeMirror instance. Pristine example code runs by
// exampleId (pre-bundled server-side); any edit makes the doc "dirty" and it
// runs as custom code (transpiled from TS server-side — see isDirty()).
const editorView = new EditorView({
	doc: PLACEHOLDER_CODE,
	parent: editorContainer,
	extensions: [
		basicSetup,
		keymap.of([indentWithTab]),
		javascript({ typescript: true }),
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

// "Dirty" means the doc no longer matches the selected example's pristine
// source (or there's no selected example at all) — either way, a run must
// go through the custom-code path rather than by exampleId.
function isDirty(): boolean {
	const example = selectedExample();
	if (!example) return true;
	return editorText() !== example.source;
}

function updateEditorStatus(): void {
	const dirty = isDirty();
	editorStatusEl.style.display = dirty && state.selectedExampleId ? 'inline' : 'none';
	editorResetButton.style.display = dirty && state.selectedExampleId ? 'inline-block' : 'none';
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
}

function selectExample(selectedId: string | null): void {
	state.selectedExampleId = selectedId;

	if (selectedId) {
		const example = state.examples.find((ex) => ex.id === selectedId);
		if (example) {
			setEditorText(example.source);
			displaySuggestedUrls(example.suggestedUrls);
		}
	} else {
		setEditorText(PLACEHOLDER_CODE);
		suggestedUrlsSection.style.display = 'none';
	}

	updateEditorStatus();
	updateRunButton();
}

function onResetClick(): void {
	const example = selectedExample();
	if (example) setEditorText(example.source);
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
	const hasCode = editorText().trim().length > 0;
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
		payload.worker = { type: 'custom', customCode: editorText() };
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

	resultsSection.classList.remove('empty');
}
