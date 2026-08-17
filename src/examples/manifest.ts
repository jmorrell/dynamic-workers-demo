import { GENERATED_MANIFEST } from './manifest.generated';
import type { Permissions } from '../runtime/types';

// `assetPath` is a URL path served by the ASSETS binding (e.g.
// '/modules/image-hash/photon.wasm') — the binary itself lives under
// public/modules/ (generated-but-committed, see scripts/build-examples.mjs).
export type ExampleModule =
	| { readonly name: string; readonly label?: string; readonly kind: 'js'; readonly source: string }
	| {
			readonly name: string;
			readonly label?: string;
			readonly kind: 'wasm';
			readonly assetPath: string;
			readonly previewBase64: string;
			readonly byteSize: number;
	  };

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
	// Additional source or wasm modules imported by relative specifier. Source
	// modules are included directly for editor tabs; wasm entries carry only a
	// 1.5 KiB preview and an assetPath whose full bytes are fetched on demand.
	readonly modules?: ReadonlyArray<ExampleModule>;
};

export const EXAMPLES: ReadonlyArray<Example> = GENERATED_MANIFEST as unknown as ReadonlyArray<Example>;

export function listExamples(): ReadonlyArray<Omit<Example, 'code' | 'compatDate'>> {
	return EXAMPLES.map(({ code, compatDate, ...rest }) => rest);
}

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id);
}
