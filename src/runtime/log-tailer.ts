import { WorkerEntrypoint } from 'cloudflare:workers';
import type { LogLine } from './log-types';

export class LogTailer extends WorkerEntrypoint<Env> {
	async tail(events: ReadonlyArray<TraceItem>): Promise<void> {
		const runId = (this.ctx.props as { runId: string }).runId;
		const lines: Array<LogLine> = [];

		for (const event of events) {
			// Process logs from event
			for (const log of event.logs) {
				const message = Array.isArray(log.message) ? log.message.map(String).join(' ') : String(log.message);
				lines.push({ level: String(log.level ?? 'log'), message });
			}

			// Process exceptions from event
			for (const ex of event.exceptions) {
				lines.push({ level: 'error', message: `${ex.name}: ${ex.message}` });
			}
		}

		// If no lines to append, return early
		if (lines.length === 0) return;

		// Get LogSession stub and append lines
		const stub = this.env.LOG_SESSION.get(this.env.LOG_SESSION.idFromName(runId));
		await stub.append(lines);
	}
}
