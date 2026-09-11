import { posix } from 'node:path';
import type { GroupingConfig } from '../config/schema.js';
import type { HunkWithContext } from '../diff/index.js';
import type { PreparedFile } from './types.js';
import type { BlockRelations } from './dependencies.js';
import { blockId, type ReviewUnit } from './review-unit.js';

function affinity(a: HunkWithContext, b: HunkWithContext, relations: BlockRelations): number {
  if (relations.dependencies.get(a)?.has(b) || relations.dependencies.get(b)?.has(a)) return 500;
  if (a.filename === b.filename) return 400;
  if (relations.imports.get(a.filename)?.has(b.filename) || relations.imports.get(b.filename)?.has(a.filename)) return 200;
  if (posix.dirname(a.filename) === posix.dirname(b.filename)) return 100;
  const left = a.filename.split('/').slice(0, -1);
  const right = b.filename.split('/').slice(0, -1);
  let common = 0;
  while (common < left.length && left[common] === right[common]) common++;
  return common;
}

/** Plan bounded groups without a model call. Never omit or duplicate a target block. */
export function planBatches(
  files: PreparedFile[],
  config: GroupingConfig,
  promptChars: (batch: ReviewUnit) => number,
  relations: BlockRelations = { dependencies: new Map(), imports: new Map() },
): ReviewUnit[] {
  const all = files.flatMap((file) => file.hunks).sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : a.hunk.newStart - b.hunk.newStart);
  const enabled = config.enabled && all.length >= config.minChunks;
  const remaining = [...all];
  const result: ReviewUnit[] = [];
  const fits = (batch: ReviewUnit): boolean =>
    new Set([...batch.members, ...batch.references].map((hunk) => hunk.filename)).size <= config.maxFiles
    && promptChars(batch) <= config.maxPromptChars;

  while (remaining.length) {
    const first = remaining.shift();
    if (!first) break;
    const batch: ReviewUnit = { kind: enabled ? 'group' : 'hunk', id: blockId(first), members: [first], references: [] };
    if (enabled && fits(batch)) {
      while (true) {
        const candidates = remaining.map((hunk) => ({ hunk, score: Math.max(...batch.members.map((member) => affinity(member, hunk, relations))) }))
          .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
        const next = candidates.find(({ hunk }) => fits({ ...batch, members: [...batch.members, hunk] }));
        if (!next) break;
        batch.members.push(next.hunk);
        remaining.splice(remaining.indexOf(next.hunk), 1);
      }
      const references = [...new Set(batch.members.flatMap((member) => [...(relations.dependencies.get(member) ?? [])]))]
        .sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : a.hunk.newStart - b.hunk.newStart);
      for (const definition of references) {
        if (batch.members.includes(definition)) continue;
        if (fits({ ...batch, references: [...batch.references, definition] })) batch.references.push(definition);
      }
    }
    // Oversized original chunks remain singletons. Grouping does not truncate code.
    result.push(batch);
  }
  return result;
}
