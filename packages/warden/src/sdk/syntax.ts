import { createHash } from 'node:crypto';
import type { SyntaxNode, Tree } from '@lezer/common';
import { parser as javascript } from '@lezer/javascript';
import { parser as python } from '@lezer/python';

export interface Definition {
  name: string;
  kind: 'class' | 'function' | 'method' | 'type';
  from: number;
  to: number;
  scope: number;
  owner?: Definition;
  exported: string[];
  members?: string[];
}
export interface ImportBinding { module: string; imported: string[] }
export interface Binding {
  definition?: Definition;
  import?: ImportBinding;
  instance?: string[];
  /** Scope in which an instance's constructor/type expression was written. */
  typeScope?: number;
}
export interface SyntaxScope { parent?: number; bindings: Map<string, Binding[]>; owner?: Definition }
export interface Reference { parts: string[]; from: number; to: number; scope: number }
export interface FileSyntax {
  definitions: Definition[];
  references: Reference[];
  scopes: SyntaxScope[];
  imports: ImportBinding[];
  lineStarts: number[];
}

function children(node: SyntaxNode | null): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

const functionNodes = new Set(['FunctionDefinition', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration']);
const classNodes = new Set(['ClassDefinition', 'ClassDeclaration']);
const typeNodes = new Set(['EnumDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration']);
const identifiers = new Set(['VariableName', 'VariableDefinition', 'TypeName', 'TypeDefinition', 'PropertyDefinition']);
const cache = new Map<string, FileSyntax | null>();

/** Recognize languages whose definitions and references the grouping analyzer understands. */
export function supportsSyntax(filename: string): boolean {
  return /\.(?:py|[cm]?[jt]sx?)$/i.test(filename);
}

/** Extract a small AST of declarations, lexical bindings, and references from a syntax tree. */
export function parseFileSyntax(filename: string, source: string): FileSyntax | null {
  if (!supportsSyntax(filename) || source.length > 1_000_000) return null;
  const isPython = filename.endsWith('.py');
  const dialect = /\.[cm]?tsx?$/.test(filename) ? 'ts jsx' : 'jsx';
  const key = `${filename}:${isPython ? 'py' : dialect}:${createHash('sha256').update(source).digest('hex')}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let tree: Tree;
  try { tree = (isPython ? python : javascript.configure({ dialect })).parse(source); }
  catch { return null; }
  let invalid = false;
  let depth = 0;
  tree.iterate({
    enter(node) { depth++; if (node.type.isError || depth > 128) invalid = true; },
    leave() { depth--; },
  });
  // A recovered parse can invent scope boundaries. Use path affinity instead.
  if (invalid) return null;
  const result: FileSyntax = { definitions: [], references: [], scopes: [{ bindings: new Map() }], imports: [], lineStarts: [0] };
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') result.lineStarts.push(index + 1);
  const text = (node: SyntaxNode) => source.slice(node.from, node.to);
  const ignored = new Set<number>();
  const frame = (scope: number): SyntaxScope => {
    const value = result.scopes[scope];
    if (!value) throw new Error('Missing syntax scope');
    return value;
  };
  const bind = (scope: number, name: string, binding: Binding) => {
    const bindings = frame(scope).bindings;
    bindings.set(name, [...(bindings.get(name) ?? []), binding]);
  };
  const path = (node: SyntaxNode | null): string[] | undefined => {
    if (!node) return undefined;
    if (identifiers.has(node.name) || node.name === 'this') return [text(node)];
    if (node.name === 'JSXIdentifier' && node.parent?.name !== 'JSXAttribute' && /^[A-Z]/.test(text(node))) return [text(node)];
    if (['MemberExpression', 'IndexedType', 'JSXMemberExpression'].includes(node.name)) {
      const items = children(node);
      const property = items.at(-1);
      const base = path(items[0] ?? null);
      return base && property && ['PropertyName', 'TypeName', 'JSXIdentifier'].includes(property.name) && items[1]?.name === '.' ? [...base, text(property)] : undefined;
    }
    return undefined;
  };
  const importStatement = (node: SyntaxNode, scope: number) => {
    const items = children(node);
    const add = (local: string, module: string, imported: string[]) => {
      const entry = { module, imported };
      result.imports.push(entry);
      bind(scope, local, { import: entry });
    };
    if (isPython) {
      const keyword = items.findIndex((item) => item.name === 'import');
      const module = items[0]?.name === 'from' ? items.slice(1, keyword).map(text).join('') : undefined;
      const groups: SyntaxNode[][] = [[]];
      for (const item of items.slice(keyword + 1)) {
        if (item.name === ',') groups.push([]);
        else if (item.name !== '(' && item.name !== ')') groups.at(-1)?.push(item);
      }
      for (const group of groups) {
        const alias = group.findIndex((item) => item.name === 'as');
        const name = (alias < 0 ? group : group.slice(0, alias)).map(text).join('');
        if (!name || name === '*') continue;
        const aliasNode = group[alias + 1];
        const local = alias < 0 ? name.split('.')[0] ?? name : aliasNode ? text(aliasNode) : name;
        if (module !== undefined) add(local, module, name.split('.'));
        else if (alias >= 0 || !name.includes('.')) add(local, name, []);
        // Unaliased dotted imports require a package namespace; leave them unresolved.
      }
    } else {
      const moduleNode = node.getChild('String');
      if (!moduleNode) return;
      const module = text(moduleNode).slice(1, -1);
      const group = node.getChild('ImportGroup');
      if (group) {
        const entries = children(group);
        for (let index = 0; index < entries.length; index++) {
          const item = entries[index];
          if (!item) continue;
          if (item.name !== 'VariableName' && item.name !== 'VariableDefinition') continue;
          const alias = entries[index + 1]?.name === 'as' ? entries[index + 2] : undefined;
          add(text(alias ?? item), module, [text(item)]);
          if (alias) index += 2;
        }
      }
      const local = node.getChild('VariableDefinition');
      if (local) add(text(local), module, node.getChild('Star') ? [] : ['default']);
    }
  };
  const visit = (node: SyntaxNode, scope: number, owner?: Definition): void => {
    if (node.name === 'ImportStatement' || node.name === 'ImportDeclaration') {
      importStatement(node, scope);
      return;
    }
    const isClass = classNodes.has(node.name);
    const isFunction = functionNodes.has(node.name);
    const isType = typeNodes.has(node.name);
    if (node.name === 'MethodDeclaration' && owner?.kind !== 'class') return;
    if (isClass || isFunction || isType) {
      const nameNode = node.name === 'ArrowFunction' ? undefined : children(node).find((child) => ['VariableName', 'VariableDefinition', 'PropertyDefinition', 'TypeDefinition'].includes(child.name));
      const variable = node.parent?.name === 'VariableDeclaration' ? node.parent : undefined;
      const assignedName = variable ? variable.getChild('VariableDefinition') : null;
      const name = assignedName ?? nameNode;
      const method = owner?.kind === 'class' && (isPython || node.name === 'MethodDeclaration');
      const definition: Definition | undefined = name ? {
        name: text(name), kind: isClass ? 'class' : isType ? 'type' : method ? 'method' : 'function',
        from: node.from, to: node.to, scope, owner,
        members: node.name === 'EnumDeclaration' ? children(node.getChild('EnumBody')).filter((child) => child.name === 'PropertyName').map(text) : undefined,
        exported: scope === 0 && (isPython || node.parent?.name === 'ExportDeclaration' || variable?.parent?.name === 'ExportDeclaration')
          ? [text(name), ...(node.parent?.getChild('default') ? ['default'] : [])] : [],
      } : undefined;
      if (definition && name) {
        result.definitions.push(definition);
        bind(scope, definition.name, { definition });
        ignored.add(name.from);
      }
      if (isType) {
        for (const child of children(node)) visit(child, scope, owner);
        return;
      }
      const inner = result.scopes.length;
      // Python methods cannot resolve bare names in the enclosing class namespace.
      result.scopes.push({ bindings: new Map(), parent: isPython && method ? frame(scope).parent : scope, owner: definition });
      if (node.name === 'FunctionExpression' && nameNode && definition) {
        bind(inner, text(nameNode), { definition });
        ignored.add(nameNode.from);
      }
      const params = node.getChild('ParamList');
      if (params) {
        const items = children(params);
        for (const [index, param] of items.entries()) {
          if (!['VariableName', 'VariableDefinition'].includes(param.name)) continue;
          const annotation = items[index + 1];
          const type = annotation && ['TypeDef', 'TypeAnnotation'].includes(annotation.name) ? path(annotation.lastChild) : undefined;
          bind(inner, text(param), type ? { instance: type, typeScope: scope } : {});
          ignored.add(param.from);
        }
      }
      if (method && owner) {
        if (isPython) {
          const receiver = params?.getChild('VariableName');
          if (receiver && ['self', 'cls'].includes(text(receiver))) {
            frame(inner).bindings.set(text(receiver), [{ definition: owner }]);
          }
        } else bind(inner, 'this', { definition: owner });
      }
      for (const child of children(node)) {
        // Bases, decorators and annotations resolve where the declaration is written.
        visit(child, ['Body', 'Block', 'ClassBody'].includes(child.name) || node.name === 'ArrowFunction' ? inner : scope, definition ?? owner);
      }
      return;
    }
    if (node.name === 'Block') {
      const inner = result.scopes.length;
      result.scopes.push({ bindings: new Map(), parent: scope, owner });
      scope = inner;
    }
    if (['VariableDeclaration', 'AssignStatement', 'AssignmentExpression'].includes(node.name)) {
      const items = children(node);
      const equal = items.findIndex((item) => item.name === 'Equals' || item.name === 'AssignOp');
      const target = equal >= 0 ? items.slice(0, equal).find((item) => ['VariableName', 'VariableDefinition'].includes(item.name)) : undefined;
      const value = equal >= 0 ? items[equal + 1] : undefined;
      const targets = equal >= 0 ? items.slice(0, equal).filter((item) => ['VariableName', 'VariableDefinition'].includes(item.name)) : [];
      if (targets.length > 1) {
        for (const target of targets) { bind(scope, text(target), {}); ignored.add(target.from); }
      } else if (target) {
        const constructor = value?.name === 'NewExpression' ? children(value).find((item) => item.name !== 'new')
          : isPython && value?.name === 'CallExpression' ? value.firstChild : undefined;
        const instance = path(constructor ?? null);
        if (!value || !functionNodes.has(value.name) || node.name === 'AssignmentExpression') {
          if (owner?.kind === 'class' && result.scopes[scope]?.owner === owner) {
            const definition: Definition = { name: text(target), kind: 'type', from: node.from, to: node.to, scope, owner, exported: [] };
            result.definitions.push(definition);
            bind(scope, text(target), { definition });
          } else {
            let bindingScope = scope;
            if (node.name === 'AssignmentExpression') {
              let candidate: number | undefined = scope;
              while (candidate !== undefined) {
                if (frame(candidate).bindings.has(text(target))) { bindingScope = candidate; break; }
                candidate = frame(candidate).parent;
              }
            }
            bind(bindingScope, text(target), instance ? { instance, typeScope: scope } : {});
          }
          ignored.add(target.from);
        } else ignored.add(target.from);
      }
    }
    // Unhandled declarations shadow imports too. Do not guess through destructuring.
    if (node.name === 'VariableDefinition' && !ignored.has(node.from)) {
      bind(scope, text(node), {});
      ignored.add(node.from);
    }
    if (isPython && ['ForStatement', 'WithStatement', 'LambdaExpression'].includes(node.name)) {
      const items = children(node);
      const limit = items.findIndex((item) => item.name === 'in' || item.name === 'Body' || item.name === ':');
      for (const item of items.slice(0, limit < 0 ? items.length : limit)) {
        if (item.name === 'VariableName') bind(scope, text(item), {});
      }
      // These introduce bindings whose scope rules need a dedicated resolver.
      // Suppress their references rather than linking an identically named import.
      return;
    }
    const reference = path(node);
    if (reference && !ignored.has(node.from) && !['MemberExpression', 'IndexedType', 'JSXMemberExpression'].includes(node.parent?.name ?? '')) {
      result.references.push({ parts: reference, from: node.from, to: node.to, scope });
    }
    for (const child of children(node)) visit(child, scope, owner);
  };
  visit(tree.topNode, 0);
  // Bound process-wide reuse across lanes. Keys include content, not only a filename.
  const oldest = cache.keys().next().value;
  if (cache.size >= 128 && oldest !== undefined) cache.delete(oldest);
  cache.set(key, result);
  return result;
}

/** Convert parser offsets to the one-based line coordinates used by diff blocks. */
export function syntaxLine(syntax: FileSyntax, offset: number): number {
  let low = 0;
  let high = syntax.lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((syntax.lineStarts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
