import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupingConfigSchema } from '../config/schema.js';
import type { HunkWithContext } from '../diff/index.js';
import { planBatches } from './batches.js';
import { buildBlockRelations, loadDependencySources } from './dependencies.js';
import { parseFileSyntax } from './syntax.js';

function block(filename: string, source: string, start = 1, end = source.trimEnd().split('\n').length): HunkWithContext {
  const lines = source.split('\n').slice(start - 1, end).map((line) => `+${line}`);
  return { filename, contextBefore: [], contextAfter: [], contextStartLine: start, language: filename.endsWith('.py') ? 'python' : 'typescript',
    hunk: { oldStart: start, oldCount: 0, newStart: start, newCount: lines.length,
      content: `@@ -${start},0 +${start},${lines.length} @@\n${lines.join('\n')}`, lines } };
}
const files = (...blocks: HunkWithContext[]) => [...new Set(blocks.map((hunk) => hunk.filename))]
  .map((filename) => ({ filename, hunks: blocks.filter((hunk) => hunk.filename === filename) }));
const config = GroupingConfigSchema.parse({ enabled: true, minChunks: 2, maxFiles: 2 });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'warden-ast-')); dirs.push(dir); return dir; }

describe('syntax-guided grouping', () => {
  it('groups a Python function with its aliased consumer before an unrelated sibling', () => {
    const sources = new Map([
      ['a/consumer.py', 'from z.helpers import normalize as clean\n\ndef save(value):\n    return clean(value)\n'],
      ['a/other.py', 'def clean(value):\n    return value\n'],
      ['z/helpers.py', 'def normalize(value):\n    return value.strip()\n'],
    ]);
    const targets = [...sources].map(([filename, source]) => block(filename, source));
    const input = files(...targets);
    const relations = buildBlockRelations(input, sources);
    expect(relations.dependencies.get(targets[0]!)).toEqual(new Set([targets[2]]));
    const plan = planBatches(input, config, () => 100, relations);
    expect(plan[0]!.members).toEqual([targets[0], targets[2]]);
    expect(planBatches([...input].reverse(), config, () => 100, buildBlockRelations([...input].reverse(), new Map([...sources].reverse())))).toEqual(plan);
  });

  it('resolves Python class methods through constructor bindings and typed parameters', () => {
    const model = 'class Client:\n    def send(self, value):\n        return value\n';
    const caller = 'from models.client import Client as Sender\n\ndef run(client: Sender):\n    local = Sender()\n    return local.send(client.send(1))\n';
    const method = block('models/client.py', model, 2, 3);
    const consumer = block('jobs/run.py', caller, 4, 5);
    const relations = buildBlockRelations(files(method, consumer), new Map([[method.filename, model], [consumer.filename, caller]]));
    expect(relations.dependencies.get(consumer)).toContain(method);
  });

  it('resolves TypeScript classes, methods, arrows, enums and namespace imports', () => {
    const model = 'export class Client { send(value: number) { return value; } }\nexport const normalize = (value: string) => value.trim();\nexport enum Kind { Active }\n';
    const caller = 'import * as models from "../models/client.js";\nexport function run(client: models.Client) {\n  const local = new models.Client();\n  return [local.send(1), models.normalize("x"), models.Kind.Active];\n}\n';
    const targets = [block('models/client.ts', model, 1, 1), block('models/client.ts', model, 2, 2), block('models/client.ts', model, 3, 3)];
    const consumer = block('jobs/run.ts', caller, 3, 4);
    const relations = buildBlockRelations(files(...targets, consumer), new Map([['models/client.ts', model], ['jobs/run.ts', caller]]));
    expect(relations.dependencies.get(consumer)).toEqual(new Set(targets));
  });

  it('links local methods through self and this without treating them as module functions', () => {
    for (const [filename, source] of [
      ['model.py', 'class Client:\n    def run(self):\n        return self.send()\n    def send(self):\n        return 1\n'],
      ['model.ts', 'class Client {\n  run() {\n    return this.send(); }\n  send() {\n    return 1; }\n}\n'],
    ]) {
      const run = block(filename!, source!, 3, 3);
      const send = block(filename!, source!, 4, 5);
      expect(buildBlockRelations(files(run, send), new Map([[filename!, source!]])).dependencies.get(run)).toContain(send);
    }
  });

  it('resolves relative Python imports, JS default imports, inheritance and JSX components', () => {
    const sources = new Map([
      ['pkg/base.py', 'class Base:\n    pass\n'],
      ['pkg/child.py', 'from .base import Base as Parent\nclass Child(Parent):\n    pass\n'],
      ['ui/button.tsx', 'export default function Button() { return <button />; }\n'],
      ['ui/page.tsx', 'import Button from "./button";\nexport function Page() { return <Button />; }\n'],
    ]);
    const targets = [...sources].map(([filename, source]) => block(filename, source));
    const relations = buildBlockRelations(files(...targets), sources);
    expect(relations.dependencies.get(targets[1]!)).toContain(targets[0]);
    expect(relations.dependencies.get(targets[3]!)).toContain(targets[2]);
  });

  it('does not guess unknown receivers or link comments, strings and shadowed imports', () => {
    for (const extension of ['py', 'ts']) {
      const python = extension === 'py';
      const model = python ? 'def send(value):\n    return value\n' : 'export function send(value: unknown) { return value; }\n';
      const caller = python ? 'from model import send\n# send(1)\ntext = "send(1)"\ndef run(send, client):\n    return send(client.send(1))\n'
        : 'import { send } from "./model";\n// send(1)\nconst text = "send(1)";\nfunction run(send: any, client: any) { return send(client.send(1)); }\n';
      const definition = block(`model.${extension}`, model);
      const consumer = block(`caller.${extension}`, caller, 2);
      const relations = buildBlockRelations(files(definition, consumer), new Map([[definition.filename, model], [consumer.filename, caller]]));
      expect(relations.dependencies.get(consumer)?.has(definition) ?? false).toBe(false);
    }
  });

  it('keeps identically named methods separate', () => {
    const source = 'export class First { send() { return 1; } }\nexport class Second { send() { return 2; } }\n';
    const caller = 'import { First, Second } from "./model";\nfunction run() {\n  const client = new Second();\n  return client.send();\n}\n';
    const first = block('model.ts', source, 1, 1);
    const second = block('model.ts', source, 2, 2);
    const consumer = block('caller.ts', caller, 4, 4);
    const relations = buildBlockRelations(files(first, second, consumer), new Map([['model.ts', source], ['caller.ts', caller]]));
    expect(relations.dependencies.get(consumer)).toEqual(new Set([second]));
  });

  it('does not resolve a reassigned receiver or a Python loop variable through an import', () => {
    const model = 'export class Client { send() { return 1; } }\n';
    const caller = 'import { Client } from "./model";\nlet client = new Client();\nclient = unknown();\nclient.send();\n';
    const definition = block('model.ts', model);
    const consumer = block('caller.ts', caller, 4, 4);
    expect(buildBlockRelations(files(definition, consumer), new Map([['model.ts', model], ['caller.ts', caller]])).dependencies.get(consumer)).toBeUndefined();
    const python = 'from model import send\nfor send in handlers:\n    send()\nsend()\n';
    const pyDefinition = block('model.py', 'def send():\n    pass\n');
    const pyConsumer = block('caller.py', python, 4, 4);
    expect(buildBlockRelations(files(pyDefinition, pyConsumer), new Map([['model.py', 'def send():\n    pass\n'], ['caller.py', python]])).dependencies.get(pyConsumer)).toBeUndefined();
  });

  it('adds unmodified definitions as bounded context without creating extra review targets', () => {
    const source = 'export function normalize(value: string) { return value.trim(); }\n';
    const caller = 'import { normalize } from "../model";\nexport const result = normalize("x");\n';
    const consumer = block('a/consumer.ts', caller, 2, 2);
    const other = block('z/other.ts', 'export const unrelated = 1;');
    const input = files(consumer, other);
    const relations = buildBlockRelations(input, new Map([['model.ts', source], [consumer.filename, caller]]));
    const plan = planBatches(input, config, (unit) => unit.references.length ? 200 : 100, relations);
    expect(plan.flatMap((unit) => unit.members)).toEqual([consumer, other]);
    expect(plan[0]!.references.map((hunk) => hunk.filename)).toEqual(['model.ts']);
    expect(planBatches(input, { ...config, maxPromptChars: 150 }, (unit) => unit.references.length ? 200 : 100, relations)[0]!.references).toEqual([]);
  });

  it('keeps identical unmodified definitions in different modules distinct in the parse cache', () => {
    const definition = 'export function run() { return 1; }\n';
    const a = 'import { run } from "./first";\nrun();\n';
    const b = 'import { run } from "./second";\nrun();\n';
    const left = block('a.ts', a, 2, 2);
    const right = block('b.ts', b, 2, 2);
    const relations = buildBlockRelations(files(left, right), new Map([['first.ts', definition], ['second.ts', definition], ['a.ts', a], ['b.ts', b]]));
    expect([...relations.dependencies.get(left) ?? []].map((hunk) => hunk.filename)).toEqual(['first.ts']);
    expect([...relations.dependencies.get(right) ?? []].map((hunk) => hunk.filename)).toEqual(['second.ts']);
  });

  it('falls back for invalid or unsupported syntax and changes cached facts with the source', () => {
    expect(parseFileSyntax('broken.py', 'def missing(:')).toBeNull();
    expect(parseFileSyntax('unsupported.rb', 'class Client; end')).toBeNull();
    expect(parseFileSyntax('deep.ts', 'const x = ' + '('.repeat(150) + '1' + ')'.repeat(150))).toBeNull();
    expect(parseFileSyntax('model.py', 'def first():\n    pass\n')!.definitions[0]!.name).toBe('first');
    expect(parseFileSyntax('model.py', 'def second():\n    pass\n')!.definitions[0]!.name).toBe('second');
  });
});

describe('dependency source snapshots', () => {
  it('reads selected files and direct local imports without crawling unrelated files', () => {
    const dir = directory();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/caller.ts'), 'import { normalize } from "./model";\nnormalize("x");');
    writeFileSync(join(dir, 'src/model.ts'), 'export const normalize = (x: string) => x;');
    writeFileSync(join(dir, 'src/unrelated.ts'), 'export const unrelated = 1;');
    const loaded = loadDependencySources(files(block('src/caller.ts', '', 1, 1)), dir);
    expect([...loaded.keys()]).toEqual(['src/caller.ts', 'src/model.ts']);
  });

  it('uses the Git index or recorded revision instead of an unrelated working-tree edit', () => {
    const dir = directory();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    writeFileSync(join(dir, 'model.py'), 'def old():\n    pass\n');
    git('add', 'model.py');
    const tree = git('write-tree');
    writeFileSync(join(dir, 'model.py'), 'def staged():\n    pass\n');
    git('add', 'model.py');
    writeFileSync(join(dir, 'model.py'), 'def working():\n    pass\n');
    const input = files(block('model.py', '', 1, 1));
    expect(loadDependencySources(input, dir, { type: 'git-ref', ref: tree }).get('model.py')).toContain('def old');
    expect(loadDependencySources(input, dir, { type: 'git-index' }).get('model.py')).toContain('def staged');
    expect(loadDependencySources(input, dir).get('model.py')).toContain('def working');
  });

  it('does not read paths or symlinks outside the checkout', () => {
    const dir = directory();
    const outside = directory();
    writeFileSync(join(outside, 'secret.py'), 'secret = 1');
    symlinkSync(join(outside, 'secret.py'), join(dir, 'link.py'));
    expect(loadDependencySources(files(block('link.py', ''), block('../secret.py', '')), dir).size).toBe(0);
  });
});
