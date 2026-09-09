import { describe, expect, it } from 'vitest';
import { GroupingConfigSchema } from '../config/schema.js';
import type { HunkWithContext } from '../diff/index.js';
import { planBatches } from './batches.js';
import { findingBlock } from './review-unit.js';
import { buildBatchUserPrompt, buildHunkSystemPrompt } from './prompt.js';
import { validateFindings } from './extract.js';

const skill = { name: 'correctness', prompt: 'Find regressions.', description: 'Review' };
const config = GroupingConfigSchema.parse({ enabled: true, minChunks: 2 });
function hunk(filename: string, code = 'value = Kind.ACTIVE', line = 10): HunkWithContext {
  return { filename, contextBefore: [], contextAfter: [], contextStartLine: line, language: 'python',
    hunk: { oldStart: line, oldCount: 1, newStart: line, newCount: 1,
      content: `@@ -${line},1 +${line},1 @@\n-old\n+${code}`, lines: ['-old', `+${code}`] } };
}
function files(hunks: HunkWithContext[]) { return hunks.map((h) => ({ filename: h.filename, hunks: [h] })); }
const chars = (batch: Parameters<typeof buildBatchUserPrompt>[1]) => buildHunkSystemPrompt(skill, undefined, true).length + buildBatchUserPrompt(skill, batch).length;
const finding = (path: string, startLine = 10) => ({ id: 'abc', title: 'Regression', description: 'Broken', severity: 'high' as const, location: { path, startLine } });

describe('deterministic review batches', () => {
  it('keeps small and disabled reviews as singleton sessions', () => {
    const input = files([hunk('a.py'), hunk('b.py')]);
    expect(planBatches(input, { ...config, enabled: false }, chars).map((b) => b.members.length)).toEqual([1, 1]);
    expect(planBatches(input, { ...config, minChunks: 3 }, chars).map((b) => b.members.length)).toEqual([1, 1]);
  });

  it('groups an enum with a consumer across directories before an unrelated sibling', () => {
    const definition = hunk('api/enums.py', 'class Kind(OhStrEnum):');
    const consumer = hunk('billing/service.py');
    const unrelated = hunk('api/other.py', 'value = 1');
    const batches = planBatches(files([unrelated, consumer, definition]), { ...config, maxFiles: 2 }, chars);
    expect(batches[0]!.members).toEqual([definition, consumer]);
    expect(batches.flatMap((b) => b.members)).toHaveLength(3);
    expect(planBatches(files([definition, consumer, unrelated]), { ...config, maxFiles: 2 }, chars)).toEqual(batches);
  });

  it('uses explicit imports when there is no enum reference', () => {
    const a = hunk('a/source.py', 'from z.model import Record');
    const b = hunk('a/unrelated.py', 'value = 1');
    const model = hunk('z/model.py', 'class Record:');
    expect(planBatches(files([a, b, model]), { ...config, maxFiles: 2 }, chars)[0]!.members).toEqual([a, model]);
  });

  it('bounds the full prompt including surrounding context and never loses oversized blocks', () => {
    const input = Array.from({ length: 19 }, (_, index) => hunk(`api/f${index}.py`));
    input[4]!.contextBefore = ['x'.repeat(20_000)];
    const cap = chars({ kind: 'group', id: 'unused', members: [input[0]!], references: [] }) + 500;
    const batches = planBatches(files(input), { ...config, maxFiles: 3, maxPromptChars: cap }, chars);
    expect(new Set(batches.flatMap((b) => b.members))).toEqual(new Set(input));
    for (const batch of batches) {
      expect(new Set([...batch.members, ...batch.references].map((h) => h.filename)).size).toBeLessThanOrEqual(3);
      if (chars(batch) > cap) expect(batch.members).toEqual([input[4]]);
    }
  });

  it('adds already assigned enum definitions as bounded reference context', () => {
    const definition = hunk('a/enums.py', 'class Kind(OhStrEnum):');
    const consumers = [hunk('b/a.py'), hunk('c/b.py')];
    const batches = planBatches(files([definition, ...consumers]), { ...config, maxFiles: 2 }, chars);
    expect(batches[1]!.references).toContain(definition);
    expect(findingBlock(finding(definition.filename), batches[1]!)).toBeUndefined();
  });

  it('rejects paths and ranges outside targets without rewriting another file into the first file', () => {
    const first = hunk('a.py');
    const second = hunk('b.py');
    const batch = { kind: 'group' as const, id: 'batch', members: [first, second], references: [] };
    const validated = validateFindings([finding('b.py'), finding('../escape.py')], new Set(['a.py', 'b.py']));
    expect(validated).toHaveLength(1);
    expect(findingBlock(validated[0]!, batch)).toBe(second);
    expect(findingBlock(finding('b.py', 300), batch)).toBeUndefined();
    first.hunk.content += '\n...\n@@ -100,1 +100,1 @@\n-old\n+new';
    first.hunk.newCount = 91;
    expect(findingBlock(finding('a.py', 50), batch)).toBeUndefined();
    expect(findingBlock(finding('a.py', 100), batch)).toBe(first);
  });

  it('keeps the PR prefix identical between groups', () => {
    const context = { title: 'Enums', changedFiles: ['z.py', 'a.py'] };
    const prompt = (path: string) => buildBatchUserPrompt(skill, { kind: 'group', id: path, members: [hunk(path)], references: [] }, context);
    expect(prompt('a.py').split('<target_block')[0]).toBe(prompt('z.py').split('<target_block')[0]);
  });
});
