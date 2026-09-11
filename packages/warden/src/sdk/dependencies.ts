import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import { getHunkLineRange, parsePatch, type HunkWithContext } from '../diff/index.js';
import type { DiffContextSource } from '../types/index.js';
import { GIT_NON_INTERACTIVE_ENV } from '../utils/exec.js';
import type { PreparedFile } from './types.js';
import { parseFileSyntax, supportsSyntax, syntaxLine, type Definition, type FileSyntax, type ImportBinding, type SyntaxScope } from './syntax.js';

export interface BlockRelations {
  dependencies: Map<HunkWithContext, Set<HunkWithContext>>;
  imports: Map<string, Set<string>>;
}
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

function moduleCandidates(filename: string, module: string): string[] {
  if (filename.endsWith('.py')) {
    const relative = module.match(/^\.+/)?.[0].length ?? 0;
    const suffix = module.slice(relative).replaceAll('.', '/');
    const base = relative ? posix.join(posix.dirname(filename), '../'.repeat(relative - 1), suffix) : suffix;
    return [`${base}.py`, `${base}/__init__.py`];
  }
  // Package aliases need project configuration. Never guess by basename.
  if (!module.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(filename), module));
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  return [...new Set([base, ...extensions.map((ext) => `${stem}${ext}`), ...extensions.map((ext) => `${base}/index${ext}`)])];
}

function resolveModule(filename: string, binding: ImportBinding, sources: ReadonlyMap<string, string>): string | undefined {
  const matches = moduleCandidates(filename, binding.module).filter((candidate) => sources.has(candidate));
  // Source and generated siblings or a module and package with the same name are ambiguous.
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read only the selected revision and a bounded, one-hop set of local imports. */
export function loadDependencySources(
  files: PreparedFile[], repoPath: string, contentSource: DiffContextSource = { type: 'working-tree' },
): Map<string, string> {
  const sources = new Map<string, string>();
  const attempted = new Set<string>();
  let remainingBytes = 16_000_000;
  const root = resolve(repoPath);
  const read = (filename: string) => {
    if (attempted.has(filename) || !supportsSyntax(filename) || remainingBytes <= 0) return;
    attempted.add(filename);
    if (filename.startsWith('/') || filename.split('/').includes('..')) return;
    try {
      let source: string;
      if (contentSource.type === 'working-tree') {
        const fullPath = realpathSync(resolve(root, filename));
        const realRoot = realpathSync(root);
        if (!fullPath.startsWith(realRoot + sep) || statSync(fullPath).size > Math.min(1_000_000, remainingBytes)) return;
        source = readFileSync(fullPath, 'utf8');
      } else {
        const object = contentSource.type === 'git-index' ? `:${filename}` : `${contentSource.ref}:${filename}`;
        source = execFileSync('git', ['show', object], { cwd: root, encoding: 'utf8',
          timeout: 1000, maxBuffer: Math.min(1_000_000, remainingBytes),
          env: { ...process.env, ...GIT_NON_INTERACTIVE_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      remainingBytes -= Buffer.byteLength(source);
      if (remainingBytes >= 0) sources.set(filename, source);
    } catch { /* Missing, oversized, or unreadable sources keep path-based grouping. */ }
  };
  const selected = [...new Set(files.map((file) => file.filename))].sort().slice(0, 512);
  for (const filename of selected) read(filename);
  const candidates = new Set<string>();
  for (const filename of selected) {
    const source = sources.get(filename);
    if (source === undefined) continue;
    for (const binding of parseFileSyntax(filename, source)?.imports ?? []) {
      for (const candidate of moduleCandidates(filename, binding.module)) candidates.add(candidate);
    }
  }
  // Bound failed lookups as well as successful reads. No recursive repository crawl.
  for (const filename of [...candidates].sort().slice(0, 256)) read(filename);
  return sources;
}

interface ResolvedDefinition { filename: string; definition: Definition }

/** Link blocks through unambiguous lexical bindings, imports, and known class receivers. */
export function buildBlockRelations(files: PreparedFile[], sources: ReadonlyMap<string, string>): BlockRelations {
  const result: BlockRelations = { dependencies: new Map(), imports: new Map() };
  const syntax = new Map<string, FileSyntax>();
  for (const [filename, source] of sources) {
    const parsed = parseFileSyntax(filename, source);
    if (parsed) syntax.set(filename, parsed);
  }
  const member = (target: ResolvedDefinition, parts: string[]): ResolvedDefinition | undefined => {
    for (const name of parts) {
      if (target.definition.members?.includes(name)) return target;
      if (target.definition.kind !== 'class') return undefined;
      const matches = syntax.get(target.filename)?.definitions.filter((definition) => definition.owner === target.definition && definition.name === name) ?? [];
      const definition = matches.length === 1 ? matches[0] : undefined;
      if (!definition) return undefined;
      target = { filename: target.filename, definition };
    }
    return target;
  };
  const resolveReference = (filename: string, parts: string[], scope: number, depth = 0): ResolvedDefinition | undefined => {
    const name = parts[0];
    if (depth > 8 || name === undefined) return undefined;
    const parsed = syntax.get(filename);
    if (!parsed) return undefined;
    let current: number | undefined = scope;
    while (current !== undefined) {
      const frame: SyntaxScope | undefined = parsed.scopes[current];
      if (!frame) return undefined;
      const bindings = frame.bindings.get(name);
      if (bindings) {
        if (bindings.length !== 1) return undefined;
        const binding = bindings[0];
        if (!binding) return undefined;
        if (binding.definition) return member({ filename, definition: binding.definition }, parts.slice(1));
        if (binding.instance) {
          const target = resolveReference(filename, binding.instance, binding.typeScope ?? current, depth + 1);
          return target?.definition.kind === 'class' ? member(target, parts.slice(1)) : undefined;
        }
        if (binding.import) {
          const module = resolveModule(filename, binding.import, sources);
          if (!module) return undefined;
          const names = [...binding.import.imported, ...parts.slice(1)];
          const definitions = syntax.get(module)?.definitions.filter((definition) => definition.exported.includes(names[0] ?? '')) ?? [];
          const definition = definitions.length === 1 ? definitions[0] : undefined;
          return definition ? member({ filename: module, definition }, names.slice(1)) : undefined;
        }
        return undefined;
      }
      current = frame.parent;
    }
    return undefined;
  };
  const blocks = new Map(files.map((file) => [file.filename, file.hunks]));
  const intersects = (hunk: HunkWithContext, start: number, end: number) => parsePatch(hunk.hunk.content)
    .map(getHunkLineRange).some((range) => range.start <= end && range.end >= start);
  const contexts = new Map<Definition, HunkWithContext>();
  const definitionBlocks = ({ filename, definition }: ResolvedDefinition): HunkWithContext[] => {
    // Constants need the containing class contract, including enum base changes.
    if (definition.kind === 'type' && definition.owner?.kind === 'class') definition = definition.owner;
    const parsed = syntax.get(filename);
    const source = sources.get(filename);
    if (!parsed || source === undefined) return [];
    const start = syntaxLine(parsed, definition.from);
    const end = syntaxLine(parsed, Math.max(definition.from, definition.to - 1));
    const targets = blocks.get(filename)?.filter((hunk) => intersects(hunk, start, end)) ?? [];
    if (targets.length) return targets;
    let context = contexts.get(definition);
    if (!context) {
      // Large definitions contribute their header only. They are context, never targets.
      const lines = source.split('\n').slice(start - 1, end - start < 120 ? end : start + 15);
      const count = lines.length;
      const diffLines = lines.map((line) => ` ${line}`);
      context = { filename, language: filename.endsWith('.py') ? 'python' : 'typescript',
        contextBefore: [], contextAfter: [], contextStartLine: start,
        hunk: { oldStart: start, oldCount: count, newStart: start, newCount: count,
          lines: diffLines, content: `@@ -${start},${count} +${start},${count} @@\n${diffLines.join('\n')}` } };
      contexts.set(definition, context);
    }
    return [context];
  };
  for (const file of files) {
    const parsed = syntax.get(file.filename);
    if (!parsed) continue;
    const imported = new Set<string>();
    for (const binding of parsed.imports) {
      const module = resolveModule(file.filename, binding, sources);
      if (module) imported.add(module);
    }
    result.imports.set(file.filename, imported);
    for (const reference of parsed.references) {
      const target = resolveReference(file.filename, reference.parts, reference.scope);
      if (!target) continue;
      const line = syntaxLine(parsed, reference.from);
      const enclosing = parsed.definitions.filter((definition) => definition.from <= reference.from && definition.to >= reference.to)
        .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
      const owners = file.hunks.filter((hunk) => intersects(hunk, line, line)
        || enclosing && intersects(hunk, syntaxLine(parsed, enclosing.from), syntaxLine(parsed, enclosing.to - 1)));
      for (const owner of owners) {
        const dependencies = result.dependencies.get(owner) ?? new Set<HunkWithContext>();
        for (const dependency of definitionBlocks(target)) if (dependency !== owner) dependencies.add(dependency);
        result.dependencies.set(owner, dependencies);
      }
    }
  }
  return result;
}
