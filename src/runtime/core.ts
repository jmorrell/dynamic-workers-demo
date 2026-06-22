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
 *
 * Efficiently walks back from maxBytes over UTF-8 continuation bytes (0x80-0xBF)
 * to find a safe character boundary, then decodes once.
 */
export function truncateBody(body: string, maxBytes: number): { body: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(body);

	if (encoded.byteLength <= maxBytes) {
		return { body, truncated: false };
	}

	// Walk back from maxBytes to find a safe UTF-8 character boundary.
	// We need to ensure we only include complete, valid UTF-8 sequences.
	//
	// UTF-8 byte structure:
	// - 0x00-0x7F: single-byte character (ASCII)
	// - 0xC0-0xDF: start of 2-byte sequence
	// - 0xE0-0xEF: start of 3-byte sequence
	// - 0xF0-0xF7: start of 4-byte sequence
	// - 0x80-0xBF: continuation byte (never start of character)
	//
	// Strategy: Walk back from maxBytes and find the last complete character.
	let cutPoint = Math.min(maxBytes, encoded.length);

	while (cutPoint > 0) {
		const byte = encoded[cutPoint - 1];

		if (byte < 0x80) {
			// ASCII single-byte character, safe to cut here
			break;
		}

		if (byte >= 0xc0) {
			// Start of multi-byte sequence.
			// Determine how many bytes this sequence should be.
			let seqLen = 1;
			if ((byte & 0xe0) === 0xc0)
				seqLen = 2; // 110xxxxx → 2-byte
			else if ((byte & 0xf0) === 0xe0)
				seqLen = 3; // 1110xxxx → 3-byte
			else if ((byte & 0xf8) === 0xf0) seqLen = 4; // 11110xxx → 4-byte

			// The sequence starts at (cutPoint - 1).
			// Check if all bytes of the sequence are within our buffer.
			const seqEnd = cutPoint - 1 + seqLen;
			if (seqEnd <= maxBytes) {
				// Complete sequence fits within maxBytes, include it
				cutPoint = seqEnd;
			} else {
				// Sequence extends past maxBytes, don't include it
				// Cut before the start byte
				cutPoint = cutPoint - 1;
			}
			break;
		}

		// byte is 0x80-0xBF (continuation byte)
		// We're in the middle of a sequence, keep walking back
		cutPoint--;
	}

	// Decode the valid UTF-8 prefix once
	// fatal: false allows invalid sequences to be replaced with U+FFFD
	const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
	const truncated = encoded.slice(0, cutPoint);
	const decodedBody = decoder.decode(truncated);

	return { body: decodedBody, truncated: true };
}

/**
 * Classifies a thrown error message to determine the error kind.
 * Maps network-blocked messages to "network_blocked", others to "transform_threw".
 *
 * SYNC PARTNER: Keep this function in sync with the inlined copy in src/runtime/harness-source.ts.
 * Both must match exactly. Core.ts is the canonical version (tested in core.spec.ts).
 * Update both locations together if changing matched substrings or logic.
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

/**
 * Classifies a loader-level error message to determine the error kind.
 * Maps CPU/time-budget limit-exceeded messages to "cpu_exceeded", others to "loader_failed".
 *
 * Pure function for classifying loader-level exceptions. Intentionally narrow to
 * avoid collisions with sub-request-limit, memory-limit, RPC-timeout, and module-resolution
 * failures (which should map to "loader_failed" for correct containment attribution).
 *
 * Matches CPU/time budget signatures only:
 * - "cpu" (e.g., "exceeded cpu", "cpu time", "cpu limit")
 * - "exceeded cpu" or "cpu exceeded" (explicit CPU context)
 * - Future: finalized against real deploy-captured CPU-exceeded message
 */
export function classifyLoaderError(message: string): RunErrorKind {
	const lower = message.toLowerCase();

	// Match CPU/time-budget signatures only. Drop generic matchers ("limit", "resource", "timeout")
	// to avoid misclassifying sub-request/memory/RPC failures.
	if (lower.includes('cpu') && (lower.includes('exceeded') || lower.includes('limit') || lower.includes('time'))) {
		return 'cpu_exceeded';
	}

	return 'loader_failed';
}
