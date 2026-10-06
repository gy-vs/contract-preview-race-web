import type {RefTarget, SchemaNode} from '../shared/schema';
import {latestRevision, type ContractRecord} from './store';

/** 同步解析一个引用目标到具体 schema 节点；解析失败返回 undefined。 */
export type RefResolver = (target: RefTarget) => SchemaNode | undefined;

/**
 * 基于契约快照构造引用解析器。
 * override 用于预览场景：正在编辑的契约尚未保存，
 * 其中「跟随最新」的自引用应解析到编辑中的 schema 而不是仓库里的旧版本。
 */
export function createResolver(
  records: ContractRecord[],
  override?: {id: string; schema: SchemaNode},
): RefResolver {
  const byId = new Map(records.map(record => [record.id, record]));
  return target => {
    if (override && target.id === override.id && target.revision === null) {
      return override.schema;
    }
    const record = byId.get(target.id);
    if (!record) return undefined;
    if (target.revision === null) return latestRevision(record).schema;
    return record.revisions.find(rev => rev.revision === target.revision)?.schema;
  };
}
