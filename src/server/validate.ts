import type {Issue, SchemaNode} from '../shared/types';
import {renderJsonPath} from '../shared/path';
import {parseRef, type RefLookup} from './refs';

type ActualType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function actualType(value: unknown): ActualType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as ActualType;
}

interface Frame {
  value: unknown;
  node: SchemaNode;
  /** 进入该帧前路径栈的深度；退出时回退到这里。 */
  sampleDepth: number;
  schemaDepth: number;
  /** 进入该帧需要压入的相对路径段。 */
  sampleSegment: string | number | null;
  schemaSegments: (string | number)[];
  guard: Set<string> | null;
  /**
   * enter：首次进入，执行检查；
   * array：数组游标派发，元素子帧在本帧路径之上运行；
   * done：子帧已派发，本帧只需在再次回到栈顶时退出。
   */
  phase: 'enter' | 'array' | 'done';
  arrayIndex?: number;
  arrayItems?: SchemaNode;
}

/**
 * 用“契约 + 它引用到的契约”校验一段样例数据。显式栈驱动：
 * 路径是共享可变栈、每帧只记进入前深度，递归契约（树形自引用）配
 * 几千层嵌套样例时既不爆调用栈，也不会有 O(n²) 的路径复制。
 *
 * 递归样例可能在每一层都报出同一种错误（例如每层都缺 id），错误总
 * 长度因此是 O(深度²)。这里给问题数量设上限，超出部分以 truncated 标记。
 */
export const MAX_SAMPLE_ISSUES = 300;

export function validateSample(rootSchema: SchemaNode, sample: unknown, lookup: RefLookup): {issues: Issue[]; truncated: boolean} {
  const issues: Issue[] = [];
  let truncated = false;
  const report = (issue: Issue) => {
    if (issues.length < MAX_SAMPLE_ISSUES) {
      issues.push(issue);
    } else {
      truncated = true;
    }
  };
  const sampleSegments: (string | number)[] = [];
  const schemaSegments: (string | number)[] = [];

  const exit = (frame: Frame) => {
    sampleSegments.length = frame.sampleDepth;
    schemaSegments.length = frame.schemaDepth;
    stack.pop();
  };

  const stack: Frame[] = [{
    value: sample,
    node: rootSchema,
    sampleDepth: 0,
    schemaDepth: 0,
    sampleSegment: null,
    schemaSegments: [],
    guard: null,
    phase: 'enter',
  }];

  while (stack.length) {
    const frame = stack[stack.length - 1];

    if (frame.phase === 'done') {
      exit(frame);
      continue;
    }

    if (frame.phase === 'array') {
      const array = frame.value as unknown[];
      if ((frame.arrayIndex ?? 0) < array.length) {
        // 元素子帧在父帧路径之上运行；父帧仍留在栈中持有路径段
        const i = frame.arrayIndex ?? 0;
        frame.arrayIndex = i + 1;
        stack.push({
          value: array[i],
          node: frame.arrayItems ?? {},
          sampleDepth: sampleSegments.length,
          schemaDepth: schemaSegments.length,
          sampleSegment: i,
          schemaSegments: ['items'],
          guard: null,
          phase: 'enter',
        });
        continue;
      }
      exit(frame);
      continue;
    }

    // 首次进入：压入相对路径段
    if (frame.sampleSegment !== null) sampleSegments.push(frame.sampleSegment);
    for (const segment of frame.schemaSegments) schemaSegments.push(segment);

    const currentSamplePath = [...sampleSegments];
    const currentSchemaPath = [...schemaSegments];

    // 1) 沿当前数据位置解析 $ref 链（结构性下钻时 guard 重置，树形自引用不算环）
    let node: SchemaNode | null = frame.node;
    let guard = frame.guard;
    while (node && node.$ref !== undefined) {
      const target = parseRef(node.$ref);
      if (!target) {
        report({scope: 'schema', path: currentSchemaPath, code: 'ref_syntax', message: `$ref "${node.$ref}" 不是合法的契约引用`});
        node = null;
        break;
      }
      let resolved;
      try {
        resolved = lookup(target);
      } catch {
        resolved = null;
      }
      if (!resolved) {
        report({scope: 'schema', path: currentSchemaPath, code: 'ref_dangling', message: `引用的契约 "${target.contractId}"${target.revision === 'latest' ? '（最新 revision）' : ` revision ${target.revision}`} 不存在`});
        node = null;
        break;
      }
      const key = `${target.contractId}:${resolved.revision}`;
      if (!guard) guard = new Set();
      if (guard.has(key)) {
        report({scope: 'schema', path: currentSchemaPath, code: 'ref_cycle', message: `引用链存在无法落到具体类型的环（经过 ${key}）`});
        node = null;
        break;
      }
      guard.add(key);
      node = resolved.schema;
    }
    if (!node) {
      exit(frame);
      continue;
    }

    const actual = actualType(frame.value);

    // 2) 类型不符：该子树不再继续
    if (node.type && !typeMatches(node.type, actual, frame.value)) {
      report({scope: 'sample', path: currentSamplePath, code: 'type', message: `期望类型 ${node.type}，实际是 ${actual}`});
      exit(frame);
      continue;
    }

    // 3) enum
    if (node.enum && !node.enum.some(candidate => deepEqual(candidate, frame.value))) {
      const allowed = node.enum.map(value => JSON.stringify(value)).join(' / ');
      report({scope: 'sample', path: currentSamplePath, code: 'enum', message: `值不在允许的枚举范围内：${allowed}`});
    }

    // 4) object：required 报错后派发子属性；父帧以 done 留在栈底持有路径
    if (node.type === 'object' && actual === 'object') {
      const value = frame.value as Record<string, unknown>;
      if (node.required) {
        for (const name of node.required) {
          if (!Object.prototype.hasOwnProperty.call(value, name)) {
            report({scope: 'sample', path: [...currentSamplePath, name], code: 'required', message: `缺少必填字段 "${name}"`});
          }
        }
      }
      const names = node.properties
        ? Object.keys(node.properties).filter(name => Object.prototype.hasOwnProperty.call(value, name))
        : [];
      // 倒序压栈保证按声明顺序处理
      for (let k = names.length - 1; k >= 0; k--) {
        const name = names[k];
        stack.push({
          value: value[name],
          node: node.properties![name],
          sampleDepth: sampleSegments.length,
          schemaDepth: schemaSegments.length,
          sampleSegment: name,
          schemaSegments: ['properties', name],
          guard: null,
          phase: 'enter',
        });
      }
      frame.phase = 'done';
      continue;
    }

    // 5) array：切换游标派发模式（当前路径段保持在栈上）
    if (node.type === 'array' && actual === 'array') {
      frame.phase = 'array';
      frame.arrayIndex = 0;
      frame.arrayItems = node.items ?? {};
      continue;
    }

    exit(frame);
  }

  return {issues, truncated};
}

function typeMatches(expected: string, actual: ActualType, value: unknown): boolean {
  switch (expected) {
    case 'integer':
      return actual === 'number' && Number.isInteger(value as number);
    case 'number':
      return actual === 'number';
    default:
      return expected === actual;
  }
}

/** 迭代式深比较：enum 比对不能在深层样例上依赖调用栈。 */
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

export function formatIssue(issue: Issue): string {
  const where = renderJsonPath(issue.path);
  const scope = issue.scope === 'sample' ? '样例' : '契约';
  return `${where === '$' ? scope : `${scope} ${where}`}: ${issue.message}`;
}
