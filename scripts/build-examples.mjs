#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Load EXAMPLE_REGISTRY from src/examples/registry.ts (the single source of
 * truth). esbuild bundles the TS module to ESM in-memory, which we import via a
 * data URL — no duplicated example list in this script.
 */
async function loadRegistry() {
	const registryPath = path.resolve(repoRoot, 'src/examples/registry.ts');
	const built = await esbuild.build({
		entryPoints: [registryPath],
		bundle: true,
		format: 'esm',
		write: false,
		platform: 'neutral',
		target: 'esnext',
	});
	const base64 = Buffer.from(built.outputFiles[0].text).toString('base64');
	const mod = await import(`data:text/javascript;base64,${base64}`);
	return mod.EXAMPLE_REGISTRY;
}

/**
 * Read raw source file content
 */
async function readSource(entry) {
	const filePath = path.resolve(repoRoot, entry);
	return fs.readFileSync(filePath, 'utf8');
}

const SHARED_BUNDLE_OPTIONS = {
	bundle: true,
	format: 'esm',
	write: false,
	platform: 'browser',
	target: 'esnext',
	conditions: ['browser'],
	mainFields: ['browser', 'module', 'main'],
};

/**
 * Bundle example to self-contained ESM string using esbuild.
 *
 * `hasModules` is true when the example declares non-JS modules (registry.ts
 * `modules`, e.g. a wasm binary) — its entry imports them by relative
 * specifier (e.g. `import mod from './add.wasm'`), which must survive
 * verbatim into the bundled `code` string rather than have esbuild try (and
 * fail) to load the binary itself. `external: ['*.wasm']` keeps any such
 * import unresolved in the output; the loader injects the real module at
 * Dynamic Worker load time (see src/runtime/loader.ts wasmModules).
 */
async function bundleExample(entry, hasModules = false) {
	const filePath = path.resolve(repoRoot, entry);
	try {
		const result = await esbuild.build({
			...SHARED_BUNDLE_OPTIONS,
			entryPoints: [filePath],
			...(hasModules ? { external: ['*.wasm'] } : {}),
		});

		if (!result.outputFiles || result.outputFiles.length === 0) {
			throw new Error(`No output from esbuild for ${entry}`);
		}

		return result.outputFiles[0].text;
	} catch (error) {
		console.error(`Failed to bundle ${entry}:`, error);
		throw error;
	}
}

/**
 * Bundle a single shared dependency (see SHARED_DEP_SPECIFIERS in registry.ts)
 * into a self-contained ESM string, using the same esbuild options as example
 * bundling so the injected module resolves identically to how it would if it
 * had been part of the example's own bundle.
 *
 * `entry` is either a bare/subpath npm specifier (e.g. 'linkedom',
 * 'defuddle/node') or a repo-relative file path. npm specifiers have no file
 * on disk to use as an entryPoint, so we synthesize one via esbuild's stdin
 * option.
 *
 * npm packages here are CommonJS under the hood (esbuild wraps them in a
 * require() shim), so `export * from '<entry>'` can't work — esbuild can only
 * re-export names it can statically enumerate from real ESM, and a CJS
 * module's exports are only known at runtime. Instead we import the real
 * package right here in this (Node) build script to discover its actual
 * export names, then generate stdin content with an explicit
 * `export const NAME = m.NAME` per name — plain property access off the
 * namespace import, which esbuild's CJS interop handles fine at runtime.
 */
async function bundleDep({ specifier, entry }) {
	const isFilePath = entry.includes('/') && (entry.endsWith('.ts') || entry.endsWith('.js'));

	let stdinContents;
	if (!isFilePath) {
		const realModule = await import(entry);
		// Node's CJS-interop namespace can include synthetic keys (e.g.
		// "module.exports") that aren't valid JS identifiers — only keep names
		// that are safe to use as `export const <name>`.
		const namedExports = Object.keys(realModule).filter((k) => k !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k));
		const namedExportLines = namedExports.map((name) => `export const ${name} = m.${name};`).join('\n');
		stdinContents = `import * as m from '${entry}';\n${namedExportLines}\nexport default m.default;`;
	}

	const buildOptions = isFilePath
		? { ...SHARED_BUNDLE_OPTIONS, entryPoints: [path.resolve(repoRoot, entry)] }
		: { ...SHARED_BUNDLE_OPTIONS, stdin: { contents: stdinContents, resolveDir: repoRoot, loader: 'js' } };

	try {
		const result = await esbuild.build(buildOptions);
		if (!result.outputFiles || result.outputFiles.length === 0) {
			throw new Error(`No output from esbuild for dep ${specifier}`);
		}
		return result.outputFiles[0].text;
	} catch (error) {
		console.error(`Failed to bundle shared dep ${specifier}:`, error);
		throw error;
	}
}

/**
 * Build src/examples/deps.generated.ts: bundled ESM source for every shared
 * dependency (see SHARED_DEP_SPECIFIERS), keyed by import specifier. Injected
 * by src/index.ts's custom-code path so edited example code (which imports
 * these bare specifiers) resolves the same modules a pristine example gets
 * baked in at build time.
 */
async function buildDeps() {
	console.log('Building shared dependency modules...');

	// Re-derive SHARED_DEP_SPECIFIERS from registry.ts the same way loadRegistry
	// does, so this stays a single source of truth.
	const registryPath = path.resolve(repoRoot, 'src/examples/registry.ts');
	const built = await esbuild.build({
		entryPoints: [registryPath],
		bundle: true,
		format: 'esm',
		write: false,
		platform: 'neutral',
		target: 'esnext',
	});
	const base64 = Buffer.from(built.outputFiles[0].text).toString('base64');
	const mod = await import(`data:text/javascript;base64,${base64}`);
	const SHARED_DEP_SPECIFIERS = mod.SHARED_DEP_SPECIFIERS;

	const entries = {};
	for (const dep of SHARED_DEP_SPECIFIERS) {
		console.log(`  - Bundling dep ${dep.specifier}...`);
		entries[dep.specifier] = await bundleDep(dep);
	}

	const generatedDeps = `// AUTO-GENERATED by scripts/build-examples.mjs — do not edit.
export const GENERATED_DEP_MODULES = ${JSON.stringify(entries, null, '\t')} as const;
`;

	const outputPath = path.resolve(repoRoot, 'src/examples/deps.generated.ts');
	fs.writeFileSync(outputPath, generatedDeps, 'utf8');

	try {
		execSync(`npx prettier --write "${outputPath}"`, { stdio: 'pipe' });
	} catch (error) {
		console.warn('Warning: Could not format deps.generated.ts with prettier');
	}

	console.log(`Generated deps at ${outputPath}`);
}

/**
 * Build all examples and generate manifest
 */
async function buildManifest() {
	console.log('Building example manifest...');

	const EXAMPLE_REGISTRY = await loadRegistry();
	const manifestEntries = [];

	for (const example of EXAMPLE_REGISTRY) {
		console.log(`  - Bundling ${example.id}...`);
		try {
			const source = await readSource(example.entry);
			const code = await bundleExample(example.entry, Boolean(example.modules?.length));

			// Non-JS modules (currently only wasm) the example's code imports by
			// relative specifier: read the committed binary and base64-encode it
			// into the manifest so both the frontend (editor tabs) and src/index.ts
			// (loader injection for example runs) can consume it without touching disk.
			const modules = example.modules?.length
				? example.modules.map((m) => ({
						name: m.name,
						kind: m.kind,
						base64: fs.readFileSync(path.resolve(repoRoot, m.file)).toString('base64'),
					}))
				: undefined;

			manifestEntries.push({
				id: example.id,
				title: example.title,
				description: example.description,
				suggestedUrls: example.suggestedUrls,
				source,
				code,
				compatDate: example.compatDate,
				// Copied through so the manifest (and thus /api/examples) carries the
				// example's capability grant. Omitted when the example declares none.
				...(example.permissions ? { permissions: example.permissions } : {}),
				...(modules ? { modules } : {}),
			});
		} catch (error) {
			console.error(`Failed to build example ${example.id}:`, error.message);
			process.exit(1);
		}
	}

	// Generate manifest.generated.ts with properly escaped strings
	const generatedManifest = `// AUTO-GENERATED by scripts/build-examples.mjs — do not edit.
export const GENERATED_MANIFEST = ${JSON.stringify(manifestEntries, null, '\t')} as const;
`;

	const outputPath = path.resolve(repoRoot, 'src/examples/manifest.generated.ts');
	fs.writeFileSync(outputPath, generatedManifest, 'utf8');

	// Format with prettier
	try {
		execSync(`npx prettier --write "${outputPath}"`, { stdio: 'pipe' });
	} catch (error) {
		// Prettier formatting is not critical to the build, just warn
		console.warn('Warning: Could not format manifest.generated.ts with prettier');
	}

	console.log(`Generated manifest at ${outputPath}`);
	console.log(`  ${manifestEntries.length} examples bundled`);

	await buildDeps();

	console.log('Done!');
}

// Run the build
buildManifest().catch((error) => {
	console.error('Build failed:', error);
	process.exit(1);
});
