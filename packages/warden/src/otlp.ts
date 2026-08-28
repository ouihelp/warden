import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Whether the standard OpenTelemetry environment explicitly enables OTLP traces. */
export function isOtlpTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['OTEL_SDK_DISABLED']?.toLowerCase() === 'true') return false;

  return (
    env['OTEL_TRACES_EXPORTER']
      ?.split(',')
      .some((exporter) => exporter.trim().toLowerCase() === 'otlp') ?? false
  );
}

/** Create the optional OTLP/HTTP processor configured through standard OTel variables. */
export function createOtlpSpanProcessor(
  env: NodeJS.ProcessEnv = process.env,
): SpanProcessor | undefined {
  if (!isOtlpTracingEnabled(env)) return undefined;

  return new BatchSpanProcessor(new OTLPTraceExporter());
}
