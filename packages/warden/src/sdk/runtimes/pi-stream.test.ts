import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { withStreamIdleTimeout } from './pi-stream.js';

const model: Model<'anthropic-messages'> = {
  id: 'test-model', name: 'Test', api: 'anthropic-messages', provider: 'anthropic',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096,
};
const message: AssistantMessage = {
  role: 'assistant', api: model.api, provider: model.provider, model: model.id,
  content: [{ type: 'text', text: '{"findings":[]}' }], stopReason: 'stop', timestamp: 0,
  usage: {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

afterEach(() => vi.useRealTimers());

describe('provider stream idle deadline', () => {
  it('ends a silent stream and cancels its transport even if the provider ignores cancellation', async () => {
    vi.useFakeTimers();
    const source = createAssistantMessageEventStream();
    let signal: AbortSignal | undefined;
    const stream = await withStreamIdleTimeout((_model, _context, options) => {
      signal = options?.signal;
      return source;
    }, 90_000)(model, { messages: [] });

    await vi.advanceTimersByTimeAsync(90_000);
    expect(signal?.aborted).toBe(true);
    expect(await stream.result()).toMatchObject({
      stopReason: 'error', errorMessage: 'Provider stream idle timeout after 90000ms',
    });
    // Late provider output must not replace the failure or execute a partial tool call.
    source.push({ type: 'done', reason: 'stop', message });
    expect(await stream.result()).toHaveProperty('stopReason', 'error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the idle deadline on progress and keeps an active response alive', async () => {
    vi.useFakeTimers();
    const source = createAssistantMessageEventStream();
    const stream = await withStreamIdleTimeout(() => source, 90_000)(model, { messages: [] });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(80_000);
      source.push({ type: 'text_delta', contentIndex: 0, delta: 'text', partial: message });
      await vi.advanceTimersByTimeAsync(0);
    }
    source.push({ type: 'done', reason: 'stop', message });
    expect(await stream.result()).toEqual(message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation as terminal rather than a retryable timeout', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const source = createAssistantMessageEventStream();
    const stream = await withStreamIdleTimeout(() => source, 90_000)(model, { messages: [] }, { signal: caller.signal });
    caller.abort();
    expect(await stream.result()).toHaveProperty('stopReason', 'aborted');
    expect(vi.getTimerCount()).toBe(0);
    source.end(message);
  });

  it('bounds waiting for stream creation before the first event', async () => {
    vi.useFakeTimers();
    const stream = await withStreamIdleTimeout(() => new Promise(() => { /* Provider never opens the stream. */ }), 90_000)(model, { messages: [] });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await stream.result()).toHaveProperty('stopReason', 'error');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Pi session recovery', () => {
  let session: AgentSession | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    session?.dispose();
    session = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function createSession(): Promise<AgentSession> {
    directory = await mkdtemp(join(tmpdir(), 'warden-stream-'));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'), modelsPath: null,
      modelsStorePath: join(directory, 'models'), refreshOnCreate: false, allowModelNetwork: false,
    });
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager, systemPrompt: 'Review the supplied code.',
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime, model, tools: [], resourceLoader,
      settingsManager, sessionManager: SessionManager.inMemory(directory),
    });
    session = result.session;
    return session;
  }

  it('retries the interrupted turn once in the same conversation and retains completed work', async () => {
    const current = await createSession();
    const prior = { ...message, content: [{ type: 'text' as const, text: 'Already checked views.py' }] };
    current.agent.state.messages = [{ role: 'user', content: 'Review views.py', timestamp: 0 }, prior];
    const stalled = createAssistantMessageEventStream();
    const provider = vi.fn<AgentSession['agent']['streamFunction']>()
      .mockImplementationOnce(() => stalled)
      .mockImplementationOnce(() => {
        const success = createAssistantMessageEventStream();
        success.push({ type: 'done', reason: 'stop', message });
        return success;
      });
    current.agent.streamFunction = withStreamIdleTimeout(provider, 20);
    await current.prompt('Review the test file', { expandPromptTemplates: false });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1]?.[1].messages).toContainEqual(prior);
    expect(current.agent.state.messages.at(-1)).toMatchObject({ stopReason: 'stop', content: message.content });
    expect(current.agent.state.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    stalled.end(message);
  });

  it('stops after one failed retry and reports an error', async () => {
    const current = await createSession();
    const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
    const provider = vi.fn<AgentSession['agent']['streamFunction']>()
      .mockImplementationOnce(() => streams[0]!)
      .mockImplementationOnce(() => streams[1]!);
    current.agent.streamFunction = withStreamIdleTimeout(provider, 20);
    await current.prompt('Review the test file', { expandPromptTemplates: false });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(current.agent.state.messages.at(-1)).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('idle timeout') });
    streams.forEach((stream) => stream.end(message));
  });
});
