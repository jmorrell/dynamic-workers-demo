import { describe, it, expect } from 'vitest';
import { buildSpan, relativeMs, Tracer } from '../../src/runtime/trace';

describe('trace.ts', () => {
	describe('relativeMs (pure)', () => {
		it('normalizes an absolute timestamp to a run-start-relative offset, rounding to the nearest ms', () => {
			expect(relativeMs(1000, 1000)).toBe(0);
			expect(relativeMs(1250.4, 1000)).toBe(250);
			expect(relativeMs(1250.6, 1000)).toBe(251);
		});
	});

	describe('buildSpan (pure)', () => {
		it('builds a span with startMs relative to runStartAbsMs and durMs from the abs start/end pair', () => {
			const span = buildSpan({
				traceId: 'run-1',
				spanId: 's1',
				startAbsMs: 1100,
				endAbsMs: 1150,
				runStartAbsMs: 1000,
				status: 'ok',
				attrs: { name: 'thing' },
			});
			expect(span).toEqual({
				traceId: 'run-1',
				spanId: 's1',
				startMs: 100,
				durMs: 50,
				status: 'ok',
				attrs: { name: 'thing' },
			});
			// No parentSpanId key at all when omitted (root span shape).
			expect('parentSpanId' in span).toBe(false);
		});

		it('includes parentSpanId when given', () => {
			const span = buildSpan({
				traceId: 'run-1',
				spanId: 's2',
				parentSpanId: 's1',
				startAbsMs: 1000,
				endAbsMs: 1000,
				runStartAbsMs: 1000,
				status: 'error',
				attrs: {},
			});
			expect(span.parentSpanId).toBe('s1');
		});

		it('never produces a negative durMs even if end < start (clock oddities)', () => {
			const span = buildSpan({
				traceId: 'run-1',
				spanId: 's1',
				startAbsMs: 1100,
				endAbsMs: 1050,
				runStartAbsMs: 1000,
				status: 'ok',
				attrs: {},
			});
			expect(span.durMs).toBe(0);
		});
	});

	describe('Tracer (stateful builder)', () => {
		it('assigns per-run ordinal span ids in call order', () => {
			const tracer = new Tracer('run-1', 1000);
			expect(tracer.newSpanId()).toBe('s1');
			expect(tracer.newSpanId()).toBe('s2');
			expect(tracer.newSpanId()).toBe('s3');
		});

		it('build() returns totalMs from the named root span and sorts spans by startMs', () => {
			const tracer = new Tracer('run-1', 1000);
			const rootId = tracer.newSpanId(); // s1
			const childId = tracer.newSpanId(); // s2

			// Add the child BEFORE the root to prove sorting doesn't depend on insertion order.
			tracer.addSpan(childId, rootId, 1300, 1400, 'ok', { name: 'child' });
			tracer.addSpan(rootId, undefined, 1000, 1500, 'ok', { name: 'run' });

			const trace = tracer.build(rootId);
			expect(trace.traceId).toBe('run-1');
			expect(trace.totalMs).toBe(500); // root's own durMs (1500 - 1000)
			expect(trace.spans.map((s) => s.spanId)).toEqual([rootId, childId]);
			expect(trace.spans[0].startMs).toBe(0);
			expect(trace.spans[1].startMs).toBe(300);
			expect(trace.spans[1].parentSpanId).toBe(rootId);
		});

		it('build() returns totalMs 0 when the named root span was never added', () => {
			const tracer = new Tracer('run-1', 1000);
			const trace = tracer.build('s-missing');
			expect(trace.totalMs).toBe(0);
			expect(trace.spans).toEqual([]);
		});

		it('addExternalSpans folds gate-span drafts in, assigning fresh ids and the given parent', () => {
			const tracer = new Tracer('run-1', 1000);
			const rootId = tracer.newSpanId();
			tracer.addSpan(rootId, undefined, 1000, 1200, 'ok', { name: 'run' });
			const parentId = tracer.newSpanId(); // e.g. the loader span

			tracer.addExternalSpans(
				[
					{ startAbsMs: 1050, endAbsMs: 1080, status: 'ok', attrs: { name: 'resource.read', url: 'https://a' } },
					{ startAbsMs: 1090, endAbsMs: 1090, status: 'error', attrs: { name: 'resource.read', url: 'https://b', denied: 'nope' } },
				],
				parentId,
			);

			const trace = tracer.build(rootId);
			const gateSpans = trace.spans.filter((s) => s.parentSpanId === parentId);
			expect(gateSpans).toHaveLength(2);
			// Fresh ids distinct from root/parent, no collisions.
			const ids = new Set(trace.spans.map((s) => s.spanId));
			expect(ids.size).toBe(trace.spans.length);
			expect(gateSpans[0].startMs).toBe(50);
			expect(gateSpans[0].status).toBe('ok');
			expect(gateSpans[1].status).toBe('error');
			expect(gateSpans[1].attrs.denied).toBe('nope');
		});
	});
});
