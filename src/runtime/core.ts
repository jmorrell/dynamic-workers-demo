// pattern: Functional Core

import type { RunErrorKind } from './types';

/**
 * Computes SHA-256 hash of code string for loader cache id.
 * Identical code produces identical hash.
 */
export async function hashCode(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hexArray = Array.from(new Uint8Array(digest));
  return hexArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Truncates body to maxBytes UTF-8 byte length, respecting character boundaries.
 * Returns the truncated body and a flag indicating if truncation occurred.
 */
export function truncateBody(
  body: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  if (encoded.byteLength <= maxBytes) {
    return { body, truncated: false };
  }

  // Truncate by finding the longest valid UTF-8 substring that fits
  let cutPoint = maxBytes;
  let result: string | undefined;

  // Try to decode progressively shorter byte sequences until we find a valid one
  while (cutPoint > 0) {
    const truncated = encoded.slice(0, cutPoint);
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true } as TextDecoderConstructorOptions);
      result = decoder.decode(truncated);
      break;
    } catch {
      // This byte sequence is incomplete, try one byte less
      cutPoint--;
    }
  }

  const decodedBody = result ?? '';

  return { body: decodedBody, truncated: true };
}

/**
 * Classifies a thrown error message to determine the error kind.
 * Maps network-blocked messages to "network_blocked", others to "transform_threw".
 */
export function classifyTransformError(message: string): RunErrorKind {
  const lower = message.toLowerCase();

  // Match network-blocked signatures (globalOutbound: null, fetch restrictions)
  if (
    lower.includes('disallowed') ||
    lower.includes('not allowed') ||
    lower.includes('globaloutbound') ||
    lower.includes('not permitted to access the internet') ||
    lower.includes('cannot access the internet')
  ) {
    return 'network_blocked';
  }

  return 'transform_threw';
}
