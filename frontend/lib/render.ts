// pattern: Functional Core

export type Permissions = {
	readonly fetch: 'page-links' | 'none';
	readonly cpuMs?: number;
};

export type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
	readonly permissions?: Permissions;
};

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
