/**
 * 契约工作台共享类型与引用工具。
 *
 * 契约用 JSON Schema 子集书写：type / properties / required / enum / items，
 * 以及指向另一份契约的引用 { "$ref": "<contractId>" }（跟随最新）
 * 或 { "$ref": "<contractId>@<revision>" }（钉死某个 revision）。
 */

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};

/** 契约 schema 子集中的节点。保存前会先经过 schema-check 校验，之后可按此类型使用。 */
export interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: Json[];
  items?: SchemaNode;
  $ref?: string;
}

/** 解析后的引用目标；revision 为 null 表示跟随最新。 */
export interface RefTarget {
  id: string;
  revision: number | null;
}

const REF_PATTERN = /^([a-z0-9][a-z0-9-_]{0,63})(?:@([0-9]+))?$/;

export function parseRef(ref: string): RefTarget | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  return {id: match[1], revision: match[2] === undefined ? null : Number(match[2])};
}

export function formatRef(target: RefTarget): string {
  return target.revision === null ? target.id : `${target.id}@${target.revision}`;
}

export const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** 校验/兼容报告中的一条问题，path 指向样例或 schema 内的具体位置（$.a.b[0] 形式）。 */
export interface Issue {
  path: string;
  message: string;
}

export interface ContractSummary {
  id: string;
  name: string;
  revision: number;
  /** 最新 revision 是否是一次破坏性发布（作者确认后强行发布的）。 */
  breaking: boolean;
  /** 因跟随最新引用而受到破坏性改动波及的来源契约 id 列表。 */
  affectedBy: string[];
}

export interface ContractDetail {
  id: string;
  name: string;
  revision: number;
  schema: SchemaNode;
}

/** 把对象属性名拼进 JSONPath 风格路径，非法标识符用 ["..."] 形式。 */
export function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function indexPath(path: string, index: number): string {
  return `${path}[${index}]`;
}
