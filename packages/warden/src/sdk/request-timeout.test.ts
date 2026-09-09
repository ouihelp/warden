import { describe, expect, it, vi } from 'vitest';
import { analyzeFile } from './analyze.js';
import { ProviderFailureCircuitBreaker } from './circuit-breaker.js';
import { getRuntime, type Runtime } from './runtimes/index.js';
import type { PreparedFile } from './types.js';
import { emptyUsage } from './usage.js';

vi.mock('./runtimes/index.js', () => ({ getRuntime: vi.fn(), getRuntimeProviderOptions: vi.fn() }));

describe('exhausted Pi request timeouts', () => {
  it.each(['LLM request idle timeout after 120000ms', 'Request timed out.'])(
    'fails one block without restarting Pi or opening the provider circuit: %s', async (message) => {
      const controller = new AbortController();
      const circuitBreaker = new ProviderFailureCircuitBreaker({ maxConsecutiveProviderFailures: 1, abortController: controller });
      const runSkill = vi.fn().mockResolvedValueOnce({ result: { status: 'provider_error', text: '', errors: [message], usage: emptyUsage() } })
        .mockResolvedValue({ result: { status: 'success', text: '{"findings":[]}', errors: [], usage: emptyUsage() } });
      vi.mocked(getRuntime).mockReturnValue({ name: 'pi', runSkill, runAuxiliary: vi.fn(), runSynthesis: vi.fn() } as unknown as Runtime);
      const file: PreparedFile = { filename: 'src/a.py', hunks: [10, 20].map((line) => ({
        filename: 'src/a.py', language: 'python', contextBefore: [], contextAfter: [], contextStartLine: line,
        hunk: { oldStart: line, newStart: line, oldCount: 1, newCount: 1, lines: ['-old', '+new'],
          content: `@@ -${line},1 +${line},1 @@\n-old\n+new` },
      })) };
      const result = await analyzeFile({ name: 'review', description: 'Review', prompt: 'Find regressions.' }, file, '/repo',
        { runtime: 'pi', concurrency: 1, abortController: controller, circuitBreaker });
      expect(runSkill).toHaveBeenCalledTimes(2);
      expect(result.failedHunks).toBe(1);
      expect(result.hunkFailures[0]).toMatchObject({ code: 'request_timeout', lineRange: '10', attempts: 1 });
      expect(controller.signal.aborted).toBe(false);
    });
});
