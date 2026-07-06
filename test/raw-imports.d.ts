// Ambient declaration for Vitest `?raw` imports of .txt fixtures (e.g. the
// base64-encoded PDF fixture), which resolve to the file's text content at
// runtime. (.html?raw imports predate this file and remain part of the
// documented 11-error test baseline.)
declare module '*.txt?raw' {
	const content: string;
	export default content;
}
