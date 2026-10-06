import express from 'express';
import {fileURLToPath} from 'node:url';
import {CONTRACT_ID_PATTERN, type ContractSummary} from '../shared/schema';
import {findBreakingChanges} from './compat';
import {computeAffected} from './impact';
import {createResolver} from './resolve';
import {asSchemaNode, checkSchemaDocument} from './schema-check';
import {seedContracts} from './seed';
import {InMemoryContractStore, latestRevision, type ContractStore} from './store';
import {validateData} from './validate';

/**
 * 契约工作台 HTTP 服务。存储通过参数注入，默认进程内实现 + 种子数据；
 * 测试或替换持久化时传入自己的 ContractStore 即可。
 */
export function createApp(store: ContractStore = new InMemoryContractStore(seedContracts())) {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  async function buildSummaries(): Promise<ContractSummary[]> {
    const records = await store.snapshot();
    const affected = computeAffected(records);
    return records.map(record => {
      const latest = latestRevision(record);
      return {
        id: record.id,
        name: record.name,
        revision: latest.revision,
        breaking: latest.breaking,
        affectedBy: affected.get(record.id) ?? [],
      };
    });
  }

  app.get('/api/bootstrap', async (_req, res) => {
    const contracts = await store.listContracts();
    res.json({kind: 'contract', count: contracts.length});
  });

  app.get('/api/contracts', async (_req, res) => {
    res.json(await buildSummaries());
  });

  app.post('/api/contracts', async (req, res) => {
    const {id, name, schema} = req.body ?? {};
    if (typeof id !== 'string' || !CONTRACT_ID_PATTERN.test(id)) {
      return res.status(422).json({error: 'invalid_id', message: 'id 需为小写字母/数字开头，可含 - 和 _'});
    }
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(422).json({error: 'invalid_name', message: 'name 不能为空'});
    }
    const records = await store.snapshot();
    const resolve = createResolver(records);
    // 新建契约允许「跟随最新」地自引用（树形契约），其余引用必须已存在
    const details = checkSchemaDocument(
      schema,
      target => (target.id === id && target.revision === null) || resolve(target) !== undefined,
    );
    if (details.length > 0) {
      return res.status(422).json({error: 'invalid_schema', details});
    }
    const result = await store.createContract(id, name.trim(), asSchemaNode(schema));
    if (result === 'exists') {
      return res.status(409).json({error: 'exists', message: `契约 "${id}" 已存在`});
    }
    res.status(201).json({id, revision: 1});
  });

  app.get('/api/contracts/:id', async (req, res) => {
    const record = await store.getContract(req.params.id);
    if (!record) return res.status(404).json({error: 'not_found'});
    const latest = latestRevision(record);
    res.set('ETag', String(latest.revision));
    res.json({id: record.id, name: record.name, revision: latest.revision, schema: latest.schema});
  });

  app.get('/api/contracts/:id/revisions/:rev', async (req, res) => {
    const record = await store.getContract(req.params.id);
    if (!record) return res.status(404).json({error: 'not_found'});
    const revision = record.revisions.find(rev => rev.revision === Number(req.params.rev));
    if (!revision) return res.status(404).json({error: 'not_found'});
    res.json(revision);
  });

  /**
   * 保存契约。body: {schema, baseRevision, force?}
   *  - baseRevision 落后于最新 revision → 409 + 当前最新内容（乐观锁，防覆盖他人保存）
   *  - schema 不合法 → 422 invalid_schema
   *  - 相对上一 revision 有破坏性改动且未确认 → 422 breaking + 报告；force=true 才发布
   */
  app.put('/api/contracts/:id', async (req, res) => {
    const record = await store.getContract(req.params.id);
    if (!record) return res.status(404).json({error: 'not_found'});

    const {schema, baseRevision, force} = req.body ?? {};
    const latest = latestRevision(record);
    if (baseRevision !== latest.revision) {
      return res.status(409).json({
        error: 'conflict',
        message: `契约已被他人保存为 revision ${latest.revision}，你的修改基于 revision ${baseRevision}`,
        current: {revision: latest.revision, schema: latest.schema},
      });
    }

    const records = await store.snapshot();
    const resolve = createResolver(records);
    const details = checkSchemaDocument(schema, target => resolve(target) !== undefined);
    if (details.length > 0) {
      return res.status(422).json({error: 'invalid_schema', details});
    }

    const next = asSchemaNode(schema);
    const report = findBreakingChanges(latest.schema, next, resolve);
    if (report.length > 0 && force !== true) {
      return res.status(422).json({error: 'breaking', message: '本次修改包含破坏性改动', report});
    }

    const result = await store.appendRevision(record.id, latest.revision, {
      schema: next,
      breaking: report.length > 0,
      changes: report,
    });
    if (result !== 'ok') {
      // 检查与追加之间被并发保存抢占
      const current = latestRevision(record);
      return res.status(409).json({
        error: 'conflict',
        message: `契约已被他人保存为 revision ${current.revision}`,
        current: {revision: current.revision, schema: current.schema},
      });
    }
    const saved = latestRevision(record);
    res.json({id: record.id, revision: saved.revision, breaking: saved.breaking, changes: saved.changes});
  });

  /**
   * 预览校验。body: {schema, sample} 或 {schema, sampleText}
   * schema 是编辑器里尚未保存的内容；其中「跟随最新」的自引用解析到这份编辑中的 schema，
   * 其余引用解析自仓库。sampleText 以原始文本传输（深嵌套样例经不起 JSON.stringify 再序列化），
   * 服务端解析并校验，全程迭代，几千层嵌套的样例不会栈溢出。
   */
  app.post('/api/contracts/:id/preview', async (req, res) => {
    const record = await store.getContract(req.params.id);
    if (!record) return res.status(404).json({error: 'not_found'});

    const {schema, sample, sampleText} = req.body ?? {};
    let data = sample;
    if (typeof sampleText === 'string') {
      try {
        data = JSON.parse(sampleText);
      } catch {
        return res.status(422).json({error: 'invalid_sample', details: [{path: '$', message: '样例不是合法 JSON'}]});
      }
    }
    const records = await store.snapshot();
    const resolve = createResolver(records);
    const details = checkSchemaDocument(schema, target => resolve(target) !== undefined);
    if (details.length > 0) {
      return res.status(422).json({error: 'invalid_schema', details});
    }
    const edited = asSchemaNode(schema);
    const previewResolve = createResolver(records, {id: record.id, schema: edited});
    const errors = validateData(edited, data, previewResolve);
    res.json({contractId: record.id, valid: errors.length === 0, errors});
  });

  // 统一的 JSON 错误响应（body 解析失败、超限等）
  app.use(((err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    const type = (err as {type?: string})?.type;
    if (type === 'entity.parse.failed') {
      return res.status(400).json({error: 'invalid_json', message: '请求体不是合法 JSON'});
    }
    if (type === 'entity.too.large') {
      return res.status(413).json({error: 'too_large', message: '请求体超过大小限制'});
    }
    console.error(err);
    res.status(500).json({error: 'internal'});
  }) as express.ErrorRequestHandler);

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
