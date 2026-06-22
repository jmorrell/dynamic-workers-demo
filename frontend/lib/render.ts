// pattern: Functional Core

type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
};

type RunResponseOk = {
	readonly ok: true;
	readonly result: unknown;
	readonly logs: ReadonlyArray<{readonly level: string; readonly message: string}>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
};

type RunResponseError = {
	readonly ok: false;
	readonly error: {readonly kind: string; readonly message: string};
	readonly logs: ReadonlyArray<{readonly level: string; readonly message: string}>;
	readonly logsTruncated: boolean;
	readonly timingMs: number;
};

type RunResponse = RunResponseOk | RunResponseError;

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
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function formatResultValue(value: unknown): string {
	try {
		const stringified = JSON.stringify(value, null, 2);
		return stringified === undefined ? 'undefined' : stringified;
	} catch {
		return String(value);
	}
}

export function formatRunResponse(resp: RunResponse): FormatRunResponseResult {
	if (resp.ok) {
		return {
			title: 'Success',
			body: escapeHtml(formatResultValue(resp.result)),
			tone: 'ok',
		};
	}

	const errorBody = escapeHtml(`${resp.error.kind}: ${resp.error.message}`);
	return {
		title: 'Error',
		body: errorBody,
		tone: 'error',
	};
}

export function exampleOptions(examples: ReadonlyArray<Example>): Array<ExampleOption> {
	return examples.map(ex => ({
		id: ex.id,
		title: ex.title,
	}));
}
