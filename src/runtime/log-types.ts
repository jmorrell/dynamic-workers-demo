export type LogLine = { level: string; message: string };
export type LogBundle = { lines: Array<LogLine>; truncated: boolean };
export const LOG_MAX_LINES = 200;
export const LOG_MAX_BYTES = 16 * 1024;
