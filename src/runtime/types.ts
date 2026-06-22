/** Pre-fetched page snapshot handed to untrusted code as the run() argument. */
export type RunInput = {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	body: string;
	truncated: boolean;
};

/** Structured result returned by the harness over RPC. */
export type RunResult = { ok: true; value: unknown } | { ok: false; error: RunError };

export type RunErrorKind = 'transform_threw' | 'network_blocked' | 'cpu_exceeded' | 'loader_failed' | 'no_transform';

export type RunError = {
	kind: RunErrorKind;
	message: string;
};

/** Host fetch outcome before loader invocation. */
export type FetchOutcome = { ok: true; input: RunInput } | { ok: false; error: { kind: 'fetch_failed'; message: string } };
