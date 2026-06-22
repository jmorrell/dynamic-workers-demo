// pattern: Imperative Shell

import { escapeHtml, formatRunResponse, exampleOptions } from './lib/render';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';

type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
	readonly code: string;
};

interface State {
	examples: Array<Example>;
	selectedExampleId: string | null;
	isCustomCode: boolean;
	isRunning: boolean;
}

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
		editorDiv.textContent = '// Select an example or enable custom code to start';
		suggestedUrlsSection.style.display = 'none';
	}

	updateRunButton();
}

function displayExampleCode(example: Example): void {
	editorDiv.textContent = example.source;
	highlightEditorContent();
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
		editorDiv.textContent =
			'// Write your custom code here\nfetch("https://example.com")\n\t.then(r => r.text())\n\t.catch(e => e.message)';
		highlightEditorContent();
		suggestedUrlsSection.style.display = 'none';
	} else {
		editorDiv.textContent = '// Select an example or enable custom code to start';
		highlightEditorContent();
	}

	updateRunButton();
}

function highlightEditorContent(): void {
	if (!editorDiv.textContent) return;
	const highlighted = Prism.highlight(editorDiv.textContent, Prism.languages.javascript, 'javascript');
	editorDiv.innerHTML = highlighted;
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
		payload.customCode = editorDiv.textContent;
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
			resultsBodyEl.textContent = escapeHtml(`HTTP ${response.status}: ${response.statusText}`);
			logsContainerEl.innerHTML = '';
			timingInfoEl.innerHTML = '';
			resultsSection.classList.remove('empty');
			state.isRunning = false;
			updateRunButton();
			return;
		}

		const data = await response.json();
		renderResults(data);
	} catch (error) {
		resultsSection.className = 'error';
		resultsTitleEl.textContent = 'Error';
		resultsBodyEl.textContent = escapeHtml(`Network error: ${String(error)}`);
		logsContainerEl.innerHTML = '';
		timingInfoEl.innerHTML = '';
		resultsSection.classList.remove('empty');
	}

	state.isRunning = false;
	updateRunButton();
}

function renderResults(data: unknown): void {
	const formatted = formatRunResponse(data as any);

	resultsSection.className = formatted.tone;
	resultsTitleEl.textContent = formatted.title;
	resultsBodyEl.innerHTML = '';

	// Main result body (already escaped by formatRunResponse)
	const bodyPre = document.createElement('pre');
	bodyPre.textContent = formatted.body;
	resultsBodyEl.appendChild(bodyPre);

	// Logs
	logsContainerEl.innerHTML = '';
	const runData = data as any;
	if (runData.logs && Array.isArray(runData.logs)) {
		if (runData.logs.length > 0) {
			const logsLabel = document.createElement('strong');
			logsLabel.textContent = 'Logs:';
			logsContainerEl.appendChild(logsLabel);

			for (const log of runData.logs) {
				const logLine = document.createElement('div');
				logLine.style.color = log.level === 'error' ? '#c00' : log.level === 'warn' ? '#d70' : '#666';
				logLine.textContent = escapeHtml(`[${log.level}] ${log.message}`);
				logsContainerEl.appendChild(logLine);
			}
		}

		if (runData.logsTruncated) {
			const truncated = document.createElement('div');
			truncated.className = 'logs-truncated';
			truncated.textContent = 'Logs were truncated';
			logsContainerEl.appendChild(truncated);
		}
	}

	// Timing info
	timingInfoEl.innerHTML = '';
	if (typeof runData.timingMs === 'number') {
		const timing = document.createElement('div');
		timing.className = 'timing';
		timing.textContent = escapeHtml(`Execution time: ${runData.timingMs}ms`);
		timingInfoEl.appendChild(timing);
	}

	resultsSection.classList.remove('empty');
}
