import { expect, it } from 'vitest';
import { reviewCacheKey, sharePromptCache } from './prompt-cache.js';

it('shares routing keys without sharing messages or conversation identifiers', () => {
  const scope = { cwd: '/repo', model: 'openai/gpt', systemPrompt: 'Review', toolNames: ['read'] };
  const key = reviewCacheKey(scope);
  const first = { prompt_cache_key: 'session-1', input: ['one'], previous_response_id: 'response-1' };
  const second = { prompt_cache_key: 'session-2', input: ['two'] };
  expect(sharePromptCache(first, key)).toEqual({ ...first, prompt_cache_key: key });
  expect(sharePromptCache(second, key)).toEqual({ ...second, prompt_cache_key: key });
  expect(first.prompt_cache_key).toBe('session-1');
  expect(reviewCacheKey({ ...scope, systemPrompt: 'Different rubric' })).not.toBe(key);
  expect(reviewCacheKey({ ...scope, cwd: '/other' })).not.toBe(key);
  expect(key).not.toContain('/repo');
  expect(key.length).toBeLessThanOrEqual(64);
});

it('preserves cache opt-out and non-OpenAI payloads', () => {
  const payload = { prompt_cache_key: undefined, input: [] };
  expect(sharePromptCache(payload, 'shared')).toBe(payload);
  const anthropic = { system: [{ text: 'review', cache_control: { type: 'ephemeral' } }] };
  expect(sharePromptCache(anthropic, 'shared')).toBe(anthropic);
});
