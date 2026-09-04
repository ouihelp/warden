import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureLocalTracing, Sentry } from './sentry.js';
import { startTraceRecorder, startTracedSpan, withTraceRecorder } from './sentry-trace.js';
import type { TraceSpan } from './types/index.js';

describe('structured trace capture', () => {
  beforeEach(async () => {
    delete process.env['WARDEN_SENTRY_DSN'];
    await Sentry.close(0);
  });

  afterEach(async () => {
    await Sentry.close(0);
  });

  it('records local child spans when telemetry is not configured', async () => {
    ensureLocalTracing();

    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;
    let spans: TraceSpan[] | undefined;

    await Sentry.startSpan({ op: 'test.root', name: 'test root' }, async (rootSpan) => {
      await Sentry.startSpan({ op: 'skill.run', name: 'run security-review' }, async (span) => {
        const parentContext = span.spanContext();
        parentTraceId = parentContext.traceId;
        parentSpanId = parentContext.spanId;
        const traceRecorder = startTraceRecorder(span);

        await startTracedSpan(
          {
            op: 'gen_ai.invoke_agent',
            name: 'invoke_agent security-review',
            parentSpan: span,
            attributes: {
              'gen_ai.operation.name': 'invoke_agent',
            },
          },
          () => undefined,
          traceRecorder,
        );

        await startTracedSpan(
          {
            op: 'test.sibling',
            name: 'unrelated sibling',
            parentSpan: rootSpan,
          },
          () => undefined,
          traceRecorder,
        );

        spans = traceRecorder.snapshot();
      });
    });

    expect(spans).toEqual([
      expect.objectContaining({
        traceId: parentTraceId,
        parentSpanId,
        op: 'gen_ai.invoke_agent',
        name: 'invoke_agent security-review',
        attributes: expect.objectContaining({
          'gen_ai.operation.name': 'invoke_agent',
        }),
      }),
    ]);
  });

  it('records only spans created inside a parentless recorder context', async () => {
    ensureLocalTracing();
    const traceRecorder = startTraceRecorder(undefined);

    await withTraceRecorder(traceRecorder, () => startTracedSpan(
      { op: 'gen_ai.invoke_agent', name: 'invoke_agent security-review' },
      (agentSpan) => startTracedSpan(
        {
          op: 'gen_ai.chat',
          name: 'chat',
          parentSpan: agentSpan,
        },
        () => undefined,
      ),
    ));
    await startTracedSpan(
      { op: 'test.unrelated', name: 'not explicitly recorded' },
      () => undefined,
    );

    const spans = traceRecorder.snapshot();
    const agentSpan = spans?.find((span) => span.op === 'gen_ai.invoke_agent');
    expect(spans).toHaveLength(2);
    expect(spans?.find((span) => span.op === 'gen_ai.chat')?.parentSpanId).toBe(agentSpan?.spanId);
    expect(spans?.some((span) => span.op === 'test.unrelated')).toBe(false);
  });
});
