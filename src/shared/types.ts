/**
 * 契约使用的 JSON Schema 子集：
 * type / properties / required / enum / items，以及 $ref 跨契约引用。
 */
export type SchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export const SCHEMA_TYPES: readonly SchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

/** 子集允许出现的关键字；$ref 节点不允许与其它关键字同时出现。 */
export const ALLOWED_KEYWORDS = ['type', 'properties', 'required', 'enum', 'items', '$ref'] as const;

export interface SchemaNode {
  type?: SchemaType;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: unknown[];
  items?: SchemaNode;
  $ref?: string;
}

export interface ContractRevision {
  revision: number;
  createdAt: number;
  schema: SchemaNode;
}

export interface StoredContract {
  id: string;
  name: string;
  revisions: ContractRevision[];
}

export interface ContractSummary {
  id: string;
  name: string;
  revision: number;
  /** 跟随最新的引用链上存在破坏性改动时给出影响来源；钉死 revision 的引用不会产生影响。 */
  affected: AffectedSource[];
}

export interface AffectedSource {
  /** 最初发生破坏性改动的契约。 */
  source: string;
  /** 影响传导链，从当前契约一直到源头，例如 [当前, 中间, 源头]。 */
  chain: string[];
}

export type IssueScope = 'schema' | 'sample';

export interface Issue {
  scope: IssueScope;
  /** 相对契约根节点 / 样例根节点的路径段。 */
  path: (string | number)[];
  code: string;
  message: string;
}

export interface BreakingChange {
  path: (string | number)[];
  code: string;
  message: string;
}
