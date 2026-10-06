import express, {type Express, type Request, type Response} from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {ContractService} from './service';
import {InMemoryContractStore} from './store';
import {SEED_CONTRACTS} from './seed';
import {isValidContractId} from './refs';
import {renderJsonPath} from '../shared/path';

export function createApp(service: ContractService = new ContractService()): Express {
  const app = express();
  app.use(express.json({limit: '2mb'}));

  const asyncHandler = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => {
      handler(req, res).catch(error => {
        if (!res.headersSent) {
          res.status(500).json({error: 'internal', message: String(error?.message ?? error)});
        }
      });
    };

  // Express 5 的 params 类型是 string | string[]，这里全部路由参数都是单值
  const param = (req: Request, name: string): string => {
    const value = req.params[name];
    return Array.isArray(value) ? value[0] : value;
  };

  // 契约列表（含破坏性改动影响标记）
  app.get('/api/contracts', asyncHandler(async (_req, res) => {
    res.json(await service.list());
  }));

  // 单份契约：全部 revisions
  app.get('/api/contracts/:id', asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const contract = await service.get(id);
    if (!contract) {
      res.status(404).json({error: 'not_found', message: `契约 "${id}" 不存在`});
      return;
    }
    res.json(serializeContract(contract));
  }));

  // 指定 revision（冲突合并时可回看作者基于的旧版）
  app.get('/api/contracts/:id/revisions/:rev', asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const contract = await service.get(id);
    if (!contract) {
      res.status(404).json({error: 'not_found'});
      return;
    }
    const rev = Number(req.params.rev);
    const revision = contract.revisions.find(item => item.revision === rev);
    if (!revision) {
      res.status(404).json({error: 'not_found', message: `revision ${rev} 不存在`});
      return;
    }
    res.json({id: contract.id, name: contract.name, revision});
  }));

  // 右侧预览：用编辑中的契约 + 它引用到的契约校验一段样例
  const previewHandler = asyncHandler(async (req, res) => {
    const result = await service.preview({
      schema: req.body?.schema,
      sampleText: typeof req.body?.sample === 'string' ? req.body.sample : '',
      selfId: param(req, 'id'),
    });
    if (!result.ok) {
      res.status(result.status).json({error: result.error});
      return;
    }
    res.json({
      parseError: result.parseError,
      valid: result.valid,
      truncated: result.truncated,
      issues: [
        ...result.schemaIssues.map(issue => ({
          scope: issue.scope,
          path: renderJsonPath(issue.path),
          code: issue.code,
          message: issue.message,
        })),
        ...result.sampleIssues.map(issue => ({
          scope: issue.scope,
          path: renderJsonPath(issue.path),
          code: issue.code,
          message: issue.message,
        })),
      ],
    });
  });
  app.post('/api/preview', previewHandler);
  app.post('/api/preview/:id', previewHandler);

  // 保存：乐观锁 + 破坏性改动确认
  app.put('/api/contracts/:id', asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    if (!isValidContractId(id)) {
      res.status(400).json({error: 'bad_request', message: '契约 id 只能包含字母、数字、下划线、连字符，且长度不超过 64'});
      return;
    }
    const outcome = await service.save({
      id,
      name: req.body?.name ?? id,
      expectedRevision: req.body?.expectedRevision,
      schema: req.body?.schema,
      confirmBreaking: req.body?.confirmBreaking === true,
    });
    switch (outcome.kind) {
      case 'saved':
        res.status(200).json({
          id: outcome.contract.id,
          name: outcome.contract.name,
          revision: outcome.revision,
          breaking: outcome.breaking.map(change => ({
            path: renderJsonPath(change.path),
            code: change.code,
            message: change.message,
          })),
        });
        break;
      case 'version_conflict':
        // 409：别人已经发布了更新的 revision，作者的文本由前端保留
        res.status(409).json({
          error: 'version_conflict',
          message: '契约已被他人更新，请基于最新内容合并后再保存',
          current: serializeContract(outcome.current),
        });
        break;
      case 'breaking_blocked':
        // 422：破坏性改动需要显式确认
        res.status(422).json({
          error: 'breaking_change',
          message: '本次改动包含破坏性变更，确认后才能发布',
          currentRevision: outcome.current.revisions.length,
          breaking: outcome.breaking.map(change => ({
            path: renderJsonPath(change.path),
            code: change.code,
            message: change.message,
          })),
        });
        break;
      case 'invalid':
        res.status(400).json({
          error: 'invalid_schema',
          issues: outcome.issues.map(issue => ({
            scope: issue.scope,
            path: renderJsonPath(issue.path),
            code: issue.code,
            message: issue.message,
          })),
        });
        break;
      case 'bad_request':
        res.status(400).json({error: 'bad_request', message: outcome.error});
        break;
    }
  }));

  // 生产环境托管构建产物
  const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

function serializeContract(contract: Awaited<ReturnType<ContractService['get']>>) {
  if (!contract) return null;
  return {
    id: contract.id,
    name: contract.name,
    revision: contract.revisions.length,
    revisions: contract.revisions,
    latest: contract.revisions[contract.revisions.length - 1],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = new ContractService(new InMemoryContractStore(SEED_CONTRACTS));
  createApp(service).listen(4174, '127.0.0.1', () => {
    console.log('contract workbench api http://127.0.0.1:4174');
  });
}
