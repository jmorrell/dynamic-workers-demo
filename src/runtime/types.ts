/** Pre-fetched page snapshot handed to untrusted code as the run() argument. */
export type RunInput = {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	responseHeaders: Map<string, string>;
	body: string;
	truncated: boolean;
};

export type UserWorker = { type: 'custom'; customCode: string } | { type: 'example'; exampleId: string };

export type RunRequestBody = {
	url: string;
	worker: UserWorker;
	turnstileToken?: string;
};

/** Structured result returned by the harness over RPC. */
export type RunResult = { type: 'success'; value: unknown } | { type: 'failure'; error: RunError };

export type RunErrorKind =
	| 'transform_threw'
	| 'network_blocked'
	| 'cpu_exceeded'
	| 'loader_failed'
	| 'no_transform'
	| 'rate_limited'
	| 'turnstile_failed'
	| 'bad_request'
	| 'fetch_failed'
	| 'compile_failed';

export type RunError = {
	kind: RunErrorKind;
	message: string;
};

/** Host fetch outcome before loader invocation. */
export type FetchOutcome = { type: 'success'; input: RunInput } | { type: 'failure'; error: RunError };
