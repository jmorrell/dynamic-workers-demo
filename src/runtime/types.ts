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

export type RunErrorKind =
	| 'transform_threw'
	| 'network_blocked'
	| 'cpu_exceeded'
	| 'loader_failed'
	| 'no_transform'
	| 'rate_limited'
	| 'turnstile_failed'
	| 'bad_request';

export type RunError = {
	kind: RunErrorKind;
	message: string;
};

/**
 * Host fetch outcome before loader invocation. Note: `fetch_failed` is a
 * pre-loader kind specific to FetchOutcome and is intentionally NOT part of
 * RunErrorKind — but the /api/run response surfaces it in the same `error` slot,
 * so a consumer reading `error.kind` may also see `fetch_failed`.
 */
export type FetchOutcome = { ok: true; input: RunInput } | { ok: false; error: { kind: 'fetch_failed'; message: string } };
