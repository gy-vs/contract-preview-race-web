import type {Issue, RefTarget, SchemaNode} from '../shared/schema';
import {childPath, parseRef} from '../shared/schema';

const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_KEYS = new Set(['type', 'properties', 'required', 'enum', 'items', '$ref']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验一份 schema 文档是否落在支持的子集内。
 * 迭代遍历（显式栈），不随 schema 嵌套深度递归。
 * refExists 用于确认引用目标存在（钉死的 revision 也必须存在）。
 */
export function checkSchemaDocument(
  schema: unknown,
  refExists: (target: RefTarget) => boolean,
): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(schema)) {
    return [{path: '$', message: 'schema 必须是一个 JSON 对象'}];
  }
  const stack: Array<{node: Record<string, unknown>; path: string}> = [{node: schema, path: '$'}];
  while (stack.length > 0) {
    const {node, path} = stack.pop()!;
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYS.has(key)) {
        issues.push({path, message: `不支持的关键字 "${key}"，子集仅允许: type / properties / required / enum / items / $ref`});
      }
    }

    if ('$ref' in node) {
      const ref = node.$ref;
      if (typeof ref !== 'string') {
        issues.push({path, message: '$ref 必须是字符串，形如 "contract-id" 或 "contract-id@3"'});
      } else {
        const target = parseRef(ref);
        if (!target) {
          issues.push({path, message: `$ref "${ref}" 格式非法，应为 "contract-id" 或 "contract-id@3"`});
        } else if (!refExists(target)) {
          issues.push({
            path,
            message: target.revision === null
              ? `引用的契约 "${target.id}" 不存在`
              : `引用的契约 "${target.id}" 没有 revision ${target.revision}`,
          });
        }
      }
      if (Object.keys(node).length > 1) {
        issues.push({path, message: '$ref 节点不能再包含其他关键字'});
      }
      continue;
    }

    if ('type' in node) {
      if (typeof node.type !== 'string' || !ALLOWED_TYPES.has(node.type)) {
        issues.push({path, message: `type 必须是 ${[...ALLOWED_TYPES].join(' / ')} 之一`});
      }
    }

    if ('properties' in node) {
      if (!isPlainObject(node.properties)) {
        issues.push({path, message: 'properties 必须是对象'});
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          if (!isPlainObject(child)) {
            issues.push({path: childPath(path, key), message: '属性定义必须是 schema 对象'});
          } else {
            stack.push({node: child, path: childPath(path, key)});
          }
        }
      }
    }

    if ('required' in node) {
      const required = node.required;
      if (!Array.isArray(required) || required.some(item => typeof item !== 'string')) {
        issues.push({path, message: 'required 必须是字符串数组'});
      } else {
        const seen = new Set<string>();
        for (const name of required as string[]) {
          if (seen.has(name)) issues.push({path, message: `required 中 "${name}" 重复`});
          seen.add(name);
          if (isPlainObject(node.properties) && !(name in node.properties)) {
            issues.push({path, message: `required 中的 "${name}" 未在 properties 中声明`});
          }
        }
      }
    }

    if ('enum' in node) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        issues.push({path, message: 'enum 必须是非空数组'});
      }
    }

    if ('items' in node) {
      if (!isPlainObject(node.items)) {
        issues.push({path, message: 'items 必须是 schema 对象'});
      } else {
        stack.push({node: node.items, path: `${path}[*]`});
      }
    }
  }
  return issues;
}

/** 校验通过后将 unknown 收窄为 SchemaNode（checkSchemaDocument 已保证形状合法）。 */
export function asSchemaNode(schema: unknown): SchemaNode {
  return schema as SchemaNode;
}
