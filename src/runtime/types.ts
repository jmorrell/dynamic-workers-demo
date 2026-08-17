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

/** An additional module imported by a custom run's entrypoint. */
export type CustomModule =
	| { name: string; kind: 'js'; source: string }
	| { name: string; kind: 'wasm'; base64: string };

export type UserWorker =
	| { type: 'custom'; customCode: string; modules?: ReadonlyArray<CustomModule>; sourceExampleId?: string }
	| { type: 'example'; exampleId: string };

/**
 * Capability grant handed to a transform via its first `env` argument. Default
 * (absent) is `{ fetch: 'none' }`: no network. `fetch: 'page-links'` unlocks
 * target-bound capabilities in `env.resources`, but only for URLs referenced by
 * the originally fetched page (host-enforced by the CapabilityGate). `cpuMs` is the sandbox CPU
 * budget; when absent the loader uses CPU_LIMIT_MS, and it is clamped to [1,5000].
 * `fetchDepth` is meaningful only alongside `fetch: 'page-links'`: depth 1
 * (default) grants resources referenced by the original page; a successful text
 * read returns child capabilities up to N-1 hops out. Clamped to [1,3] (`clampFetchDepth`
 * in core). `maxFetches` is also meaningful only alongside `fetch: 'page-links'`: it
 * is the per-run cap on resource `read()` calls (host-tallied by the
 * CapabilityGate and mirrored into the sandbox's own `limits.subRequests`); default
 * 5, clamped to [1,100] (`clampMaxFetches` in core).
 * `storage` unlocks `env.DB`, an SQL binding backed by a per-store, per-script
 * isolated SQLite database (a Durable Object facet). Default (absent) is
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

/** Where a resource URL was discovered. Advisory metadata, never an authority decision. */
export type ResourceSource =
	| { kind: 'html'; element: string; attribute: string }
	| { kind: 'text' };

/** A URL discovered in a fetched document before an opaque capability id is minted for it. */
export type ResourceDescriptor = { url: string; source: ResourceSource };

/** Host-internal descriptor installed in the gate and loaded worker. */
export type ResourceGrant = ResourceDescriptor & { id: string };

export type ResourceTextResult = {
	kind: 'text';
	status: number;
	contentType: string;
	body: string;
	truncated: boolean;
	resources: ReadonlyMap<string, ResourceCapability>;
};

export type ResourceBytesResult = {
	kind: 'bytes';
	status: number;
	contentType: string;
	bytes: Uint8Array;
	truncated: boolean;
};

export type ResourceResult = ResourceTextResult | ResourceBytesResult;

/** Target-bound authority: `read` needs no URL because the capability already names it. */
export type ResourceCapability = ResourceDescriptor & { read(): Promise<ResourceResult> };

/** Plain RPC result returned by the host gate; the harness wraps grants as capabilities. */
export type GateResourceResult =
	| { kind: 'text'; status: number; contentType: string; body: string; truncated: boolean; resources: ReadonlyArray<ResourceGrant> }
	| { kind: 'bytes'; status: number; contentType: string; bytes: Uint8Array; truncated: boolean };

/**
 * Materialized result from the SQLite binding. `exec()` consumes the native
 * cursor inside the size-limited transaction, then exposes the familiar
 * `toArray()` shape to user code.
 */
export type DatabaseResult<Row extends Record<string, unknown>> = {
	columnNames: string[];
	rowsRead: number;
	rowsWritten: number;
	toArray(): Row[];
};

/**
 * SQLite database binding handed to a transform as `env.DB` under a
 * `storage: 'scoped'` grant. Every query runs in the facet's private database.
 * Queries that grow it beyond the demo's 128 KiB cap are rolled back.
 */
export type DatabaseApi = {
	readonly databaseSize: number;
	exec<Row extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		...bindings: unknown[]
	): DatabaseResult<Row>;
};

/**
 * The capability object handed to a transform as its FIRST argument. Empty `{}`
 * under the default no-network grant; with fetch permission it carries a map
 * of target-bound resource capabilities discovered in the fetched page. Each
 * capability has a zero-argument `read()` method, so knowing or forging a URL
 * does not confer authority. With a storage grant it also carries `DB`.
 */
export type TransformEnv = {
	resources?: ReadonlyMap<string, ResourceCapability>;
	DB?: DatabaseApi;
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
	| 'compile_failed'
	| 'local_cpu_limits_unavailable';

export type RunError = {
	kind: RunErrorKind;
	message: string;
};

/** Host fetch outcome before loader invocation. */
export type FetchOutcome = { type: 'success'; input: RunInput } | { type: 'failure'; error: RunError };
