// Widget stylesheet, injected once per page (light DOM — scoped by the
// `dynamic-workers-demo` element selector and a `dwd-` class prefix, so
// nothing leaks into the blog and vice versa). The editor and tabs share the
// visual language of the blog's CodeTabs component; controls use the blog's
// stone palette, with dark mode keyed off the `dark` class on <html>.

const STYLE_ID = 'dwd-widget-styles';

const WIDGET_CSS = /* css */ `
dynamic-workers-demo {
	--dwd-border: #e7e5e4;
	--dwd-border-soft: #f5f5f4;
	--dwd-bg: #ffffff;
	--dwd-bg-inset: #fafaf9;
	--dwd-bg-hover: #f5f5f4;
	--dwd-text: rgba(0, 0, 0, 0.85);
	--dwd-text-muted: #78716c;
	--dwd-accent: #1d4ed8;
	--dwd-accent-contrast: #ffffff;
	--dwd-ok: #15803d;
	--dwd-error: #b91c1c;
	--dwd-warn-bg: #fefce8;
	--dwd-warn-border: #e4c88f;
	--dwd-code-bg: #24292e;
	--dwd-code-tabs-bg: #1c1917;
	--dwd-code-text: #e1e4e8;
	--dwd-code-muted: #a8a29e;
	--dwd-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;

	display: flex;
	flex-direction: column;
	gap: 0;
	height: 26rem;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--dwd-text);
	font-size: 0.875rem;
	line-height: 1.5;
}

html.dark dynamic-workers-demo {
	--dwd-border: #44403c;
	--dwd-border-soft: #3a3532;
	--dwd-bg: #292524;
	--dwd-bg-inset: #1f1c1b;
	--dwd-bg-hover: #33302e;
	--dwd-text: rgba(255, 255, 255, 0.85);
	--dwd-text-muted: #a8a29e;
	--dwd-accent: #60a5fa;
	--dwd-accent-contrast: #1c1917;
	--dwd-ok: #4ade80;
	--dwd-error: #f87171;
	--dwd-warn-bg: #3a3320;
	--dwd-warn-border: #7a6a35;
}

dynamic-workers-demo *,
dynamic-workers-demo *::before,
dynamic-workers-demo *::after {
	box-sizing: border-box;
}

dynamic-workers-demo [hidden] {
	display: none !important;
}

/* --- controls ------------------------------------------------------------ */

dynamic-workers-demo select,
dynamic-workers-demo input[type='text'],
dynamic-workers-demo input[type='url'] {
	padding: 0.375rem 0.5rem;
	font: inherit;
	font-size: 0.8125rem;
	color: var(--dwd-text);
	border: 1px solid var(--dwd-border);
	border-radius: 0.5rem;
	background: var(--dwd-bg);
}

dynamic-workers-demo .dwd-topbar,
dynamic-workers-demo .dwd-url-row,
dynamic-workers-demo .dwd-footer {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	align-items: center;
	flex: 0 0 auto;
}

dynamic-workers-demo .dwd-topbar {
	margin-bottom: 0.5rem;
}

dynamic-workers-demo .dwd-example-description {
	flex: 1 0 100%;
	margin: 0;
	color: var(--dwd-text-muted);
	font-size: 0.8125rem;
	line-height: 1.4;
}

dynamic-workers-demo .dwd-url-row {
	margin-bottom: 0.75rem;
}

dynamic-workers-demo .dwd-example-select,
dynamic-workers-demo .dwd-url-select {
	flex: 0 1 auto;
	max-width: 100%;
	padding-right: 2rem;
	appearance: none;
	background-image:
		linear-gradient(45deg, transparent 50%, currentColor 50%),
		linear-gradient(135deg, currentColor 50%, transparent 50%);
	background-position:
		calc(100% - 0.9rem) 50%,
		calc(100% - 0.65rem) 50%;
	background-repeat: no-repeat;
	background-size: 0.3rem 0.3rem;
}

dynamic-workers-demo .dwd-url-select {
	flex: 1 1 200px;
	min-width: 0;
	font-family: var(--dwd-mono);
}

dynamic-workers-demo .dwd-url-row:has(.dwd-url:not([hidden]))
	.dwd-url-select {
	flex-grow: 0;
}

dynamic-workers-demo .dwd-url {
	flex: 1 1 200px;
	min-width: 0;
	font-family: var(--dwd-mono);
}

dynamic-workers-demo select:focus-visible,
dynamic-workers-demo input:focus-visible {
	border-color: var(--dwd-accent);
	outline: 2px solid var(--dwd-accent);
	outline-offset: 1px;
}

dynamic-workers-demo button {
	padding: 0.375rem 1rem;
	background: var(--dwd-accent);
	color: var(--dwd-accent-contrast);
	border: none;
	border-radius: 0.5rem;
	cursor: pointer;
	font: inherit;
	font-size: 0.8125rem;
	font-weight: 600;
	transition: filter 0.15s;
}

dynamic-workers-demo button:hover:not(:disabled) {
	filter: brightness(1.1);
}

dynamic-workers-demo button:disabled {
	background: var(--dwd-border);
	color: var(--dwd-text-muted);
	cursor: not-allowed;
}

dynamic-workers-demo .dwd-run {
	flex: 0 0 auto;
}

/* --- permissions strip ---------------------------------------------------- */

dynamic-workers-demo .dwd-perms {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.375rem;
}

dynamic-workers-demo .dwd-perm-caption {
	font-size: 0.75rem;
	font-weight: 600;
	color: var(--dwd-text-muted);
}

dynamic-workers-demo .dwd-perm-badge {
	padding: 0.125rem 0.5rem;
	border-radius: 999px;
	font-size: 0.6875rem;
	border: 1px solid;
	cursor: default;
	white-space: nowrap;
}

dynamic-workers-demo .dwd-perm-badge-net {
	background: #e7f1fb;
	border-color: #9dc3ea;
	color: #0b4f8f;
}

dynamic-workers-demo .dwd-perm-badge-storage {
	background: #eee9fa;
	border-color: #bbaae5;
	color: #4b3391;
}

dynamic-workers-demo .dwd-perm-badge-limit {
	background: #fdf3e3;
	border-color: #e4c88f;
	color: #7a5308;
}

dynamic-workers-demo .dwd-perm-badge-none {
	background: #eef4ee;
	border-color: #a9c8a9;
	color: #2c5f2c;
}

html.dark dynamic-workers-demo .dwd-perm-badge-net {
	background: #172a3f;
	border-color: #2e5f8f;
	color: #8fc1ef;
}

html.dark dynamic-workers-demo .dwd-perm-badge-storage {
	background: #261d3f;
	border-color: #55418f;
	color: #c3b2f2;
}

html.dark dynamic-workers-demo .dwd-perm-badge-limit {
	background: #3a2f16;
	border-color: #8a6f2f;
	color: #eecf8a;
}

html.dark dynamic-workers-demo .dwd-perm-badge-none {
	background: #1c2b1c;
	border-color: #3f6a3f;
	color: #a4d4a4;
}

/* --- tab strip ------------------------------------------------------------ */

dynamic-workers-demo .dwd-tab-strip {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	overflow-x: auto;
	flex: 0 0 auto;
	min-height: 2.4rem;
	background: var(--dwd-code-tabs-bg);
}

dynamic-workers-demo .dwd-tab-strip-tabs {
	display: flex;
	align-items: center;
	gap: 0.125rem;
	flex: 1 1 auto;
}

dynamic-workers-demo .dwd-tab {
	padding: 0.55rem 0.8rem 0.65rem;
	background: transparent;
	border: 0;
	border-radius: 0;
	cursor: pointer;
	font-size: 0.75rem;
	font-weight: 400;
	font-family: var(--dwd-mono);
	line-height: 1.25rem;
	color: var(--dwd-code-muted);
	white-space: nowrap;
	transition: none;
}

dynamic-workers-demo .dwd-tab:first-child {
	border-top-left-radius: 0.5rem;
}

dynamic-workers-demo .dwd-tab:last-child {
	border-top-right-radius: 0.5rem;
}

dynamic-workers-demo .dwd-tab:hover:not(:disabled) {
	background: rgb(255 255 255 / 0.05);
	color: #f5f5f4;
	filter: none;
}

dynamic-workers-demo .dwd-tab.active {
	background: var(--dwd-code-bg);
	color: #ffffff;
	font-weight: 400;
}

dynamic-workers-demo .dwd-editor-status {
	font-size: 0.75rem;
	font-style: italic;
	color: #e0a94f;
	white-space: nowrap;
}

dynamic-workers-demo .dwd-reset {
	padding: 0.125rem 0.625rem;
	font-size: 0.75rem;
	font-weight: 400;
	flex: 0 0 auto;
	margin-right: 0.5rem;
	background: rgb(255 255 255 / 0.08);
	color: var(--dwd-code-text);
	border: 0;
}

/* --- panes ----------------------------------------------------------------- */

dynamic-workers-demo .dwd-pane-host {
	flex: 1 1 auto;
	min-height: 0;
	position: relative;
	overflow: hidden;
	border-radius: 0 0 0.5rem 0.5rem;
	background: var(--dwd-code-bg);
	box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}

dynamic-workers-demo .dwd-pane {
	height: 100%;
	overflow: auto;
	background: var(--dwd-code-bg);
	color: var(--dwd-code-text);
	border: 0;
	border-radius: 0 0 0.5rem 0.5rem;
}

dynamic-workers-demo .dwd-editor {
	height: 100%;
}

dynamic-workers-demo .cm-editor {
	height: 100%;
	font-family: var(--dwd-mono);
	font-size: 13px;
	border-radius: 0 0 0.5rem 0.5rem;
}

dynamic-workers-demo .cm-editor.cm-focused {
	outline: 2px solid color-mix(in srgb, var(--dwd-accent) 25%, transparent);
}

dynamic-workers-demo .dwd-load-full-module {
	padding: 0.75rem 0.5rem 1rem;
	text-align: center;
}

dynamic-workers-demo .dwd-load-full-module button {
	color: var(--dwd-code-text);
	background: rgb(255 255 255 / 0.08);
	border: 1px solid rgb(255 255 255 / 0.16);
}

dynamic-workers-demo .cm-scroller {
	overflow: auto;
}

/* --- LLM prompt pane -------------------------------------------------------- */

dynamic-workers-demo .dwd-prompt-pane {
	display: flex;
	flex-direction: column;
	padding: 0;
}

dynamic-workers-demo .dwd-prompt-toolbar {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 0.625rem;
	padding: 0.5rem 0.75rem;
	border-bottom: 1px solid rgb(255 255 255 / 0.1);
	color: var(--dwd-code-muted);
	font-size: 0.75rem;
}

dynamic-workers-demo .dwd-copy-prompt {
	margin-left: auto;
	flex: 0 0 auto;
	padding: 0.2rem 0.625rem;
	background: rgb(255 255 255 / 0.08);
	color: var(--dwd-code-text);
	border: 1px solid rgb(255 255 255 / 0.16);
	font-size: 0.75rem;
	font-weight: 400;
}

dynamic-workers-demo .dwd-copy-prompt-status {
	min-width: 3.5rem;
	color: var(--dwd-code-muted);
	font-size: 0.75rem;
}

dynamic-workers-demo .dwd-prompt-text {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	margin: 0;
	padding: 0.75rem;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--dwd-mono);
	font-size: 0.75rem;
	line-height: 1.5;
}

/* --- output pane ------------------------------------------------------------ */

dynamic-workers-demo .dwd-output-pane {
	display: flex;
	flex-direction: column;
	padding: 0;
}

dynamic-workers-demo .dwd-output-toolbar {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.5rem 0.75rem;
	border-bottom: 1px solid rgb(255 255 255 / 0.1);
}

dynamic-workers-demo .dwd-results-title {
	font-size: 0.875rem;
	font-weight: 600;
	color: var(--dwd-accent);
}

dynamic-workers-demo .dwd-output-pane.error .dwd-results-title {
	color: var(--dwd-error);
}

dynamic-workers-demo .dwd-output-pane.ok .dwd-results-title {
	color: var(--dwd-ok);
}

dynamic-workers-demo .dwd-output-toggle {
	margin-left: auto;
	display: flex;
	gap: 0.25rem;
}

dynamic-workers-demo .dwd-output-toggle button {
	padding: 0.125rem 0.625rem;
	font-size: 0.75rem;
	font-weight: 400;
	background: var(--dwd-bg-inset);
	color: var(--dwd-text);
	border: 1px solid var(--dwd-border);
}

dynamic-workers-demo .dwd-output-toggle button.active {
	background: var(--dwd-accent);
	color: var(--dwd-accent-contrast);
	border-color: var(--dwd-accent);
}

dynamic-workers-demo .dwd-output-rendered {
	flex: 1 1 auto;
	min-height: 0;
	width: 100%;
	height: 100%;
	border: 0;
	/* The srcdoc document styles itself; keep a light backdrop either way. */
	background: #ffffff;
}

dynamic-workers-demo .dwd-output-json {
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	margin: 0;
	background: var(--dwd-code-bg);
	color: var(--dwd-code-text);
	padding: 0.5rem 0.75rem;
	white-space: pre-wrap;
	word-wrap: break-word;
	font-family: var(--dwd-mono);
	font-size: 0.75rem;
}

/* --- logs & trace panes ------------------------------------------------------ */

dynamic-workers-demo .dwd-logs-pane {
	padding: 0.25rem 0.75rem;
	font-size: 0.8125rem;
	line-height: 1.5;
}

dynamic-workers-demo .dwd-log-line {
	padding: 0.4rem 0;
	border-bottom: 1px solid color-mix(in srgb, var(--dwd-border) 55%, transparent);
}

dynamic-workers-demo .dwd-trace-pane {
	padding: 0.75rem;
	font-size: 0.75rem;
}

dynamic-workers-demo .dwd-log-info {
	color: var(--dwd-text);
}

dynamic-workers-demo .dwd-log-warn {
	color: #b45309;
}

html.dark dynamic-workers-demo .dwd-log-warn {
	color: #fbbf24;
}

dynamic-workers-demo .dwd-log-error {
	color: var(--dwd-error);
}

dynamic-workers-demo .dwd-logs-empty {
	color: var(--dwd-text-muted);
	font-style: italic;
}

dynamic-workers-demo .dwd-logs-truncated {
	background: var(--dwd-warn-bg);
	border: 1px solid var(--dwd-warn-border);
	border-radius: 0.5rem;
	padding: 0.5rem;
	margin-top: 0.5rem;
	color: var(--dwd-text-muted);
	font-size: 0.75rem;
}

dynamic-workers-demo .dwd-trace-rows {
	--dwd-trace-grid: minmax(12rem, 28%) minmax(12rem, 1fr) 4.5rem;
	min-width: 36rem;
	font-family: var(--dwd-mono);
}

dynamic-workers-demo .dwd-trace-axis,
dynamic-workers-demo .dwd-trace-row {
	display: grid;
	grid-template-columns: var(--dwd-trace-grid);
	align-items: center;
	column-gap: 0.75rem;
}

dynamic-workers-demo .dwd-trace-axis {
	padding-bottom: 0.45rem;
	margin-bottom: 0.2rem;
	color: var(--dwd-code-muted);
	font-size: 0.625rem;
}

dynamic-workers-demo .dwd-trace-axis-track {
	position: relative;
	height: 1.35rem;
	border-bottom: 1px solid rgb(255 255 255 / 0.16);
}

dynamic-workers-demo .dwd-trace-axis-tick {
	position: absolute;
	top: 0;
	white-space: nowrap;
}

dynamic-workers-demo .dwd-trace-axis-tick::after {
	position: absolute;
	top: 1rem;
	left: 50%;
	width: 1px;
	height: 0.35rem;
	background: rgb(255 255 255 / 0.2);
	content: '';
}

dynamic-workers-demo .dwd-trace-axis-tick-start {
	transform: translateX(0);
}

dynamic-workers-demo .dwd-trace-axis-tick-start::after {
	left: 0;
}

dynamic-workers-demo .dwd-trace-axis-tick-middle {
	transform: translateX(-50%);
}

dynamic-workers-demo .dwd-trace-axis-tick-end {
	transform: translateX(-100%);
}

dynamic-workers-demo .dwd-trace-axis-tick-end::after {
	left: 100%;
}

dynamic-workers-demo .dwd-trace-duration-heading {
	text-align: right;
}

dynamic-workers-demo .dwd-trace-row {
	min-height: 24px;
	padding: 2px 0;
}

dynamic-workers-demo .dwd-trace-label {
	display: flex;
	align-items: stretch;
	min-width: 0;
	height: 20px;
	line-height: 20px;
	font-size: 0.75rem;
	color: var(--dwd-code-muted);
}

dynamic-workers-demo .dwd-trace-guide {
	flex: 0 0 0.8rem;
	margin-left: 0.15rem;
	border-left: 1px solid rgb(255 255 255 / 0.13);
}

dynamic-workers-demo .dwd-trace-label-text {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

dynamic-workers-demo .dwd-trace-row-phase .dwd-trace-label,
dynamic-workers-demo .dwd-trace-row-phase .dwd-trace-duration {
	opacity: 0.72;
}

dynamic-workers-demo .dwd-trace-track {
	position: relative;
	min-width: 0;
	height: 8px;
	background: rgb(255 255 255 / 0.055);
	border-radius: 2px;
}

dynamic-workers-demo .dwd-trace-bar {
	position: absolute;
	top: 0;
	height: 100%;
	border-radius: 2px;
}

dynamic-workers-demo .dwd-trace-bar-ok {
	background: #2f7de1;
}

dynamic-workers-demo .dwd-trace-bar-error {
	background: var(--dwd-error);
}

dynamic-workers-demo .dwd-trace-bar-phase {
	background: var(--dwd-code-muted);
	opacity: 0.52;
}

dynamic-workers-demo .dwd-trace-duration {
	font-size: 0.6875rem;
	color: var(--dwd-code-muted);
	text-align: right;
	white-space: nowrap;
}

/* --- footer ------------------------------------------------------------------ */

dynamic-workers-demo .dwd-footer {
	margin-top: 0.5rem;
	font-size: 0.75rem;
	color: var(--dwd-text-muted);
}

dynamic-workers-demo .dwd-clear-store {
	padding: 0.125rem 0.625rem;
	font-size: 0.75rem;
	font-weight: 400;
	background: var(--dwd-bg-inset);
	color: var(--dwd-text);
	border: 1px solid var(--dwd-border);
}

dynamic-workers-demo .dwd-timing {
	margin-left: auto;
}
`;

// Idempotent; every instance calls it, the first wins.
export function ensureStylesInjected(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = WIDGET_CSS;
	document.head.appendChild(style);
}
