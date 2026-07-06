import { GENERATED_MANIFEST } from './manifest.generated';
import type { Permissions } from '../runtime/types';

// `assetPath` is a URL path served by the ASSETS binding (e.g.
// '/modules/image-hash/photon.wasm') — the binary itself lives under
// public/modules/ (generated-but-committed, see scripts/build-examples.mjs).
export type ExampleModule = { readonly name: string; readonly kind: 'wasm'; readonly assetPath: string };

export type Example = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly suggestedUrls: ReadonlyArray<string>;
	readonly source: string;
	readonly code: string;
	readonly compatDate: string;
	// Optional capability grant (see registry.ts). Exposed to the frontend via
	// listExamples so a dirty (custom) run can inherit the example's permissions.
	readonly permissions?: Permissions;
	// Non-JS modules (currently only wasm) the example's bundled code imports by
	// relative specifier. Exposed to the frontend via listExamples so the editor
	// can render one tab per module (fetching assetPath lazily); src/index.ts
	// fetches these via the ASSETS binding for example runs (the bundled code
	// retains its './add.wasm'-style import).
	readonly modules?: ReadonlyArray<ExampleModule>;
};

export const EXAMPLES: ReadonlyArray<Example> = GENERATED_MANIFEST as unknown as ReadonlyArray<Example>;

export function listExamples(): ReadonlyArray<Omit<Example, 'code' | 'compatDate'>> {
	return EXAMPLES.map(({ code, compatDate, ...rest }) => rest);
}

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id);
}
