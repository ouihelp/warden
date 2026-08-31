import { describe, expect, it } from 'vitest';
import {
  genAiProviderName,
  genAiToolCallAttributes,
  genAiUsageAttributes,
  setGenAiAggregateUsageAttrs,
} from './otel.js';

describe('OpenTelemetry GenAI provider attribution', () => {
  it('uses provider ids from model selectors', () => {
    expect(genAiProviderName('pi', 'openai/gpt-test')).toBe('openai');
    expect(genAiProviderName('pi', 'anthropic/claude-test')).toBe('anthropic');
    expect(genAiProviderName('pi', 'xai/grok-test')).toBe('x_ai');
    expect(genAiProviderName('pi', 'gpt-test-2026', 'openai')).toBe('openai');
    expect(genAiProviderName('pi', 'grok-test', 'xai')).toBe('x_ai');
  });
});

describe('OpenTelemetry GenAI usage attributes', () => {
  it('uses current cache subset attribute names', () => {
    expect(genAiUsageAttributes({
      inputTokens: 1300,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      costUSD: 0.01,
    })).toEqual({
      'gen_ai.usage.input_tokens': 1300,
      'gen_ai.usage.output_tokens': 500,
      'gen_ai.usage.cache_read.input_tokens': 200,
      'gen_ai.usage.cache_creation.input_tokens': 100,
      'gen_ai.usage.cost': 0.01,
    });
  });

  it('keeps agent aggregate usage explicitly non-billable', () => {
    const attributes = new Map<string, unknown>();
    setGenAiAggregateUsageAttrs({
      setAttribute: (key, value) => attributes.set(key, value),
    }, {
      inputTokens: 1300,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      costUSD: 0.01,
    });

    expect(Object.fromEntries(attributes)).toEqual({
      'warden.usage.scope': 'agent',
      'warden.usage.billable': false,
      'warden.usage.input_tokens': 1300,
      'warden.usage.output_tokens': 500,
      'warden.usage.cache_read.input_tokens': 200,
      'warden.usage.cache_creation.input_tokens': 100,
      'warden.usage.cost_usd': 0.01,
    });
    expect([...attributes.keys()]).not.toContain('gen_ai.usage.input_tokens');
  });
});

describe('OpenTelemetry GenAI tool call attributes', () => {
  it('serializes tool call arguments and results for span attributes', () => {
    expect(genAiToolCallAttributes({
      agentName: 'test-skill',
      toolName: 'Read',
      toolCallId: 'tool-1',
      toolType: 'function',
      arguments: { path: 'src/index.ts' },
      result: { ok: true },
    })).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.agent.name': 'test-skill',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.arguments': '{"path":"src/index.ts"}',
      'gen_ai.tool.call.result': '{"ok":true}',
    });
  });
});
