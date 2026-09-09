import { posix } from 'node:path';
import type { GroupingConfig } from '../config/schema.js';
import type { HunkWithContext } from '../diff/index.js';
import type { PreparedFile } from './types.js';
import { blockId, type ReviewUnit } from './review-unit.js';

function source(hunk: HunkWithContext): string {
  return [...hunk.contextBefore, hunk.hunk.content, ...hunk.contextAfter].join('\n');
}

function definitions(hunk: HunkWithContext): string[] {
  return Array.from(source(hunk).matchAll(/\b(?:enum\s+(\w+)|class\s+(\w+)\s*\([^\n)]*Enum[^\n)]*\))/g),
    (match) => (match[1] ?? match[2] ?? ''));
}

function uses(hunk: HunkWithContext, names: string[]): boolean {
  const words = new Set(source(hunk).match(/\b\w+\b/g));
  return names.some((name) => words.has(name));
}

function imports(from: HunkWithContext, to: HunkWithContext): boolean {
  const module = to.filename.replace(/\.[^.]+$/, '').replace(/\/__init__$/, '');
  for (const match of source(from).matchAll(/\bfrom\s+([\w.]+)\s+import\b|(?:from\s*|import\s*|require\(\s*)['"]([^'"]+)['"]/g)) {
    const target = match[1]?.replaceAll('.', '/') ?? (match[2] ?? '');
    const resolved = target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from.filename), target)) : target;
    if (resolved === module || `${resolved}/index` === module) return true;
  }
  return false;
}

function affinity(a: HunkWithContext, b: HunkWithContext): number {
  if (a.filename === b.filename) return 400;
  if (uses(a, definitions(b)) || uses(b, definitions(a))) return 500;
  if (imports(a, b) || imports(b, a)) return 200;
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
): ReviewUnit[] {
  const all = files.flatMap((file) => file.hunks).sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : a.hunk.newStart - b.hunk.newStart);
  const enabled = config.enabled && all.length >= config.minChunks;
  const remaining = [...all];
  const result: ReviewUnit[] = [];
  const enumBlocks = all.filter((hunk) => definitions(hunk).length > 0);
  const fits = (batch: ReviewUnit): boolean =>
    new Set([...batch.members, ...batch.references].map((hunk) => hunk.filename)).size <= config.maxFiles
    && promptChars(batch) <= config.maxPromptChars;

  while (remaining.length) {
    const first = remaining.shift();
    if (!first) break;
    const batch: ReviewUnit = { kind: enabled ? 'group' : 'hunk', id: blockId(first), members: [first], references: [] };
    if (enabled && fits(batch)) {
      while (true) {
        const candidates = remaining.map((hunk) => ({ hunk, score: Math.max(...batch.members.map((member) => affinity(member, hunk))) }))
          .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
        const next = candidates.find(({ hunk }) => fits({ ...batch, members: [...batch.members, hunk] }));
        if (!next) break;
        batch.members.push(next.hunk);
        remaining.splice(remaining.indexOf(next.hunk), 1);
      }
      for (const definition of enumBlocks) {
        if (batch.members.includes(definition) || !batch.members.some((member) => uses(member, definitions(definition)))) continue;
        if (fits({ ...batch, references: [...batch.references, definition] })) batch.references.push(definition);
      }
    }
    // Oversized original chunks remain singletons. Grouping does not truncate code.
    result.push(batch);
  }
  return result;
}
