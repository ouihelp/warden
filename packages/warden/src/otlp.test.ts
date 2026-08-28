import { describe, expect, it } from 'vitest';
import { createOtlpSpanProcessor, isOtlpTracingEnabled } from './otlp.js';

describe('OTLP telemetry', () => {
  it('stays disabled unless the standard traces exporter enables OTLP', () => {
    expect(isOtlpTracingEnabled({})).toBe(false);
    expect(isOtlpTracingEnabled({ OTEL_TRACES_EXPORTER: 'none' })).toBe(false);
  });

  it('recognizes OTLP in a standard comma-separated exporter list', () => {
    expect(isOtlpTracingEnabled({ OTEL_TRACES_EXPORTER: 'console, otlp' })).toBe(true);
  });

  it('honors the standard global SDK kill switch', () => {
    expect(
      isOtlpTracingEnabled({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_SDK_DISABLED: 'true' }),
    ).toBe(false);
  });

  it('creates a processor when OTLP tracing is enabled', async () => {
    const processor = createOtlpSpanProcessor({ OTEL_TRACES_EXPORTER: 'otlp' });

    expect(processor).toBeDefined();
    await processor?.shutdown();
  });
});
