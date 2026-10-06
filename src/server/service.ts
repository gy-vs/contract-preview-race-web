import type {
  BreakingChange,
  ContractSummary,
  Issue,
  SchemaNode,
  StoredContract,
} from '../shared/types';
import {InMemoryContractStore, type ContractStore, type SaveInput, type SaveResult} from './store';
import {SEED_CONTRACTS} from './seed';
import {checkSchemaShape} from './schema-check';
import {findBreakingChanges} from './compat';
import {validateSample} from './validate';
import {parseSample} from './json-parse';
import {computeAffected} from './impact';
import type {RefLookup, ResolvedRef} from './refs';

export interface PreviewInput {
  schema: unknown;
  sampleText: string;
  /** 编辑中的契约 id：它自身的“跟随最新”引用按草稿解析，而不是存储里的旧 revision。 */
  selfId?: string;
}

export type PreviewResult =
  | {
      ok: true;
      parseError: string | null;
      schemaIssues: Issue[];
      sampleIssues: Issue[];
      truncated: boolean;
      valid: boolean;
    }
  | {ok: false; status: 400; error: string};

export type SaveOutcome =
  | {
      kind: 'saved';
      contract: StoredContract;
      revision: number;
      breaking: BreakingChange[];
    }
  | {kind: 'version_conflict'; current: StoredContract}
  | {kind: 'breaking_blocked'; current: StoredContract; breaking: BreakingChange[]}
  | {kind: 'invalid'; issues: Issue[]}
  | {kind: 'bad_request'; error: string};

export class ContractService {
  constructor(private store: ContractStore = new InMemoryContractStore(SEED_CONTRACTS)) {}

  async list(): Promise<ContractSummary[]> {
    const contracts = await this.store.list();
    const affected = computeAffected(contracts);
    return contracts
      .map(contract => ({
        id: contract.id,
        name: contract.name,
        revision: contract.revisions.length,
        affected: affected.get(contract.id) ?? [],
      } satisfies ContractSummary))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<StoredContract | null> {
    return this.store.get(id);
  }

  /** 组装 RefLookup：草稿自身的 latest 引用指向编辑中的 schema；其它按存储解析。 */
  private buildLookup(contracts: Map<string, StoredContract>, draft?: {id: string; schema: SchemaNode}): RefLookup {
    return (target): ResolvedRef | null => {
      if (draft && target.contractId === draft.id && target.revision === 'latest') {
        return {schema: draft.schema, revision: 'draft'};
      }
      const contract = contracts.get(target.contractId);
      if (!contract) return null;
      const revIndex = target.revision === 'latest'
        ? contract.revisions.length - 1
        : contract.revisions.findIndex(item => item.revision === target.revision);
      if (revIndex < 0) return null;
      const revision = contract.revisions[revIndex];
      return {schema: revision.schema, revision: revision.revision};
    };
  }

  private async contractMap(): Promise<Map<string, StoredContract>> {
    const contracts = await this.store.list();
    return new Map(contracts.map(contract => [contract.id, contract]));
  }

  async preview(input: PreviewInput): Promise<PreviewResult> {
    const schemaIssues = checkSchemaShape(
      input.schema,
      this.buildLookup(await this.contractMap(),
        input.selfId && typeof input.schema === 'object' && input.schema !== null
          ? {id: input.selfId, schema: input.schema as SchemaNode}
          : undefined,
      ),
    );

    let sample: unknown = null;
    let parseError: string | null = null;
    const trimmed = (input.sampleText ?? '').trim();
    if (trimmed.length > 0) {
      try {
        sample = parseSample(input.sampleText);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    let sampleIssues: Issue[] = [];
    let truncated = false;
    if (!parseError && trimmed.length > 0 && typeof input.schema === 'object' && input.schema !== null) {
      const result = validateSample(
        input.schema as SchemaNode,
        sample,
        this.buildLookup(await this.contractMap(), {id: input.selfId ?? '$draft', schema: input.schema as SchemaNode}),
      );
      sampleIssues = result.issues;
      truncated = result.truncated;
    }

    const blockingSchema = schemaIssues.filter(issue => issue.code !== 'ref_dangling' && issue.code !== 'unconstrained');
    return {
      ok: true,
      parseError,
      schemaIssues,
      sampleIssues,
      truncated,
      valid: parseError === null && blockingSchema.length === 0 && sampleIssues.length === 0,
    };
  }

  async save(input: {id: string; name: unknown; expectedRevision: unknown; schema: unknown; confirmBreaking?: unknown}): Promise<SaveOutcome> {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      return {kind: 'bad_request', error: 'name 必须是非空字符串'};
    }
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return {kind: 'bad_request', error: 'expectedRevision 必须是非负整数（0 表示新建）'};
    }
    if (typeof input.schema !== 'object' || input.schema === null || Array.isArray(input.schema)) {
      return {kind: 'bad_request', error: 'schema 必须是 JSON Schema 对象'};
    }

    const schema = input.schema as SchemaNode;

    const existing = await this.store.get(input.id);
    if (existing && expectedRevision > existing.revisions.length) {
      return {kind: 'bad_request', error: `expectedRevision ${expectedRevision} 大于当前 revision ${existing.revisions.length}`};
    }

    // 乐观锁优先：基于旧 revision 的保存直接 409，不必再算破坏性
    const currentRevision = existing ? existing.revisions.length : 0;
    if (expectedRevision !== currentRevision) {
      return {kind: 'version_conflict', current: existing as StoredContract};
    }

    const schemaIssues = checkSchemaShape(schema, this.buildLookup(await this.contractMap()));
    const blocking = schemaIssues.filter(issue => issue.code !== 'ref_dangling' && issue.code !== 'unconstrained');
    if (blocking.length > 0) {
      return {kind: 'invalid', issues: schemaIssues};
    }

    let breaking: BreakingChange[] = [];
    if (existing && expectedRevision >= 1) {
      // 作者基于的正是当前最新 revision（上面的乐观锁保证）
      const previous = existing.revisions[expectedRevision - 1];
      const contracts = await this.contractMap();
      breaking = findBreakingChanges(
        previous.schema,
        schema,
        this.buildLookup(contracts),
        this.buildLookup(contracts),
      );
    }
    if (breaking.length > 0 && input.confirmBreaking !== true) {
      // 破坏性改动默认挡住；前端展示清单，作者显式确认后带 confirmBreaking:true 重发。
      return {kind: 'breaking_blocked', current: existing as StoredContract, breaking};
    }

    const saveInput: SaveInput = {
      id: input.id,
      name: input.name.trim(),
      expectedRevision,
      schema,
    };
    const result: SaveResult = await this.store.save(saveInput);
    // expectedRevision 已与当前一致，正常情况下不会再冲突；保留以防存储实现有额外条件
    if (result.kind === 'conflict') {
      // 乐观锁：后保存者基于旧 revision。他未保存的文本由前端保留；
      // current 里带全部 revisions，前端据此展示别人改了什么。
      return {kind: 'version_conflict', current: result.current};
    }
    return {
      kind: 'saved',
      contract: result.contract,
      revision: result.revision.revision,
      breaking,
    };
  }
}

