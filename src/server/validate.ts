import type {Issue, Json, SchemaNode} from '../shared/schema';
import {childPath, indexPath, parseRef} from '../shared/schema';
import type {RefResolver} from './resolve';

const MAX_ERRORS = 100;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function jsonEquals(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEquals(item, (b as Json[])[i]));
  }
  if (typeof a === 'object') {
    const aObj = a as Record<string, Json>;
    const bObj = b as Record<string, Json>;
    const keys = Object.keys(aObj);
    return !Array.isArray(b) && keys.length === Object.keys(bObj).length && keys.every(k => k in bObj && jsonEquals(aObj[k], bObj[k]));
  }
  return false;
}

function previewValue(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    // 超深嵌套的值 JSON.stringify 会抛 RangeError，此时只展示类型
    return `<${typeOf(value)}>`;
  }
}

interface WorkItem {
  node: SchemaNode;
  value: unknown;
  path: string;
  /** 同一数据位置上已经展开过的引用，用于打断 A→B→A 这类不产生数据下钻的引用环。 */
  expandedRefs: ReadonlySet<string>;
}

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * 按 schema（含其引用到的契约）校验一份样例数据。
 * 全程显式栈迭代：样例嵌套几千层也不会栈溢出。
 * 数据是有限的，每次下钻都消耗一层数据，因此递归契约（树形）也能正常终止。
 */
export function validateData(root: SchemaNode, data: unknown, resolve: RefResolver): Issue[] {
  const issues: Issue[] = [];
  const stack: WorkItem[] = [{node: root, value: data, path: '$', expandedRefs: NO_REFS}];

  while (stack.length > 0) {
    if (issues.length >= MAX_ERRORS) {
      issues.push({path: '$', message: `错误超过 ${MAX_ERRORS} 条，已截断`});
      break;
    }
    const {node, value, path, expandedRefs} = stack.pop()!;

    if (node.$ref !== undefined) {
      if (expandedRefs.has(node.$ref)) continue;
      const target = parseRef(node.$ref);
      const resolved = target ? resolve(target) : undefined;
      if (resolved === undefined) {
        issues.push({path, message: `无法解析引用 "${node.$ref}"`});
        continue;
      }
      const nextTrail = new Set(expandedRefs);
      nextTrail.add(node.$ref);
      stack.push({node: resolved, value, path, expandedRefs: nextTrail});
      continue;
    }

    if (node.type !== undefined && !typeMatches(node.type, value)) {
      issues.push({path, message: `期望类型 ${node.type}，实际为 ${typeOf(value)}`});
      continue; // 类型不符时不再下钻，避免级联噪音
    }

    if (node.enum !== undefined && !node.enum.some(item => jsonEquals(item, value as Json))) {
      issues.push({path, message: `值 ${previewValue(value)} 不在枚举范围内`});
    }

    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
    if (isObject) {
      const record = value as Record<string, unknown>;
      for (const name of node.required ?? []) {
        if (!(name in record)) {
          issues.push({path: childPath(path, name), message: '缺少必填字段'});
        }
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (key in record) {
          stack.push({node: child, value: record[key], path: childPath(path, key), expandedRefs: NO_REFS});
        }
      }
    }

    if (Array.isArray(value) && node.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        stack.push({node: node.items, value: value[i], path: indexPath(path, i), expandedRefs: NO_REFS});
      }
    }
  }
  return issues;
}
