import type {BreakingChange, SchemaNode} from '../shared/types';
import {parseRef, type RefLookup} from './refs';

interface PairFrame {
  oldNode: SchemaNode;
  newNode: SchemaNode;
  path: (string | number)[];
}

function resolveChain(
  node: SchemaNode,
  lookup: RefLookup,
  guard: Set<string>,
): {node: SchemaNode} | {cycle: true} {
  let current = node;
  while (current.$ref !== undefined) {
    const target = parseRef(current.$ref);
    if (!target) return {node: current};
    const resolved = lookup(target);
    if (!resolved) return {node: current};
    const key = `${target.contractId}:${resolved.revision}`;
    if (guard.has(key)) return {cycle: true};
    guard.add(key);
    current = resolved.schema;
  }
  return {node: current};
}

/**
 * 判断把契约从 oldSchema 改成 newSchema 是否会伤害既有消费方。
 * 破坏性：删字段、字段变必填、收窄类型（number→integer）、删枚举值、
 * 收紧 items / 切换引用目标等。两侧引用各自按当时存储的 revision 解析。
 */
export function findBreakingChanges(
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  oldLookup: RefLookup,
  newLookup: RefLookup,
): BreakingChange[] {
  const breaking: BreakingChange[] = [];
  const stack: PairFrame[] = [{oldNode: oldSchema, newNode: newSchema, path: []}];
  // 单次比对内的结构编号：同样的“老结构位置 × 新结构位置”只检查一次，
  // 树形自引用（T.child -> T）不会导致重复报告。
  const ids = new WeakMap<SchemaNode, number>();
  let nextId = 1;
  const identity = (node: SchemaNode): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = nextId++;
      ids.set(node, id);
    }
    return id;
  };
  const seen = new Set<string>();
  const deduped = new Set<string>();

  const report = (change: BreakingChange) => {
    const key = `${change.code}@${change.path.join('/')}`;
    if (!deduped.has(key)) {
      deduped.add(key);
      breaking.push(change);
    }
  };

  while (stack.length) {
    const frame = stack.pop()!;

    // 双侧各自解析引用；引用链上的结构（properties/items）会在下钻时被检查到。
    const oldResolved = resolveChain(frame.oldNode, oldLookup, new Set());
    const newResolved = resolveChain(frame.newNode, newLookup, new Set());
    if ('cycle' in oldResolved || 'cycle' in newResolved) continue;
    const oldNode = oldResolved.node;
    const newNode = newResolved.node;

    const pairKey = `${identity(oldNode)}::${identity(newNode)}@${frame.path.join('/')}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // 类型
    if (!oldNode.type && newNode.type) {
      report({path: frame.path, code: 'type_added', message: `新增了类型约束 ${newNode.type}（原来不校验类型），旧数据可能不满足`});
    } else if (oldNode.type && newNode.type && oldNode.type !== newNode.type) {
      if (!(oldNode.type === 'integer' && newNode.type === 'number')) {
        // integer→number 是放宽；number→integer 与其它类型互转都破坏
        report({path: frame.path, code: 'type_changed', message: `类型从 ${oldNode.type} 变成 ${newNode.type}，既有数据可能不再合法`});
      }
    }

    // enum：取消枚举约束是放宽；旧允许值在新枚举里消失才破坏
    if (oldNode.enum && newNode.enum) {
      for (const allowed of oldNode.enum) {
        if (!newNode.enum.some(candidate => deepEqual(allowed, candidate))) {
          report({path: frame.path, code: 'enum_value_removed', message: `枚举值 ${JSON.stringify(allowed)} 被删除，持有该值的旧数据将校验失败`});
        }
      }
    }

    if (oldNode.type === 'object' || newNode.type === 'object') {
      // 删字段
      if (oldNode.properties) {
        for (const name of Object.keys(oldNode.properties)) {
          if (!newNode.properties || !Object.prototype.hasOwnProperty.call(newNode.properties, name)) {
            report({path: [...frame.path, name], code: 'property_removed', message: `字段 "${name}" 被删除，消费方将读不到它`});
          }
        }
      }
      // 字段变必填
      const oldRequired = new Set(oldNode.required ?? []);
      const newRequired = new Set(newNode.required ?? []);
      for (const name of newRequired) {
        if (!oldRequired.has(name)) {
          report({path: [...frame.path, name], code: 'required_added', message: `字段 "${name}" 变成必填，旧数据可能缺少该字段`});
        }
      }
      // 共有字段递归比对
      if (oldNode.properties && newNode.properties) {
        for (const name of Object.keys(oldNode.properties)) {
          if (Object.prototype.hasOwnProperty.call(newNode.properties, name)) {
            stack.push({
              oldNode: oldNode.properties[name],
              newNode: newNode.properties[name],
              path: [...frame.path, name],
            });
          }
        }
      }
    }

    // items：新增元素约束破坏；双侧都有则递归；去掉约束是放宽
    if (!oldNode.items && newNode.items) {
      report({path: [...frame.path, '[]'], code: 'items_added', message: '新增了数组元素约束（原来元素不校验）'});
    } else if (oldNode.items && newNode.items) {
      stack.push({oldNode: oldNode.items, newNode: newNode.items, path: [...frame.path, '[]']});
    }
  }

  return breaking;
}

/** 迭代式深比较。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x === y) continue;
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
    const ax = Array.isArray(x);
    const ay = Array.isArray(y);
    if (ax !== ay) return false;
    if (ax) {
      const xa = x as unknown[];
      const ya = y as unknown[];
      if (xa.length !== ya.length) return false;
      for (let i = 0; i < xa.length; i++) stack.push([xa[i], ya[i]]);
    } else {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      const xKeys = Object.keys(xo);
      if (xKeys.length !== Object.keys(yo).length) return false;
      for (const key of xKeys) {
        if (!Object.prototype.hasOwnProperty.call(yo, key)) return false;
        stack.push([xo[key], yo[key]]);
      }
    }
  }
  return true;
}
