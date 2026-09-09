import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HunkWithContext } from '../diff/index.js';
import { AsyncWorkQueue } from '../utils/async.js';
import type { analyzeFile, analyzeReviewUnit } from './analyze.js';
import { executeReviewPlan, runFileReviews, type FileReview } from './review-files.js';
import { blockId, singleBlockUnit, type ReviewUnit } from './review-unit.js';
import type { FileAnalysisResult, HunkAnalysisResult } from './types.js';
import { emptyUsage } from './usage.js';

function hunk(filename: string): HunkWithContext {
  return { filename, language: 'python', contextBefore: [], contextAfter: [], contextStartLine: 10,
    hunk: { oldStart: 10, oldCount: 1, newStart: 10, newCount: 1,
      content: '@@ -10,1 +10,1 @@\n-old\n+value = Kind.ACTIVE', lines: ['-old', '+value = Kind.ACTIVE'] } };
}
function fileReview(target: HunkWithContext): FileReview<FileAnalysisResult> {
  return { file: { filename: target.filename, hunks: [target] },
    callbacks: { onHunkStart: vi.fn(), onChunkComplete: vi.fn() }, complete: vi.fn((result) => result) };
}
const group = (...members: HunkWithContext[]): ReviewUnit => ({ kind: 'group', id: members.map(blockId).join('-'), members, references: [] });
const success = (unit: ReviewUnit): HunkAnalysisResult => ({ findings: [], usage: { ...emptyUsage(), costUSD: 2 },
  failed: false, extractionFailed: false, reviewedBlocks: unit.members.map(blockId), responseModel: 'actual-model' });

afterEach(() => vi.unstubAllEnvs());

describe('unit execution and file reporting', () => {
  it('executes a multi-file unit once and preserves lane identity, response model and cost', async () => {
    const a = hunk('src/a.py');
    const b = hunk('src/b.py');
    const reviews = [fileReview(b), fileReview(a)];
    const unit = group(a, b);
    const execute = vi.fn(async () => ({ ...success(unit), findings: [{ id: 'bug', severity: 'high' as const,
      title: 'Broken', description: 'Broken', location: { path: b.filename, startLine: 10 } }] }));
    const results = await executeReviewPlan([unit], reviews, new AsyncWorkQueue(1), { model: 'configured-model' }, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.filename)).toEqual(['src/b.py', 'src/a.py']);
    expect(results.map((result) => result.usage.costUSD)).toEqual([0, 2]);
    expect(results[0]?.findings).toHaveLength(1);
    expect(results[0]?.responseModels).toEqual(['actual-model']);
    expect(reviews[0]?.callbacks?.onChunkComplete).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'src/b.py', model: 'configured-model', batchId: unit.id, blockId: blockId(b), failed: false,
    }));
    expect(reviews[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('accepts a singleton unit without a grouped coverage declaration', async () => {
    const target = hunk('a.py');
    const unit = singleBlockUnit(target);
    const results = await executeReviewPlan([unit], [fileReview(target)], new AsyncWorkQueue(1), {},
      async () => ({ ...success(unit), reviewedBlocks: undefined }));
    expect(results[0]?.failedHunks).toBe(0);
  });

  it('starts progress only when a unit is dispatched and records queued cancellation', async () => {
    const a = hunk('a.py');
    const b = hunk('b.py');
    const reviews = [fileReview(a), fileReview(b)];
    const controller = new AbortController();
    let release: () => void = () => { throw new Error('Gate is not initialized'); };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (unit: ReviewUnit) => { await gate; controller.abort(); return success(unit); });
    const running = executeReviewPlan([group(a), group(b)], reviews, new AsyncWorkQueue(1), { abortController: controller }, execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(reviews[0]?.callbacks?.onHunkStart).toHaveBeenCalledTimes(1);
    expect(reviews[1]?.callbacks?.onHunkStart).not.toHaveBeenCalled();
    release();
    const results = await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results[0]?.failedHunks).toBe(0);
    expect(results[1]?.hunkFailures[0]).toMatchObject({ filename: 'b.py', code: 'aborted' });
    expect(reviews[1]?.callbacks?.onChunkComplete).toHaveBeenCalledWith(expect.objectContaining({ failed: true }));
  });

  it('marks unacknowledged blocks failed and preserves completed coverage', async () => {
    const a = hunk('a.py');
    const b = hunk('b.py');
    const unit = group(a, b);
    const results = await executeReviewPlan([unit], [fileReview(a), fileReview(b)], new AsyncWorkQueue(1), {},
      async () => ({ ...success(unit), reviewedBlocks: [blockId(a)] }));
    expect(results.map((result) => result.failedHunks)).toEqual([0, 1]);
  });

  it('preserves attempt counts and extraction diagnostics in file reports', async () => {
    const a = hunk('a.py');
    const b = hunk('b.py');
    const results = await executeReviewPlan([group(a), group(b)], [fileReview(a), fileReview(b)], new AsyncWorkQueue(1), {},
      async (unit) => unit.members[0] === a
        ? { ...success(unit), failed: true, attempts: 2, failureCode: 'sdk_error', failureMessage: 'Timeout' }
        : { ...success(unit), extractionFailed: true, extractionError: 'invalid_json', extractionPreview: 'invalid output' });
    expect(results[0]?.hunkFailures[0]).toMatchObject({ attempts: 2, code: 'sdk_error' });
    expect(results[1]?.hunkFailures[0]).toMatchObject({ type: 'extraction', preview: 'invalid output' });
  });
});

describe('grouping activation', () => {
  const skill = { name: 'review', description: 'Review', prompt: 'Find bugs.' };
  const config = { enabled: false, minChunks: 24, maxFiles: 8, maxPromptChars: 48000 };
  it.each([
    { flag: '', explicit: undefined, grouped: false },
    { flag: 'true', explicit: undefined, grouped: true },
    { flag: 'false', explicit: undefined, grouped: false },
    { flag: 'true', explicit: false, grouped: false },
    { flag: '', explicit: true, grouped: true },
  ])('honors the fork default and explicit overrides: $flag / $explicit', async ({ flag, explicit, grouped }) => {
    vi.stubEnv('WARDEN_GROUPING_ENABLED', flag);
    const reviews = Array.from({ length: 24 }, (_, index) => fileReview(hunk(`src/file${index}.py`)));
    const legacy = vi.fn<typeof analyzeFile>(async (_skill, file) => ({ filename: file.filename, findings: [], usage: emptyUsage(),
      failedHunks: 0, failedExtractions: 0, hunkFailures: [] }));
    const execute = vi.fn<typeof analyzeReviewUnit>(async (_skill, unit) => success(unit));
    const results = await runFileReviews(skill, reviews, '/repo', explicit === undefined ? {} : { chunking: { grouping: { ...config, enabled: explicit } } },
      new AsyncWorkQueue(2), undefined, { analyzeFile: legacy, analyzeReviewUnit: execute });
    expect(results).toHaveLength(24);
    expect(legacy).toHaveBeenCalledTimes(grouped ? 0 : 24);
    expect(execute).toHaveBeenCalledTimes(grouped ? 3 : 0);
  });
});
