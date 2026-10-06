import type {RefTarget, SchemaNode} from '../shared/schema';
import {parseRef} from '../shared/schema';
import {latestRevision, type ContractRecord} from './store';

/** 收集一份 schema 中出现的全部引用（迭代遍历，不去重）。 */
export function collectRefs(schema: SchemaNode): RefTarget[] {
  const targets: RefTarget[] = [];
  const stack: SchemaNode[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.$ref !== undefined) {
      const target = parseRef(node.$ref);
      if (target) targets.push(target);
      continue;
    }
    for (const child of Object.values(node.properties ?? {})) stack.push(child);
    if (node.items !== undefined) stack.push(node.items);
  }
  return targets;
}

/**
 * 计算每份契约被哪些「发生了破坏性改动的契约」波及。
 *
 * 只有「跟随最新」的引用会传递影响；钉死旧 revision 的引用不受影响。
 * 影响沿跟随最新的引用链一路传递到最上层（A→B→C 时 C 的破坏性改动会波及 B 和 A）。
 * 返回：契约 id → 波及它的来源契约 id 列表。
 */
export function computeAffected(records: ContractRecord[]): Map<string, string[]> {
  // 反向边：被引用者 → 跟随最新引用它的契约们
  const dependents = new Map<string, Set<string>>();
  for (const record of records) {
    const schema = latestRevision(record).schema;
    for (const target of collectRefs(schema)) {
      if (target.revision !== null) continue; // 钉死 revision，不传递
      if (target.id === record.id) continue; // 自引用不影响「受影响」标记
      let set = dependents.get(target.id);
      if (!set) {
        set = new Set();
        dependents.set(target.id, set);
      }
      set.add(record.id);
    }
  }

  const sources = records.filter(record => latestRevision(record).breaking).map(record => record.id);
  const affected = new Map<string, Set<string>>();
  const queue: Array<{id: string; source: string}> = sources.map(id => ({id, source: id}));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const {id, source} = queue.shift()!;
    const key = `${source}→${id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const dependent of dependents.get(id) ?? []) {
      let set = affected.get(dependent);
      if (!set) {
        set = new Set();
        affected.set(dependent, set);
      }
      set.add(source);
      queue.push({id: dependent, source});
    }
  }

  return new Map([...affected.entries()].map(([id, set]) => [id, [...set].sort()]));
}
