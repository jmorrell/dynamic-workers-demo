// pattern: Imperative Shell
import { truncateBody } from "./core";
import type { FetchOutcome, RunInput } from "./types";

/**
 * Fetches a target URL and builds a RunInput snapshot for untrusted code.
 * Validates URL, enforces timeout and size caps, and returns a structured outcome.
 */
export async function fetchTarget(
	url: string,
	options?: {
		readonly timeoutMs?: number;
		readonly maxBytes?: number;
	}
): Promise<FetchOutcome> {
	const timeoutMs = options?.timeoutMs ?? 8000;
	const maxBytes = options?.maxBytes ?? 256 * 1024;

	// Validate URL
	try {
		new URL(url);
	} catch {
		return {
			ok: false,
			error: {
				kind: "fetch_failed",
				message: `invalid URL: ${url}`,
			},
		};
	}

	// Create abort controller with timeout
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Check response status
		if (!response.ok) {
			return {
				ok: false,
				error: {
					kind: "fetch_failed",
					message: `HTTP ${response.status}: ${response.statusText || "error"}`,
				},
			};
		}

		// Read response body as text
		const body = await response.text();

		// Truncate if needed
		const { body: truncatedBody, truncated } = truncateBody(body, maxBytes);

		// Extract content-type header
		const contentType = response.headers.get("content-type") ?? "text/plain";

		const input: RunInput = {
			url,
			finalUrl: response.url,
			status: response.status,
			contentType,
			body: truncatedBody,
			truncated,
		};

		return { ok: true, input };
	} catch (err) {
		clearTimeout(timeoutId);

		const message =
			err instanceof Error ? err.message : String(err);

		return {
			ok: false,
			error: {
				kind: "fetch_failed",
				message: `fetch failed: ${message}`,
			},
		};
	}
}
