import {ALLOWED_KEYWORDS, SCHEMA_TYPES, type Issue, type SchemaType} from '../shared/types';
import {parseRef, type RefLookup} from './refs';

interface Frame {
  node: unknown;
  schemaPath: (string | number)[];
  /** 结构下钻时新鲜；跨契约 $ref 跳转时沿用，用于检测引用环。 */
  guard: Set<string> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 检查一份编辑中的契约本身是否符合“子集”的形状。
 * 悬空引用是 warning（允许先写引用方再建被引用方）；引用语法错误与引用环是 error。
 * 树形自引用会让对象图成环，靠对象身份去重，不能无限遍历。
 */
export function checkSchemaShape(root: unknown, lookup: RefLookup): Issue[] {
  const issues: Issue[] = [];
  const stack: Frame[] = [{node: root, schemaPath: [], guard: null}];
  const visited = new WeakSet<object>();

  const visit = (nextNode: unknown, nextPath: (string | number)[], nextGuard: Set<string> | null) => {
    if (isObject(nextNode)) {
      if (visited.has(nextNode)) return;
      visited.add(nextNode);
    }
    stack.push({node: nextNode, schemaPath: nextPath, guard: nextGuard});
  };
  if (isObject(root)) visited.add(root);

  while (stack.length) {
    const {node, schemaPath, guard} = stack.pop()!;

    if (!isObject(node)) {
      issues.push({scope: 'schema', path: schemaPath, code: 'schema_node', message: 'Schema 节点必须是对象'});
      continue;
    }

    for (const key of Object.keys(node)) {
      if (!(ALLOWED_KEYWORDS as readonly string[]).includes(key)) {
        issues.push({scope: 'schema', path: [...schemaPath, key], code: 'keyword', message: `不支持的关键字 "${key}"，子集只允许 ${ALLOWED_KEYWORDS.join(' / ')}`});
      }
    }

    if (node.$ref !== undefined) {
      for (const key of Object.keys(node)) {
        if (key !== '$ref') {
          issues.push({scope: 'schema', path: [...schemaPath, key], code: 'ref_mixed', message: '$ref 节点不能同时声明其它关键字'});
        }
      }
      if (typeof node.$ref !== 'string') {
        issues.push({scope: 'schema', path: [...schemaPath, '$ref'], code: 'ref_syntax', message: '$ref 必须是字符串'});
      } else {
        const target = parseRef(node.$ref);
        if (!target) {
          issues.push({scope: 'schema', path: [...schemaPath, '$ref'], code: 'ref_syntax', message: `$ref "${node.$ref}" 不是合法的契约引用（形如 "addresses" 或 "addresses@3"）`});
        } else {
          const resolved = lookup(target);
          if (!resolved) {
            issues.push({scope: 'schema', path: schemaPath, code: 'ref_dangling', message: `引用的契约 "${target.contractId}"${target.revision === 'latest' ? '（最新 revision）' : ` revision ${target.revision}`} 尚不存在，保存后该引用暂时悬空`});
          } else {
            const key = `${target.contractId}:${resolved.revision}`;
            const nextGuard = guard ?? new Set<string>();
            if (nextGuard.has(key)) {
              issues.push({scope: 'schema', path: [...schemaPath, '$ref'], code: 'ref_cycle', message: `引用链存在环（经过 ${key}），树形自引用请在 object/array 节点内部引用`});
            } else {
              nextGuard.add(key);
              visit(resolved.schema, [...schemaPath, '$ref', target.contractId], nextGuard);
            }
          }
        }
      }
      continue;
    }

    if (node.type !== undefined) {
      if (typeof node.type !== 'string' || !(SCHEMA_TYPES as readonly string[]).includes(node.type)) {
        issues.push({scope: 'schema', path: [...schemaPath, 'type'], code: 'type_value', message: `type 必须是 ${SCHEMA_TYPES.join(' / ')} 之一`});
      }
    } else {
      // 没有 type 也没有 $ref 的节点什么都不约束，允许存在但提醒一下。
      issues.push({scope: 'schema', path: schemaPath, code: 'unconstrained', message: '节点既没有 type 也没有 $ref，不会校验任何值'});
    }
    const type = node.type as SchemaType | undefined;

    if (node.properties !== undefined) {
      if (type !== 'object') {
        issues.push({scope: 'schema', path: [...schemaPath, 'properties'], code: 'keyword_placement', message: 'properties 只能出现在 type 为 object 的节点上'});
      }
      if (!isObject(node.properties)) {
        issues.push({scope: 'schema', path: [...schemaPath, 'properties'], code: 'properties_shape', message: 'properties 必须是对象'});
      } else {
        for (const name of Object.keys(node.properties)) {
          visit(node.properties[name], [...schemaPath, 'properties', name], null);
        }
      }
    }

    if (node.required !== undefined) {
      if (type !== 'object') {
        issues.push({scope: 'schema', path: [...schemaPath, 'required'], code: 'keyword_placement', message: 'required 只能出现在 type 为 object 的节点上'});
      }
      if (!Array.isArray(node.required) || node.required.some(name => typeof name !== 'string')) {
        issues.push({scope: 'schema', path: [...schemaPath, 'required'], code: 'required_shape', message: 'required 必须是字符串数组'});
      } else if (isObject(node.properties)) {
        for (const name of node.required as string[]) {
          if (!Object.prototype.hasOwnProperty.call(node.properties, name)) {
            issues.push({scope: 'schema', path: [...schemaPath, 'required'], code: 'required_unknown', message: `必填字段 "${name}" 没有在 properties 中声明`});
          }
        }
      }
    }

    if (node.items !== undefined) {
      if (type !== 'array') {
        issues.push({scope: 'schema', path: [...schemaPath, 'items'], code: 'keyword_placement', message: 'items 只能出现在 type 为 array 的节点上'});
      }
      visit(node.items, [...schemaPath, 'items'], null);
    }

    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        issues.push({scope: 'schema', path: [...schemaPath, 'enum'], code: 'enum_shape', message: 'enum 必须是非空数组'});
      } else {
        for (let i = 0; i < node.enum.length; i++) {
          const value = node.enum[i];
          if (isObject(value) || Array.isArray(value)) {
            issues.push({scope: 'schema', path: [...schemaPath, 'enum', i], code: 'enum_value', message: 'enum 值只能是标量（字符串/数字/布尔/null）'});
          }
        }
      }
    }
  }

  return issues;
}

/** 结构错误会阻止保存；悬空引用等警告不会。 */
export function blockingErrors(issues: Issue[]): Issue[] {
  return issues.filter(issue => issue.scope === 'schema' && issue.code !== 'ref_dangling' && issue.code !== 'unconstrained');
}
