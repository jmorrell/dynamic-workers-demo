// pattern: Functional Core

import type { LogLine, LogBundle } from './log-types';

/**
 * Appends incoming log lines to the current bundle, respecting line and byte caps.
 * Returns a new bundle with appended lines or truncation flag set if caps exceeded.
 * Total function: always returns a valid LogBundle, never throws.
 *
 * Note: The byte cap counts only `message` UTF-8 bytes (not level/JSON overhead).
 * A single line larger than maxBytes on an empty bundle is dropped entirely (not kept partially).
 *
 * @param current - Current log bundle to append to
 * @param incoming - New log lines to append
 * @param maxLines - Maximum number of lines allowed in bundle
 * @param maxBytes - Maximum cumulative UTF-8 byte size allowed in bundle
 * @returns New LogBundle with appended lines and truncation status
 */
export function appendWithCap(
	current: Readonly<LogBundle>,
	incoming: ReadonlyArray<LogLine>,
	maxLines: number,
	maxBytes: number,
): LogBundle {
	// If incoming is empty, return current unchanged
	if (incoming.length === 0) {
		return current;
	}

	const encoder = new TextEncoder();
	const result: Array<LogLine> = [...current.lines];
	let currentByteCount = result.reduce((sum, line) => sum + encoder.encode(line.message).length, 0);
	let truncated = current.truncated;

	// Append incoming lines while respecting both caps
	for (const line of incoming) {
		// Check line cap first
		if (result.length >= maxLines) {
			truncated = true;
			break;
		}

		// Check byte cap
		const lineBytes = encoder.encode(line.message).length;
		if (currentByteCount + lineBytes > maxBytes) {
			truncated = true;
			break;
		}

		// Line fits both caps, add it
		result.push(line);
		currentByteCount += lineBytes;
	}

	return {
		lines: result,
		truncated,
	};
}
