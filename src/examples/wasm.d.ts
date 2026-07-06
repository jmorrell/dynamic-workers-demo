// Ambient declaration so tsc accepts `import mod from './add.wasm'` in example
// sources. At runtime the loader injects the actual WebAssembly.Module into the
// Dynamic Worker's module map (see src/runtime/loader.ts wasmModules); this
// type only matters for build-time checking (the host build/tsc never bundles
// the .wasm bytes themselves — esbuild treats '*.wasm' as external).
declare module '*.wasm' {
	const mod: WebAssembly.Module;
	export default mod;
}
