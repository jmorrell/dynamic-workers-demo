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
 * `fetchDepth` is meaningful only alongside `fetch: 'page-links'`: it grows the
 * allowlist transitively — depth 1 (default) is exactly "URLs referenced by the
 * fetched page"; depth N also allows URLs referenced by pages the run has
 * successfully text-fetched, up to N-1 hops out. Clamped to [1,3] (`clampFetchDepth`
 * in core). `maxFetches` is also meaningful only alongside `fetch: 'page-links'`: it
 * is the per-run cap on `env.fetch`/`env.fetchFile` calls (both host-tallied by the
 * CapabilityGate and mirrored into the sandbox's own `limits.subRequests`); default
 * 5, clamped to [1,100] (`clampMaxFetches` in core).
 * `storage` unlocks `env.storage` (get/put/delete/list) backed by a per-store,
 * per-script isolated SQLite DB (a Durable Object facet). Default (absent) is
 * `'none'`: no persistence. `'scoped'` requires the run request to carry a
 * `storeId` (uuid) — see `RunRequestBody.storeId`. See src/runtime/storage-host.ts.
 */
export type Permissions = {
	fetch: 'page-links' | 'none';
	cpuMs?: number;
	fetchDepth?: number;
	maxFetches?: number;
	storage?: 'scoped' | 'none';
};

export type RunRequestBody = {
	url: string;
	worker: UserWorker;
	turnstileToken?: string;
	permissions?: Permissions;
	// Anonymous, client-minted store identity (uuid). REQUIRED when the effective
	// grant has `storage: 'scoped'` — it selects the supervisor Durable Object
	// (`idFromName(storeId)`) that hosts this visitor's per-script storage facets.
	// Ignored/allowed-absent when storage isn't granted. See src/runtime/storage-host.ts.
	storeId?: string;
};

/** Result of `env.fetch(url)` — a text fetch through the CapabilityGate. */
export type FetchTextResult = { status: number; contentType: string; body: string; truncated: boolean };

/** Result of `env.fetchFile(url)` — a binary fetch through the CapabilityGate. */
export type FetchFileResult = { status: number; contentType: string; bytes: Uint8Array; truncated: boolean };

/**
 * Persistent key/value store handed to a transform as `env.storage` under a
 * `storage: 'scoped'` grant. Backed by the run's own isolated SQLite DB (a DO
 * facet). Values are plain JSON-serializable data. Advisory caps are enforced
 * in the harness wrapper (key ≤ 256 B, value ≤ 8 KiB, ≤ 200 keys) with a hard
 * 5 MiB `databaseSize` backstop; a rejected write throws a catchable Error.
 */
export type StorageApi = {
	get(key: string): unknown;
	put(key: string, value: unknown): void;
	delete(key: string): boolean;
	list(): string[];
};

/**
 * The capability object handed to a transform as its FIRST argument. Empty `{}`
 * under the default no-network grant; with fetch permission it carries `fetch`
 * and `fetchFile`, which may only reach URLs referenced by the fetched page;
 * with a storage grant it carries `storage`.
 */
export type TransformEnv = {
	fetch?: (url: string) => Promise<FetchTextResult>;
	fetchFile?: (url: string) => Promise<FetchFileResult>;
	storage?: StorageApi;
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
