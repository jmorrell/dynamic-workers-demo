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

/** A non-JS module a custom run's code imports by relative specifier (currently only wasm). */
export type CustomModule = { name: string; kind: 'wasm'; base64: string };

export type UserWorker =
	| { type: 'custom'; customCode: string; modules?: ReadonlyArray<CustomModule> }
	| { type: 'example'; exampleId: string };

/**
 * Capability grant handed to a transform via its first `env` argument. Default
 * (absent) is `{ fetch: 'none' }`: no network. `fetch: 'page-links'` unlocks
 * `env.fetch`/`env.fetchFile`, but only for URLs referenced by the originally
 * fetched page (host-enforced by the CapabilityGate). `cpuMs` is the sandbox CPU
 * budget; when absent the loader uses CPU_LIMIT_MS, and it is clamped to [1,5000].
 */
export type Permissions = {
	fetch: 'page-links' | 'none';
	cpuMs?: number;
};

export type RunRequestBody = {
	url: string;
	worker: UserWorker;
	turnstileToken?: string;
	permissions?: Permissions;
};

/** Result of `env.fetch(url)` — a text fetch through the CapabilityGate. */
export type FetchTextResult = { status: number; contentType: string; body: string; truncated: boolean };

/** Result of `env.fetchFile(url)` — a binary fetch through the CapabilityGate. */
export type FetchFileResult = { status: number; contentType: string; bytes: Uint8Array; truncated: boolean };

/**
 * The capability object handed to a transform as its FIRST argument. Empty `{}`
 * under the default no-network grant; with fetch permission it carries `fetch`
 * and `fetchFile`, which may only reach URLs referenced by the fetched page.
 */
export type TransformEnv = {
	fetch?: (url: string) => Promise<FetchTextResult>;
	fetchFile?: (url: string) => Promise<FetchFileResult>;
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
