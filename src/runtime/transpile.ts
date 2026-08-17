// pattern: Functional Core

import { transform } from 'sucrase';
import type { RunError } from './types';

export type TranspileResult = { type: 'success'; code: string } | { type: 'failure'; error: RunError };

/**
 * Strips TypeScript syntax (type annotations, interfaces, type-only imports,
 * etc.) from user-submitted source, producing plain ESM the loader can run.
 * `disableESTransforms` keeps sucrase from also rewriting ES module syntax —
 * only TS constructs are erased, the output stays ESM.
 */
export function transpileUserCode(source: string): TranspileResult {
	try {
		const result = transform(source, { transforms: ['typescript'], disableESTransforms: true });
		console.log(result);
		return { type: 'success', code: result.code };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { type: 'failure', error: { kind: 'compile_failed', message } };
	}
}

/**
 * Picks the shared dependency modules actually referenced by transpiled code,
 * so the loader only injects modules the code imports. Substring matching is
 * intentionally simple: a false positive just injects an unused module, which
 * is harmless (see src/index.ts custom-code path).
 */
export function selectReferencedDeps<T extends { specifier: string }>(code: string, deps: ReadonlyArray<T>): ReadonlyArray<T> {
	return deps.filter((dep) => code.includes(dep.specifier));
}
