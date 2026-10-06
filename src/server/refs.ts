import type {SchemaNode} from '../shared/types';

/**
 * $ref 语法：
 *   "addresses"        跟随最新 revision
 *   "addresses@latest" 同上（显式）
 *   "addresses@7"      钉死 revision 7
 */
export interface RefTarget {
  contractId: string;
  revision: number | 'latest';
}

export interface ResolvedRef {
  schema: SchemaNode;
  /** 实际命中的 revision；编辑中草稿自身的最新引用用 'draft'。 */
  revision: number | 'draft';
}

export type RefLookup = (target: RefTarget) => ResolvedRef | null;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidContractId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function parseRef(ref: string): RefTarget | null {
  if (typeof ref !== 'string') return null;
  const at = ref.lastIndexOf('@');
  let contractId: string;
  let revision: number | 'latest';
  if (at === -1) {
    contractId = ref;
    revision = 'latest';
  } else {
    contractId = ref.slice(0, at);
    const tail = ref.slice(at + 1);
    if (tail === 'latest') {
      revision = 'latest';
    } else {
      if (!/^\d+$/.test(tail)) return null;
      revision = Number(tail);
      if (revision < 1) return null;
    }
  }
  if (!isValidContractId(contractId)) return null;
  return {contractId, revision};
}

export function refKey(target: RefTarget): string {
  return target.revision === 'latest'
    ? `${target.contractId}@latest`
    : `${target.contractId}@${target.revision}`;
}

/**
 * 沿 $ref 链解析到一个“可检查”的节点。
 *
 * 环检测只覆盖单个数据位置上的连续 $ref 跳转：一旦沿 properties/items
 * 结构性地下钻到新的数据节点，调用方会以全新的 guard 重新开始，因此
 * 树形自引用（T.child -> T）不会被误判成环；而 T -> U -> T 这种
 * 没有任何类型信息、永不消费数据的纯引用环会被拦下。
 *
 * 返回 null 表示悬空引用；环返回 {cycle: true, key}。
 */
export interface FollowResult {
  node: SchemaNode;
  key: string | null;
}

export function followRefs(
  node: SchemaNode,
  lookup: RefLookup,
): FollowResult | null | {cycle: true; key: string} {
  let guard: Set<string> | null = null;
  let current = node;
  let key: string | null = null;
  while (current.$ref !== undefined) {
    const target = parseRef(current.$ref);
    if (!target) return null;
    const resolved = lookup(target);
    if (!resolved) return null;
    key = `${target.contractId}:${resolved.revision}`;
    if (!guard) guard = new Set();
    if (guard.has(key)) return {cycle: true, key};
    guard.add(key);
    current = resolved.schema;
  }
  return {node: current, key};
}
