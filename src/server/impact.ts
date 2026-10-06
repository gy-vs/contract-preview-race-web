import type {AffectedSource, StoredContract} from '../shared/types';
import type {SchemaNode} from '../shared/types';
import {parseRef} from './refs';
import {findBreakingChanges} from './compat';
import {latestSchema} from './seed';

/**
 * 找出契约里所有跟随最新（revision === 'latest'）的直接引用目标。
 * 钉死 revision 的引用不参与影响传播（源头怎么改都与它无关）。
 * 遍历 schema 是显式栈，树形自引用下也安全。
 */
export function latestRefs(schema: SchemaNode, selfId: string, exists: Set<string>): string[] {
  const targets: string[] = [];
  const seen = new Set<SchemaNode>();
  const stack: SchemaNode[] = [schema];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.$ref !== undefined) {
      const target = parseRef(node.$ref);
      if (target && target.revision === 'latest' && target.contractId !== selfId && exists.has(target.contractId)) {
        targets.push(target.contractId);
      }
      // 引用节点不继续下钻（被引用契约的内部引用在它自己的边里体现）
      continue;
    }
    if (node.properties) {
      for (const name of Object.keys(node.properties)) stack.push(node.properties[name]);
    }
    if (node.items) stack.push(node.items);
  }
  return [...new Set(targets)];
}

function lookupFor(contracts: Map<string, StoredContract>) {
  return (target: {contractId: string; revision: number | 'latest'}) => {
    const contract = contracts.get(target.contractId);
    if (!contract) return null;
    // revision 只增不删：钉死几号就解析几号；latest 解析当前最新。
    const rev = target.revision === 'latest' ? contract.revisions.length : target.revision;
    const found = contract.revisions.find(item => item.revision === rev);
    return found ? {schema: found.schema, revision: found.revision} : null;
  };
}

/**
 * 计算全部受影响契约。
 *
 * 1. 每个契约“最新 revision 相对上一个 revision”有破坏性改动 => 它自己是源头；
 * 2. 沿“跟随最新”的引用边反向 BFS：直接或间接跟随最新引用到源头的契约全部受影响，
 *    钉死 revision 的边不透传；多跳间接引用一样一路传到最上层。
 */
export function computeAffected(allContracts: StoredContract[]): Map<string, AffectedSource[]> {
  const byId = new Map(allContracts.map(contract => [contract.id, contract]));
  const exists = new Set(byId.keys());

  // 1) 破坏性改动源头
  const breakingIds = new Set<string>();
  for (const contract of allContracts) {
    if (contract.revisions.length < 2) continue;
    const newest = contract.revisions[contract.revisions.length - 1];
    const previous = contract.revisions[contract.revisions.length - 2];
    const changes = findBreakingChanges(
      previous.schema,
      newest.schema,
      lookupFor(byId),
      lookupFor(byId),
    );
    if (changes.length > 0) breakingIds.add(contract.id);
  }

  // 2) 正向跟随最新边
  const outgoing = new Map<string, string[]>();
  for (const contract of allContracts) {
    outgoing.set(contract.id, latestRefs(latestSchema(contract), contract.id, exists));
  }
  // 反向边：dep -> [依赖 dep 的契约]
  const incoming = new Map<string, Set<string>>();
  for (const [from, tos] of outgoing) {
    for (const to of tos) {
      let set = incoming.get(to);
      if (!set) {
        set = new Set();
        incoming.set(to, set);
      }
      set.add(from);
    }
  }

  // 3) 从每个源头反向 BFS，记录传导链
  const result = new Map<string, AffectedSource[]>();
  for (const source of breakingIds) {
    const visited = new Set<string>([source]);
    // 队列项：[当前节点, 从“上层契约”到源头的链]
    const queue: Array<{id: string; chain: string[]}> = [{id: source, chain: [source]}];
    while (queue.length) {
      const {id, chain} = queue.shift()!;
      const upstreams = incoming.get(id);
      if (!upstreams) continue;
      for (const upstream of upstreams) {
        if (visited.has(upstream)) continue;
        visited.add(upstream);
        const nextChain = [upstream, ...chain];
        const list = result.get(upstream) ?? [];
        list.push({source, chain: nextChain});
        result.set(upstream, list);
        queue.push({id: upstream, chain: nextChain});
      }
    }
  }

  return result;
}
