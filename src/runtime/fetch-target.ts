// pattern: Imperative Shell

import { truncateBody } from './core';
import type { FetchOutcome, RunInput } from './types';

/**
 * Fetches a target URL and builds a RunInput snapshot for untrusted code.
 * Validates URL, enforces timeout and size caps, and returns a structured outcome.
 */
export async function fetchTarget(
  url: string,
  options?: {
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  },
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
        kind: 'fetch_failed',
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
          kind: 'fetch_failed',
          message: `HTTP ${response.status}: ${response.statusText || 'error'}`,
        },
      };
    }

    // Stream response body with size cap to avoid buffering huge responses.
    // Read chunks until we reach maxBytes or the stream ends.
    let body = '';
    let truncated = false;

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Decode chunk and append
          const chunk = decoder.decode(value, { stream: true });
          const newLength = new TextEncoder().encode(body + chunk).byteLength;

          if (newLength > maxBytes) {
            // Exceeded cap; truncate and stop reading
            const remaining = maxBytes - new TextEncoder().encode(body).byteLength;
            if (remaining > 0) {
              const { body: partialChunk } = truncateBody(chunk, remaining);
              body += partialChunk;
            }
            truncated = true;
            break;
          }

          body += chunk;
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      // Fallback for responses without a body stream (should be rare)
      const text = await response.text();
      const { body: truncatedBody, truncated: wasTruncated } = truncateBody(
        text,
        maxBytes,
      );
      body = truncatedBody;
      truncated = wasTruncated;
    }

    // Extract content-type header
    const contentType = response.headers.get('content-type') ?? 'text/plain';

    const input: RunInput = {
      url,
      finalUrl: response.url,
      status: response.status,
      contentType,
      body,
      truncated,
    };

    return { ok: true, input };
  } catch (err) {
    clearTimeout(timeoutId);

    const message = err instanceof Error ? err.message : String(err);

    return {
      ok: false,
      error: {
        kind: 'fetch_failed',
        message: `fetch failed: ${message}`,
      },
    };
  }
}
