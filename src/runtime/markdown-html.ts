import { micromark } from 'micromark';

/**
 * Server-side markdown → HTML rendering for the `/api/run` response's optional
 * `resultHtml` field: when a transform's result value is `{ markdown: string,
 * ... }`, the host renders that markdown into a complete, self-contained HTML
 * document, ready to be used verbatim as a sandboxed iframe's `srcdoc` by the
 * frontend. Pure: no bindings, no I/O — micromark is a pure string→string
 * parser.
 *
 * Security posture rests entirely on micromark's DEFAULTS: `allowDangerousHtml`
 * and `allowDangerousProtocol` are never set, so raw HTML in the source is
 * escaped to inert text (not passed through) and `javascript:`/`data:` link
 * targets are stripped. Do not flip either default without re-deriving this
 * module's XSS pins (see markdown-html.spec.ts).
 */

/** Pre-parse cap on markdown length (chars). The run result is otherwise
 * uncapped end-to-end; parsing unbounded input host-side would be a DoS
 * vector, so markdown is truncated before it ever reaches micromark. */
export const MARKDOWN_RENDER_LIMIT = 262144;

/**
 * Extracts a renderable markdown string from a run result, or null if the
 * result isn't shaped like `{ markdown: string, ... }`. Only a plain object
 * (not an array, not null) with a string `markdown` property qualifies; extra
 * keys alongside it are ignored.
 */
export function extractMarkdown(result: unknown): string | null {
	if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
	const markdown = (result as Record<string, unknown>).markdown;
	return typeof markdown === 'string' ? markdown : null;
}

/**
 * Renders markdown into a complete HTML document string (doctype through
 * closing html tag) suitable for a sandboxed iframe's `srcdoc`: a strict CSP
 * meta tag, `<base target="_blank">` so links escape the iframe rather than
 * navigating it, and minimal readable styling.
 */
export function renderMarkdownDocument(markdown: string): string {
	const truncated = markdown.length > MARKDOWN_RENDER_LIMIT;
	const text = truncated ? markdown.slice(0, MARKDOWN_RENDER_LIMIT) : markdown;

	const rendered = micromark(text);
	// Sound because micromark's default (allowDangerousHtml: false) escapes any
	// raw HTML in the source to text (`<a` becomes `&lt;a`) — so a literal
	// `<a href="` in the output can only be a real anchor micromark generated
	// for a markdown link, never source-controlled text.
	const withRelAttr = rendered.replace(/<a href="/g, '<a rel="noopener noreferrer" href="');

	const truncatedNotice = truncated
		? '<div class="truncated-notice" style="color:#767676;font-size:12px;margin-top:16px;padding-top:8px;border-top:1px solid #ddd;">Output truncated for rendering (256 KiB cap).</div>'
		: '';

	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"><base target="_blank"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 12px; color: #1a1a1a; }
img { max-width: 100%; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.15em; }
pre { overflow-x: auto; background: #f0f0f0; padding: 8px; border-radius: 4px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
blockquote { color: #767676; border-left: 3px solid #ddd; margin: 0; padding-left: 12px; }
a { color: #0969da; }
</style></head><body>${withRelAttr}${truncatedNotice}</body></html>`;
}
