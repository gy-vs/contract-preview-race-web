import type {SchemaNode} from '../shared/types';

export interface DiffEntry {
  kind: 'added' | 'removed' | 'changed';
  path: string;
  detail: string;
}

/**
 * 冲突合并时在前端概括“别人改了什么”：对两份 schema 做结构对比，
 * 列出新增/删除字段、required 变化与类型/枚举/引用变化。契约深度
 * 有限（不是样例数据），但树形自引用合法，所以用节点对去重防环。
 */
export function diffSchemas(base: SchemaNode, latest: SchemaNode): DiffEntry[] {
  const entries: DiffEntry[] = [];
  // oldNode -> Set<newNode>：同一对节点只比较一次
  const pairs = new WeakMap<object, WeakSet<object>>();
  const seen = (a: object, b: object): boolean => {
    let set = pairs.get(a);
    if (!set) {
      set = new WeakSet();
      pairs.set(a, set);
    }
    if (set.has(b)) return true;
    set.add(b);
    return false;
  };

  const walk = (oldNode: SchemaNode | undefined, newNode: SchemaNode | undefined, path: string) => {
    if (oldNode === undefined && newNode !== undefined) {
      entries.push({kind: 'added', path, detail: '新增节点'});
      return;
    }
    if (oldNode !== undefined && newNode === undefined) {
      entries.push({kind: 'removed', path, detail: '节点被删除'});
      return;
    }
    if (!oldNode || !newNode) return;
    if (seen(oldNode, newNode)) return;

    const oldRef = oldNode.$ref;
    const newRef = newNode.$ref;
    if (oldRef !== newRef && (oldRef !== undefined || newRef !== undefined)) {
      entries.push({
        kind: 'changed',
        path,
        detail: `引用从 ${oldRef ?? '（无）'} 改为 ${newRef ?? '（无）'}`,
      });
    }

    if (oldNode.type !== newNode.type && (oldNode.type || newNode.type)) {
      entries.push({kind: 'changed', path, detail: `类型 ${oldNode.type ?? 'any'} → ${newNode.type ?? 'any'}`});
    }

    const childPath = (name: string) => (path === '$' ? `$.${name}` : `${path}.${name}`);

    const oldProps = oldNode.properties ?? {};
    const newProps = newNode.properties ?? {};
    for (const name of Object.keys(oldProps)) {
      if (!(name in newProps)) {
        entries.push({kind: 'removed', path: childPath(name), detail: '字段被删除'});
      } else {
        walk(oldProps[name], newProps[name], childPath(name));
      }
    }
    for (const name of Object.keys(newProps)) {
      if (!(name in oldProps)) {
        entries.push({kind: 'added', path: childPath(name), detail: '新增字段'});
      }
    }

    const oldRequired = new Set(oldNode.required ?? []);
    const newRequired = new Set(newNode.required ?? []);
    for (const name of newRequired) {
      if (!oldRequired.has(name)) entries.push({kind: 'changed', path: childPath(name), detail: '改为必填'});
    }
    for (const name of oldRequired) {
      if (!newRequired.has(name)) entries.push({kind: 'changed', path: childPath(name), detail: '改为可选'});
    }

    const oldEnum = oldNode.enum;
    const newEnum = newNode.enum;
    if (oldEnum && newEnum) {
      for (const value of oldEnum) {
        if (!newEnum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
          entries.push({kind: 'removed', path, detail: `枚举值 ${JSON.stringify(value)} 被删除`});
        }
      }
      for (const value of newEnum) {
        if (!oldEnum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
          entries.push({kind: 'added', path, detail: `枚举值 ${JSON.stringify(value)} 被新增`});
        }
      }
    }

    if (oldNode.items || newNode.items) {
      walk(oldNode.items, newNode.items, `${path}[]`);
    }
  };

  walk(base, latest, '$');
  return entries;
}
