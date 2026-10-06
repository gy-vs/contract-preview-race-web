import type {Issue, SchemaNode} from '../shared/schema';

/** 一个已保存的 revision。schema 不可变，每次保存追加新。 */
export interface StoredRevision {
  revision: number;
  schema: SchemaNode;
  savedAt: string;
  /** 这次保存相对上一 revision 是否是破坏性改动（经作者确认后发布）。 */
  breaking: boolean;
  /** 破坏性改动报告（非破坏性保存为空数组）。 */
  changes: Issue[];
}

export interface ContractRecord {
  id: string;
  name: string;
  /** 按 revision 升序追加，最后一个即最新。 */
  revisions: StoredRevision[];
}

export function latestRevision(record: ContractRecord): StoredRevision {
  return record.revisions[record.revisions.length - 1];
}

export type AppendResult = 'ok' | 'conflict' | 'not_found';

/**
 * 契约存储接口。默认实现是进程内的 InMemoryContractStore，
 * 换成数据库时实现同一接口并传给 createApp 即可。
 */
export interface ContractStore {
  listContracts(): Promise<Array<{id: string; name: string}>>;
  getContract(id: string): Promise<ContractRecord | undefined>;
  /** 全量快照，供校验/兼容判断/影响分析一次性装载后同步使用。 */
  snapshot(): Promise<ContractRecord[]>;
  createContract(id: string, name: string, schema: SchemaNode): Promise<'ok' | 'exists'>;
  /**
   * 追加新 revision。expectedRevision 必须与当前最新 revision 一致，
   * 否则返回 'conflict'（比较与追加在实现内部是原子的）。
   */
  appendRevision(
    id: string,
    expectedRevision: number,
    revision: {schema: SchemaNode; breaking: boolean; changes: Issue[]},
  ): Promise<AppendResult>;
}

export class InMemoryContractStore implements ContractStore {
  private readonly contracts = new Map<string, ContractRecord>();

  constructor(seed: ContractRecord[] = []) {
    for (const record of seed) this.contracts.set(record.id, record);
  }

  async listContracts(): Promise<Array<{id: string; name: string}>> {
    return [...this.contracts.values()].map(({id, name}) => ({id, name}));
  }

  async getContract(id: string): Promise<ContractRecord | undefined> {
    return this.contracts.get(id);
  }

  async snapshot(): Promise<ContractRecord[]> {
    return [...this.contracts.values()];
  }

  async createContract(id: string, name: string, schema: SchemaNode): Promise<'ok' | 'exists'> {
    if (this.contracts.has(id)) return 'exists';
    this.contracts.set(id, {
      id,
      name,
      revisions: [{revision: 1, schema, savedAt: new Date().toISOString(), breaking: false, changes: []}],
    });
    return 'ok';
  }

  async appendRevision(
    id: string,
    expectedRevision: number,
    revision: {schema: SchemaNode; breaking: boolean; changes: Issue[]},
  ): Promise<AppendResult> {
    const record = this.contracts.get(id);
    if (!record) return 'not_found';
    const latest = latestRevision(record);
    if (latest.revision !== expectedRevision) return 'conflict';
    record.revisions.push({
      revision: latest.revision + 1,
      schema: revision.schema,
      savedAt: new Date().toISOString(),
      breaking: revision.breaking,
      changes: revision.changes,
    });
    return 'ok';
  }
}
