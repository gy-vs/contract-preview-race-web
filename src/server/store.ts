import type {ContractRevision, SchemaNode, StoredContract} from '../shared/types';

/** 保存输入：expectedRevision 为乐观锁；0 表示新建。 */
export interface SaveInput {
  id: string;
  name: string;
  expectedRevision: number;
  schema: SchemaNode;
}

export type SaveResult =
  | {kind: 'saved'; contract: StoredContract; revision: ContractRevision}
  | {kind: 'conflict'; current: StoredContract};

/**
 * 可替换的存储接口。默认实现是进程内 Map；要接数据库时实现同样的方法即可，
 * 服务层（service.ts）只依赖这个接口。
 */
export interface ContractStore {
  list(): Promise<StoredContract[]>;
  get(id: string): Promise<StoredContract | null>;
  save(input: SaveInput): Promise<SaveResult>;
}

function clone<T>(value: T): T {
  // 结构深度由 schema-check 限制在可控范围，这里结构化克隆足够。
  return structuredClone(value);
}

export class InMemoryContractStore implements ContractStore {
  private contracts = new Map<string, StoredContract>();

  constructor(seed?: StoredContract[]) {
    if (seed) {
      for (const contract of seed) this.contracts.set(contract.id, clone(contract));
    }
  }

  async list(): Promise<StoredContract[]> {
    return [...this.contracts.values()].map(clone);
  }

  async get(id: string): Promise<StoredContract | null> {
    const contract = this.contracts.get(id);
    return contract ? clone(contract) : null;
  }

  async save(input: SaveInput): Promise<SaveResult> {
    const existing = this.contracts.get(input.id);
    const currentRevision = existing ? existing.revisions.length : 0;
    if (input.expectedRevision !== currentRevision) {
      // 乐观锁失败：调用方基于旧 revision 编辑，返回当前内容供其合并。
      return {kind: 'conflict', current: clone(existing as StoredContract)};
    }
    const revision: ContractRevision = {
      revision: currentRevision + 1,
      createdAt: Date.now(),
      schema: clone(input.schema),
    };
    let contract: StoredContract;
    if (existing) {
      contract = {
        id: existing.id,
        name: input.name,
        revisions: [...existing.revisions, revision],
      };
    } else {
      contract = {id: input.id, name: input.name, revisions: [revision]};
    }
    this.contracts.set(input.id, contract);
    return {kind: 'saved', contract: clone(contract), revision: clone(revision)};
  }
}
