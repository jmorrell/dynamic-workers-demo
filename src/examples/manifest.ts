import { GENERATED_MANIFEST } from './manifest.generated';
import type { Permissions } from '../runtime/types';

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
};

export const EXAMPLES: ReadonlyArray<Example> = GENERATED_MANIFEST as unknown as ReadonlyArray<Example>;

export function listExamples(): ReadonlyArray<Omit<Example, 'code' | 'compatDate'>> {
	return EXAMPLES.map(({ code, compatDate, ...rest }) => rest);
}

export function getExample(id: string): Example | undefined {
	return EXAMPLES.find((e) => e.id === id);
}
