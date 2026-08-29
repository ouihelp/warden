import { createServer } from 'node:http';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
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

  it('exports completed spans to an OTLP/HTTP collector', async () => {
    interface ExportedRequest {
      body: Buffer;
      contentType: string | undefined;
      url: string | undefined;
    }
    let resolveRequest: (request: ExportedRequest) => void = () => undefined;
    const requestReceived = new Promise<ExportedRequest>((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        resolveRequest({
          body: Buffer.concat(chunks),
          contentType: request.headers['content-type'],
          url: request.url,
        });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previousEndpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
    let provider: BasicTracerProvider | undefined;

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing collector port');
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] =
        `http://127.0.0.1:${address.port}/v1/traces`;

      const processor = createOtlpSpanProcessor({ OTEL_TRACES_EXPORTER: 'otlp' });
      expect(processor).toBeDefined();
      provider = new BasicTracerProvider({ spanProcessors: [processor!] });
      const span = provider.getTracer('warden-test').startSpan('review.workflow', {
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      });
      span.end();
      await provider.forceFlush();

      const exported = await requestReceived;
      expect(exported.url).toBe('/v1/traces');
      expect(exported.contentType).toContain('application/json');
      expect(exported.body.byteLength).toBeGreaterThan(0);
      const payload = exported.body.toString('utf8');
      expect(payload).toContain('review.workflow');
      expect(payload).toContain('gen_ai.operation.name');
      expect(payload).toContain('invoke_agent');
    } finally {
      await provider?.shutdown();
      if (previousEndpoint === undefined) delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
      else process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = previousEndpoint;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
