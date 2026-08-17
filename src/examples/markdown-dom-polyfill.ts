import { parseHTML, DOMParser } from 'linkedom';

const globals = globalThis as Record<string, unknown>;

if (typeof globals.DOMParser === 'undefined') {
  globals.DOMParser = DOMParser;
}
if (typeof globals.window === 'undefined') {
  globals.window = globals;
}
if (typeof globals.document === 'undefined') {
  globals.document = parseHTML('<html></html>').document;
}
