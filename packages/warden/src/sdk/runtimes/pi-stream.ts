import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';

type StreamFn = AgentSession['agent']['streamFunction'];

/** Cancel a silent provider call without aborting the session, so Pi can retry that turn. */
export function withStreamIdleTimeout(streamFn: StreamFn, idleTimeoutMs: number, onIdleTimeout?: () => void): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let partial: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error', timestamp: Date.now(),
    };

    function cleanup(): void {
      finished = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }

    function fail(message: string, aborted = false): void {
      if (finished) return;
      cleanup();
      const reason = aborted ? 'aborted' : 'error';
      // Never expose an unfinished tool call as an executable result.
      const error: AssistantMessage = { ...partial, stopReason: reason, errorMessage: message };
      output.push({ type: 'error', reason, error });
      controller.abort();
    }

    function onAbort(): void {
      fail('Request was aborted', true);
    }

    function resetTimer(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(`Provider stream idle timeout after ${idleTimeoutMs}ms`);
        onIdleTimeout?.();
      }, idleTimeoutMs);
    }

    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
      return output;
    }
    resetTimer();
    void (async () => {
      try {
        const source = await streamFn(model, context, { ...options, signal: controller.signal });
        if (finished) return;
        for await (const event of source) {
          if (finished) break;
          if (event.type === 'done' || event.type === 'error') {
            cleanup();
            output.push(event);
            return;
          }
          partial = event.partial;
          resetTimer();
          output.push(event);
        }
        if (!finished) fail('Provider stream ended before a terminal response event');
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();
    return output;
  };
}
