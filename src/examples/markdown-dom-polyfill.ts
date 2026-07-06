// NOTE: Example payload (untrusted code), imported only by markdown.ts. Not application code.
//
// Turndown (bundled inside defuddle/node) picks its HTML parser at ITS OWN
// module-evaluation time: `var root = typeof window !== 'undefined' ? window : {}`
// then `var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser()`
// are both top-level `var`s, evaluated once when the turndown module first loads.
// esbuild bundles this example with platform 'browser', which maps turndown's
// Node fallback (`@mixmark-io/domino`) to `false` via turndown's package.json
// "browser" field — so if `root.DOMParser` isn't already usable at that moment,
// there is no working fallback and Turndown throws.
//
// ES module imports evaluate in source order before any of the importing
// module's own statements run, so this side-effect-only import MUST appear
// before `import '...defuddle/node'` in markdown.ts — setting these globals
// inside the transform function (which runs later, per-request) is too late.
import { parseHTML, DOMParser } from 'linkedom';

const g = globalThis as Record<string, unknown>;
if (typeof g.DOMParser === 'undefined') g.DOMParser = DOMParser;
if (typeof g.window === 'undefined') g.window = g;
if (typeof g.document === 'undefined') g.document = parseHTML('<html><body></body></html>').document;
