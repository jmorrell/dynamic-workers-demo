// pattern: Imperative Shell

import { formatRunResponse, exampleOptions, type RunResponse, type Example } from './lib/render';
import { CodeJar } from 'codejar';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';

// Module-singleton UI state; fields are mutated in place by the event handlers
// below (intentional for this thin imperative shell).
type State = {
	examples: Array<Example>;
	selectedExampleId: string | null;
	isCustomCode: boolean;
	isRunning: boolean;
};

const state: State = {
	examples: [],
	selectedExampleId: null,
	isCustomCode: false,
	isRunning: false,
};

// DOM element references
const exampleSelect = document.getElementById('example') as HTMLSelectElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const customCodeToggle = document.getElementById('custom-code-toggle') as HTMLInputElement;
const editorDiv = document.getElementById('editor') as HTMLDivElement;
const runButton = document.getElementById('run-button') as HTMLButtonElement;
const resultsSection = document.getElementById('results') as HTMLDivElement;
const resultsTitleEl = document.getElementById('results-title') as HTMLDivElement;
const resultsBodyEl = document.getElementById('results-body') as HTMLDivElement;
const logsContainerEl = document.getElementById('logs-container') as HTMLDivElement;
const timingInfoEl = document.getElementById('timing-info') as HTMLDivElement;
const suggestedUrlsSection = document.getElementById('suggested-urls-section') as HTMLDivElement;
const suggestedUrlsEl = document.getElementById('suggested-urls') as HTMLDivElement;

// CodeJar turns the editor div into an editable, syntax-highlighted code field
// with cursor preservation across re-highlights. setEditorCode() toggles between
// read-only (example source display) and editable (custom code).
const jar = CodeJar(editorDiv, (el) => {
	const code = el.textContent ?? '';
	el.innerHTML = Prism.highlight(code, Prism.languages.javascript, 'javascript');
});

function setEditorCode(code: string, editable: boolean): void {
	jar.updateCode(code);
	editorDiv.setAttribute('contenteditable', editable ? 'true' : 'false');
	editorDiv.classList.toggle('editable', editable);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
	await loadExamples();
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
	} catch (error) {
		console.error('Error loading examples:', error);
	}
}

function setupEventListeners(): void {
	exampleSelect.addEventListener('change', onExampleSelectChange);
	customCodeToggle.addEventListener('change', onCustomCodeToggleChange);
	runButton.addEventListener('click', onRunClick);
	urlInput.addEventListener('input', updateRunButton);
}

function onExampleSelectChange(): void {
	const selectedId = exampleSelect.value;
	state.selectedExampleId = selectedId || null;
	state.isCustomCode = false;
	customCodeToggle.checked = false;

	if (selectedId) {
		const example = state.examples.find((ex) => ex.id === selectedId);
		if (example) {
			displayExampleCode(example);
			displaySuggestedUrls(example.suggestedUrls);
		}
	} else {
		setEditorCode('// Select an example or enable custom code to start', false);
		suggestedUrlsSection.style.display = 'none';
	}

	updateRunButton();
}

function displayExampleCode(example: Example): void {
	// Example source is shown read-only; running an example sends its exampleId
	// (the bundled code), not the displayed source.
	setEditorCode(example.source, false);
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

function onCustomCodeToggleChange(): void {
	state.isCustomCode = customCodeToggle.checked;
	state.selectedExampleId = null;
	exampleSelect.value = '';

	if (state.isCustomCode) {
		setEditorCode('// Write your custom code here\nexport default (input) => {\n\treturn input.status;\n}', true);
		suggestedUrlsSection.style.display = 'none';
	} else {
		setEditorCode('// Select an example or enable custom code to start', false);
	}

	updateRunButton();
}

function updateRunButton(): void {
	const hasUrl = urlInput.value.trim().length > 0;
	const hasCodeSelection = state.selectedExampleId !== null || state.isCustomCode;
	runButton.disabled = !hasUrl || !hasCodeSelection || state.isRunning;
}

async function onRunClick(): Promise<void> {
	if (state.isRunning) return;

	state.isRunning = true;
	updateRunButton();

	const url = urlInput.value.trim();
	const payload: Record<string, unknown> = { url };

	if (state.isCustomCode) {
		payload.customCode = jar.toString();
	} else if (state.selectedExampleId) {
		payload.exampleId = state.selectedExampleId;
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
