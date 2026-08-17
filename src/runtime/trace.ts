/**
 * Per-invocation trace for the run's `trace` response field: a lightweight
 * waterfall — a root `run` span, host phase spans (target fetch, loader
 * create/invoke, log read), and, nested under the loader span, one span per
 * resource capability read, including denied attempts as error
 * spans. Deliberately NOT OTel-conformant — just enough shape for a waterfall
 * UI. Nothing here is stored; it's assembled fresh per run and returned
 * inline, same ephemerality as captured logs.
 *
 * Caveat: workerd only advances timers at I/O boundaries, so a pure-CPU
 * stretch inside a span shows ~0ms; only fetch-bound spans get a real
 * duration. The waterfall visualizes I/O shape, not CPU attribution.
 */

/** One span in a run's trace. Everything descriptive lives in `attrs` (including the human label/phase name) — there is no separate "name" field. */
export type TraceSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startMs: number;
	durMs: number;
	status: 'ok' | 'error';
	attrs: Record<string, string | number | boolean>;
};

/** The `trace` field on a run-shaped `/api/run` response. */
export type Trace = {
	traceId: string;
	totalMs: number;
	spans: TraceSpan[];
};

/**
 * A gate call's span data, recorded by `CapabilityGate` at module scope (keyed
 * by runId — see capability-gate.ts's `fetchCounts` doc comment for why
 * per-instance state doesn't work) using absolute `performance.now()`
 * start/end pairs. The gate doesn't know the run's start time, so it can't
 * normalize to `startMs` itself; the host does that when draining via
 * `collectGateSpans` and folding these into the run's `Tracer`.
 */
export type GateSpanDraft = {
	startAbsMs: number;
	endAbsMs: number;
	status: 'ok' | 'error';
	attrs: Record<string, string | number | boolean>;
};

/** Pure: normalizes an absolute `performance.now()` timestamp to a run-start-relative offset. */
export function relativeMs(absMs: number, runStartAbsMs: number): number {
	return Math.round(absMs - runStartAbsMs);
}

/** Pure: builds one TraceSpan from resolved fields — no clock reads, no id assignment. */
export function buildSpan(args: {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	startAbsMs: number;
	endAbsMs: number;
	runStartAbsMs: number;
	status: 'ok' | 'error';
	attrs: Record<string, string | number | boolean>;
}): TraceSpan {
	return {
		traceId: args.traceId,
		spanId: args.spanId,
		...(args.parentSpanId !== undefined ? { parentSpanId: args.parentSpanId } : {}),
		startMs: relativeMs(args.startAbsMs, args.runStartAbsMs),
		durMs: Math.max(0, Math.round(args.endAbsMs - args.startAbsMs)),
		status: args.status,
		attrs: args.attrs,
	};
}

/**
 * Thin stateful builder over the pure core above: assigns per-run ordinal
 * span ids ("s1", "s2", …) in call order, remembers the run's start reference
 * so callers only ever pass absolute `performance.now()` timestamps, and
 * accumulates spans for final assembly. One instance per invocation — never
 * shared across runs.
 */
export class Tracer {
	readonly traceId: string;
	private readonly runStartAbsMs: number;
	private seq = 0;
	private readonly spans: TraceSpan[] = [];

	constructor(traceId: string, runStartAbsMs: number) {
		this.traceId = traceId;
		this.runStartAbsMs = runStartAbsMs;
	}

	/** Assigns the next span id ("s1", "s2", …), in call order. */
	newSpanId(): string {
		this.seq += 1;
		return `s${this.seq}`;
	}

	/** Records a span from absolute performance.now() start/end timestamps. */
	addSpan(
		spanId: string,
		parentSpanId: string | undefined,
		startAbsMs: number,
		endAbsMs: number,
		status: 'ok' | 'error',
		attrs: Record<string, string | number | boolean>,
	): void {
		this.spans.push(
			buildSpan({ traceId: this.traceId, spanId, parentSpanId, startAbsMs, endAbsMs, runStartAbsMs: this.runStartAbsMs, status, attrs }),
		);
	}

	/**
	 * Folds externally-recorded spans (gate calls, drained via
	 * capability-gate.ts's `collectGateSpans`) into this run's trace, assigning
	 * each a fresh span id and the given parent (the loader span).
	 */
	addExternalSpans(drafts: ReadonlyArray<GateSpanDraft>, parentSpanId: string): void {
		for (const draft of drafts) {
			this.addSpan(this.newSpanId(), parentSpanId, draft.startAbsMs, draft.endAbsMs, draft.status, draft.attrs);
		}
	}

	/**
	 * Assembles the final Trace: spans sorted by startMs, totalMs from the named
	 * root span's own duration. startMs ties (common at ms rounding — e.g. the
	 * root and the first phase both round to 0) break on span-id ordinal, i.e.
	 * id-assignment order, so a parent whose id was minted first sorts before
	 * its same-start children regardless of when addSpan was called (the root
	 * span is typically recorded last, at finish).
	 */
	build(rootSpanId: string): Trace {
		const ordinal = (spanId: string): number => Number(spanId.slice(1));
		const sorted = [...this.spans].sort((a, b) => a.startMs - b.startMs || ordinal(a.spanId) - ordinal(b.spanId));
		const root = this.spans.find((s) => s.spanId === rootSpanId);
		return { traceId: this.traceId, totalMs: root?.durMs ?? 0, spans: sorted };
	}
}
