import type {Issue, SchemaNode} from '../shared/schema';
import {childPath, parseRef} from '../shared/schema';
import type {RefResolver} from './resolve';

/**
 * 破坏性改动判断：对比上一份 revision 与新 schema，找出对消费方（无论是解析事件的
 * 下游，还是按契约生成/校验数据的上游）可能不兼容的改动。
 *
 * 判定为破坏性的规则：
 *  - 删除字段
 *  - 字段由可选变为必填，或由必填变为可选（消费方无法再依赖其必然存在）
 *  - 类型收窄或变成不兼容类型（integer → number 是放宽，允许）
 *  - 删除枚举值，或给原本无约束的字段新增枚举约束
 *  - 数组元素约束的新增/移除
 *  - 引用改目标（含改钉死的 revision）后，新旧解析结果不兼容
 *
 * 引用两侧字符串相同视为等价直接跳过（被引用契约内部的破坏性改动由影响分析负责标记，
 * 不在此处重复报告）；不同则解析后递归比较。比较按 (旧节点, 新节点) 对记忆，
 * 自引用契约的比较会收敛，不会死循环。
 */
export function findBreakingChanges(
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  resolve: RefResolver,
): Issue[] {
  const issues: Issue[] = [];
  const seen = new WeakMap<object, WeakSet<object>>();

  function compare(oldNode: SchemaNode, newNode: SchemaNode, path: string): void {
    if (oldNode === newNode) return;
    let pairs = seen.get(oldNode);
    if (pairs?.has(newNode)) return;
    if (!pairs) {
      pairs = new WeakSet();
      seen.set(oldNode, pairs);
    }
    pairs.add(newNode);

    if (oldNode.$ref !== undefined && newNode.$ref !== undefined && oldNode.$ref === newNode.$ref) {
      return;
    }
    if (oldNode.$ref !== undefined || newNode.$ref !== undefined) {
      const oldResolved = resolveRefNode(oldNode);
      const newResolved = resolveRefNode(newNode);
      if (!oldResolved || !newResolved) {
        issues.push({path, message: '引用目标发生变化，且无法解析新旧引用以确认兼容性'});
        return;
      }
      compare(oldResolved, newResolved, path);
      return;
    }

    const oldType = oldNode.type;
    const newType = newNode.type;
    if (oldType !== newType) {
      const widening = oldType === 'integer' && newType === 'number';
      if (!widening) {
        if (oldType === undefined) {
          issues.push({path, message: `新增类型约束 ${newType}`});
        } else if (newType === undefined) {
          issues.push({path, message: `移除了类型约束 ${oldType}`});
        } else {
          issues.push({path, message: `类型由 ${oldType} 变为 ${newType}`});
        }
      }
    }

    if (oldNode.enum !== undefined && newNode.enum !== undefined) {
      const removed = oldNode.enum.filter(item => !newNode.enum!.some(next => jsonEquals(item, next)));
      if (removed.length > 0) {
        issues.push({path, message: `删除枚举值: ${removed.map(item => JSON.stringify(item)).join(', ')}`});
      }
    } else if (oldNode.enum === undefined && newNode.enum !== undefined) {
      issues.push({path, message: '新增枚举约束'});
    }

    const oldProps = oldNode.properties ?? {};
    const newProps = newNode.properties ?? {};
    for (const key of Object.keys(oldProps)) {
      if (!(key in newProps)) {
        issues.push({path: childPath(path, key), message: '字段被删除'});
      } else {
        compare(oldProps[key], newProps[key], childPath(path, key));
      }
    }

    const oldRequired = new Set(oldNode.required ?? []);
    const newRequired = new Set(newNode.required ?? []);
    for (const name of newRequired) {
      if (!oldRequired.has(name)) {
        issues.push({path: childPath(path, name), message: '字段由可选变为必填'});
      }
    }
    for (const name of oldRequired) {
      if (!newRequired.has(name)) {
        issues.push({path: childPath(path, name), message: '字段由必填变为可选'});
      }
    }

    if (oldNode.items !== undefined && newNode.items !== undefined) {
      compare(oldNode.items, newNode.items, `${path}[*]`);
    } else if (oldNode.items !== undefined) {
      issues.push({path, message: '移除了数组元素约束'});
    } else if (newNode.items !== undefined) {
      issues.push({path, message: '新增数组元素约束'});
    }
  }

  function resolveRefNode(node: SchemaNode): SchemaNode | undefined {
    if (node.$ref === undefined) return node;
    const target = parseRef(node.$ref);
    return target ? resolve(target) : undefined;
  }

  compare(oldSchema, newSchema, '$');
  return issues;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]));
  }
  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = Object.keys(aObj);
    return !Array.isArray(b) && keys.length === Object.keys(bObj).length && keys.every(k => k in bObj && jsonEquals(aObj[k], bObj[k]));
  }
  return false;
}
