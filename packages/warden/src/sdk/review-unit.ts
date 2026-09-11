import { createHash } from 'node:crypto';
import { getHunkLineRange, parsePatch, type HunkWithContext } from '../diff/index.js';
import type { Finding } from '../types/index.js';

export interface ReviewUnit {
  kind: 'hunk' | 'group';
  id: string;
  members: HunkWithContext[];
  /** Related definitions are context only; their own batch owns their coverage. */
  references: HunkWithContext[];
}

/** Stable identity within a prepared diff, independent of scheduling and skill. */
export function blockId(hunk: HunkWithContext): string {
  return createHash('sha256').update(hunk.filename).update('\0')
    .update(hunk.hunk.content).digest('hex').slice(0, 16);
}

/** A legacy hunk is the smallest review unit. */
export function singleBlockUnit(hunk: HunkWithContext): ReviewUnit {
  return { kind: 'hunk', id: blockId(hunk), members: [hunk], references: [] };
}

/** Locate findings on target blocks only, never on context-only definitions. */
export function findingBlock(finding: Finding, batch: ReviewUnit): HunkWithContext | undefined {
  if (!finding.location) return batch.members[0];
  const location = finding.location;
  return batch.members.find((member) => {
    if (member.filename !== location.path) return false;
    // Coalescing retains original @@ headers. Do not accept the unreviewed gaps.
    const ranges = parsePatch(member.hunk.content).map(getHunkLineRange);
    return ranges.some((range) => location.startLine >= range.start
      && (location.endLine ?? location.startLine) <= range.end
      && (location.endLine ?? location.startLine) >= location.startLine);
  });
}
