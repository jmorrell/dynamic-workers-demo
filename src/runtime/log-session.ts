// pattern: Imperative Shell

import { DurableObject } from 'cloudflare:workers';
import type { LogLine, LogBundle } from './log-types';
import { LOG_MAX_LINES, LOG_MAX_BYTES } from './log-types';
import { appendWithCap } from './log-cap';

export class LogSession extends DurableObject {
	private bundle: LogBundle = { lines: [], truncated: false };
	private appendedAtLeastOnce = false;

	async append(lines: ReadonlyArray<LogLine>): Promise<void> {
		// Only set appendedAtLeastOnce if we're actually adding lines
		if (lines.length > 0) {
			this.appendedAtLeastOnce = true;
		}

		this.bundle = appendWithCap(this.bundle, lines, LOG_MAX_LINES, LOG_MAX_BYTES);
	}

	async getLogs(timeoutMs: number): Promise<LogBundle> {
		const startTime = Date.now();

		// Poll until at least one append with content occurs or timeout elapses
		while (!this.appendedAtLeastOnce && Date.now() - startTime < timeoutMs) {
			// Sleep in small intervals to allow non-blocking polling
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		// Return current bundle (empty if no append occurred within timeout)
		return this.bundle;
	}
}
