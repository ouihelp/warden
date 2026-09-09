import type { analyzeFile, analyzeReviewUnit } from './analyze.js';
import { GroupingConfigSchema, type SkillDefinition } from '../config/schema.js';
import { buildBatchUserPrompt, buildHunkSystemPrompt, type PRPromptContext } from './prompt.js';
import { getHunkLineRange, type HunkWithContext } from '../diff/index.js';
import type { HunkFailure } from '../types/index.js';
import type { AsyncWorkQueue } from '../utils/async.js';
import { planBatches } from './batches.js';
import { mapExtractionErrorCode } from './errors.js';
import { blockId, findingBlock, type ReviewUnit } from './review-unit.js';
import type { ChunkAnalysisResult, FileAnalysisCallbacks, FileAnalysisResult, HunkAnalysisCallbacks, HunkAnalysisResult, PreparedFile, SkillRunnerOptions } from './types.js';
import { aggregateUsage, emptyUsage } from './usage.js';

/** File reporting is an adapter; a file does not own a grouped conversation. */
export interface FileReview<Result> {
  file: PreparedFile;
  callbacks?: FileAnalysisCallbacks;
  complete(result: FileAnalysisResult): Result;
}

function lineRange(hunk: HunkWithContext): string {
  const { start, end } = getHunkLineRange(hunk.hunk);
  return start === end ? `${start}` : `${start}-${end}`;
}

interface CompletedBlock {
  chunk: ChunkAnalysisResult;
  responseModel?: string;
  attempts?: number;
}

function fileResult(filename: string, blocks: CompletedBlock[]): FileAnalysisResult {
  const chunks = blocks.map((block) => block.chunk);
  const hunkFailures: HunkFailure[] = blocks.flatMap(({ chunk, attempts }): HunkFailure[] => {
    if (chunk.failed) return [{ type: 'analysis', filename, lineRange: chunk.lineRange,
      code: chunk.failureCode ?? 'unknown', message: chunk.failureMessage ?? 'Analysis failed', ...(attempts !== undefined ? { attempts } : {}) }];
    if (chunk.extractionFailed) return [{ type: 'extraction', filename, lineRange: chunk.lineRange,
      code: mapExtractionErrorCode(chunk.extractionError), message: chunk.extractionError ?? 'Extraction failed', ...(chunk.extractionPreview !== undefined ? { preview: chunk.extractionPreview } : {}) }];
    return [];
  });
  return {
    filename,
    findings: chunks.flatMap((chunk) => chunk.findings),
    usage: aggregateUsage(chunks.map((chunk) => chunk.usage)),
    failedHunks: chunks.filter((chunk) => chunk.failed).length,
    failedExtractions: chunks.filter((chunk) => !chunk.failed && chunk.extractionFailed).length,
    hunkFailures,
    auxiliaryUsage: chunks.flatMap((chunk) => chunk.auxiliaryUsage ?? []),
    traces: chunks.flatMap((chunk) => chunk.trace ? [chunk.trace] : []),
    responseModels: blocks.flatMap((block) => block.responseModel ? [block.responseModel] : []),
  };
}

/** Schedule each unit once, then emit original-block coverage and file reports. */
export async function executeReviewPlan<Result>(
  units: ReviewUnit[],
  reviews: FileReview<Result>[],
  queue: AsyncWorkQueue,
  options: SkillRunnerOptions,
  execute: (unit: ReviewUnit, callbacks?: HunkAnalysisCallbacks) => Promise<HunkAnalysisResult>,
): Promise<Result[]> {
  const states = reviews.map((review) => ({ review, chunks: new Map<number, CompletedBlock>(),
    completed: undefined as { value: Result } | undefined }));
  const blocks = new Map<HunkWithContext, { state: typeof states[number]; index: number }>();
  for (const state of states) state.review.file.hunks.forEach((hunk, index) => blocks.set(hunk, { state, index }));
  for (const state of states) {
    if (state.review.file.hunks.length === 0) state.completed = { value: state.review.complete(fileResult(state.review.file.filename, [])) };
  }
  await Promise.all(units.map((unit) => queue.run(async () => {
    const first = unit.members[0];
    if (!first) throw new Error('A review unit must contain a target block');
    const primary = blocks.get(first);
    if (!primary) throw new Error('Review unit target is missing from the file inventory');
    const started = Date.now();
    const cancelled = options.abortController?.signal.aborted;
    if (!cancelled) {
      for (const hunk of unit.members) {
        const block = blocks.get(hunk);
        block?.state.review.callbacks?.onHunkStart?.(block.index + 1, block.state.review.file.hunks.length, lineRange(hunk));
      }
    }
    const result: HunkAnalysisResult = cancelled
      ? { findings: [], usage: emptyUsage(), failed: true, extractionFailed: false,
          failureCode: 'aborted', failureMessage: 'Analysis aborted before unit started' }
      : await execute(unit, { ...primary.state.review.callbacks, lineRange: lineRange(first) });
    const durationMs = Date.now() - started;
    for (const hunk of unit.members) {
      const block = blocks.get(hunk);
      if (!block) throw new Error('Review unit target is missing from the file inventory');
      const { state, index } = block;
      const { review } = state;
      // Unit usage stays intact until this compatibility adapter attributes it once.
      const owner = hunk === first;
      const missing = unit.kind === 'group' && !result.failed && !result.extractionFailed && !result.reviewedBlocks?.includes(blockId(hunk));
      const findings = result.findings.filter((finding) => findingBlock(finding, unit) === hunk);
      const skillStartTime = review.callbacks?.skillStartTime;
      if (skillStartTime !== undefined) for (const finding of findings) finding.elapsedMs = Date.now() - skillStartTime;
      const chunk: ChunkAnalysisResult = {
        filename: hunk.filename, index: index + 1, total: review.file.hunks.length,
        lineRange: lineRange(hunk), batchId: unit.id, blockId: blockId(hunk),
        model: options.model,
        findings, usage: owner ? result.usage : emptyUsage(), durationMs,
        failed: result.failed || missing, extractionFailed: result.extractionFailed,
        failureCode: missing ? 'sdk_error' : result.failureCode,
        failureMessage: missing ? 'Unit output did not acknowledge this block as reviewed' : result.failureMessage,
        extractionError: result.extractionError, extractionPreview: result.extractionPreview,
        auxiliaryUsage: owner ? result.auxiliaryUsage : undefined, trace: owner ? result.trace : undefined,
      };
      state.chunks.set(index, { chunk, responseModel: result.responseModel, attempts: result.attempts });
      review.callbacks?.onHunkComplete?.(index + 1, findings, chunk.usage);
      review.callbacks?.onChunkComplete?.(chunk);
      if (state.chunks.size === review.file.hunks.length) {
        const ordered = [...state.chunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
        state.completed = { value: review.complete(fileResult(review.file.filename, ordered)) };
      }
    }
  }, { signal: options.abortController?.signal, delayMs: options.parallel === false ? 0 : options.batchDelayMs })));
  return states.map((state) => {
    if (!state.completed) throw new Error('Review plan did not cover every file');
    return state.completed.value;
  });
}

/** Execute explicit review units; adapt their results to the existing file reports. */
export async function runFileReviews<Result>(
  skill: SkillDefinition,
  reviews: FileReview<Result>[],
  repoPath: string,
  options: SkillRunnerOptions,
  queue: AsyncWorkQueue,
  prContext: PRPromptContext | undefined,
  executors: {
    analyzeFile: typeof analyzeFile;
    analyzeReviewUnit: typeof analyzeReviewUnit;
  },
): Promise<Result[]> {
  const config = GroupingConfigSchema.parse({
    ...options.chunking?.grouping,
    enabled: options.chunking?.grouping?.enabled ?? process.env['WARDEN_GROUPING_ENABLED'] === 'true',
  });
  const files = reviews.map((review) => review.file);
  const grouped = config.enabled && files.reduce((sum, file) => sum + file.hunks.length, 0) >= config.minChunks;
  if (!grouped) {
    const run = async (review: FileReview<Result>) => review.complete(await executors.analyzeFile(
      skill, review.file, repoPath, options, review.callbacks, prContext, queue));
    if (options.parallel !== false) return Promise.all(reviews.map(run));
    const results: Result[] = [];
    for (const review of reviews) {
      if (options.abortController?.signal.aborted) break;
      results.push(await run(review));
    }
    return results;
  }
  const systemChars = buildHunkSystemPrompt(skill, options.historicalEvidence, true).length;
  const units = planBatches(files, config,
    (unit) => systemChars + buildBatchUserPrompt(skill, unit, prContext).length);
  const scoped = { ...options, abortController: options.abortController ?? new AbortController() };
  return executeReviewPlan(units, reviews, queue, scoped,
    (unit, callbacks) => executors.analyzeReviewUnit(skill, unit, repoPath, scoped, callbacks, prContext)
      .catch((error: unknown) => { scoped.abortController.abort(); throw error; }));
}
