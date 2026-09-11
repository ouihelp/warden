import { createHash } from 'node:crypto';

/** Scope provider cache routing to a checkout, model, rubric, and tool set, not a conversation. */
export function reviewCacheKey(scope: {
  cwd: string;
  model: string;
  systemPrompt: string;
  toolNames: readonly string[];
}): string {
  return `warden-${createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 48)}`;
}

/** Preserve provider payloads and cache opt-outs; change only an existing OpenAI routing key. */
export function sharePromptCache(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== 'object' || !('prompt_cache_key' in payload)
    || typeof payload.prompt_cache_key !== 'string') return payload;
  return { ...payload, prompt_cache_key: key };
}
