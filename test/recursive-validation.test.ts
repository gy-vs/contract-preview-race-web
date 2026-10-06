import {beforeAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {InMemoryContractStore} from '../src/server/store';

const TREE_SCHEMA = {
  type: 'object',
  properties: {
    name: {type: 'string'},
    children: {type: 'array', items: {$ref: 'category-tree'}},
  },
  required: ['name'],
};

/**
 * 几千层嵌套的样例不能 JSON.stringify（V8 会 RangeError），
 * 所以像前端一样拼原始 JSON 文本，走 sampleText 通道发送。
 */
function buildTreeText(depth: number, corrupt: boolean): string {
  const leaf = corrupt ? '{"name":42,"children":[]}' : '{"name":"leaf","children":[]}';
  return '{"name":"level","children":['.repeat(depth - 1) + leaf + ']}'.repeat(depth - 1);
}

function previewTree(app: ReturnType<typeof createApp>, sampleText: string) {
  const body = `{"schema":${JSON.stringify(TREE_SCHEMA)},"sampleText":${JSON.stringify(sampleText)}}`;
  return request(app).post('/api/contracts/category-tree/preview').set('content-type', 'application/json').send(body);
}

/** 递归引用校验：自引用契约 + 几千层嵌套样例，后端不能栈溢出，错误要定位到具体路径。 */
describe('递归引用校验', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    app = createApp(new InMemoryContractStore());
    await request(app).post('/api/contracts').send({id: 'category-tree', name: '分类树', schema: TREE_SCHEMA}).expect(201);
  });

  it('合法的几千层嵌套样例校验通过，不栈溢出', async () => {
    const response = await previewTree(app, buildTreeText(5000, false));
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.errors).toEqual([]);
  });

  it('几千层深处的错误能定位到具体路径', async () => {
    const depth = 3000;
    const response = await previewTree(app, buildTreeText(depth, true));
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    const expectedPath = '$' + '.children[0]'.repeat(depth - 1) + '.name';
    expect(response.body.errors).toContainEqual({path: expectedPath, message: '期望类型 string，实际为 integer'});
  });

  it('缺少必填字段的错误定位到缺失字段路径', async () => {
    const response = await previewTree(app, '{"name":"root","children":[{"children":[]}]}');
    expect(response.status).toBe(200);
    expect(response.body.errors).toContainEqual({path: '$.children[0].name', message: '缺少必填字段'});
  });

  it('非法样例 JSON 返回 422 invalid_sample', async () => {
    const response = await previewTree(app, '{"name":');
    expect(response.status).toBe(422);
    expect(response.body.error).toBe('invalid_sample');
  });

  it('纯引用环（A↔B 互相引用）校验会终止而不是死循环', async () => {
    // 新建契约允许跟随最新的自引用；再互相指过去形成环
    await request(app).post('/api/contracts').send({id: 'ring-a', name: 'A', schema: {$ref: 'ring-a'}}).expect(201);
    await request(app).post('/api/contracts').send({id: 'ring-b', name: 'B', schema: {$ref: 'ring-a'}}).expect(201);
    await request(app).put('/api/contracts/ring-a').send({schema: {$ref: 'ring-b'}, baseRevision: 1}).expect(200);

    const response = await request(app)
      .post('/api/contracts/ring-a/preview')
      .send({schema: {$ref: 'ring-b'}, sample: {anything: true}});
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
  });

  it('预览时自引用解析到编辑中的 schema，而不是仓库里的旧版本', async () => {
    // 编辑中的版本把 name 改成 integer；仓库里仍是 string。样例按编辑中的版本应通过。
    const edited = {
      type: 'object',
      properties: {name: {type: 'integer'}, children: {type: 'array', items: {$ref: 'category-tree'}}},
      required: ['name'],
    };
    const response = await request(app)
      .post('/api/contracts/category-tree/preview')
      .send({schema: edited, sample: {name: 1, children: [{name: 2, children: []}]}});
    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
  });

  it('跟随最新的引用解析到最新 revision，钉死的引用解析到历史版本', async () => {
    await request(app)
      .post('/api/contracts')
      .send({id: 'address', name: '地址', schema: {type: 'object', properties: {zip: {type: 'string'}}}})
      .expect(201);
    // revision 2：zip 由 string 收窄为 integer（破坏性，强制发布）
    await request(app)
      .put('/api/contracts/address')
      .send({schema: {type: 'object', properties: {zip: {type: 'integer'}}}, baseRevision: 1, force: true})
      .expect(200);
    await request(app).post('/api/contracts').send({id: 'wrapper', name: '包装', schema: {type: 'object'}}).expect(201);

    const pinned = {type: 'object', properties: {addr: {$ref: 'address@1'}}};
    const ok = await request(app)
      .post('/api/contracts/wrapper/preview')
      .send({schema: pinned, sample: {addr: {zip: '310012'}}});
    expect(ok.body.valid).toBe(true);

    const followLatest = {type: 'object', properties: {addr: {$ref: 'address'}}};
    const broken = await request(app)
      .post('/api/contracts/wrapper/preview')
      .send({schema: followLatest, sample: {addr: {zip: '310012'}}});
    expect(broken.body.valid).toBe(false);
    expect(broken.body.errors[0].path).toBe('$.addr.zip');
  });
});
