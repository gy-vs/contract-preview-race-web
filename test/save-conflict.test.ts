import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {InMemoryContractStore} from '../src/server/store';

/** 冲突保存：基于旧 revision 的保存必须被拒，且响应里带上对方已保存的最新内容。 */
describe('保存冲突（乐观并发）', () => {
  function setup() {
    const store = new InMemoryContractStore();
    return {store, app: createApp(store)};
  }

  async function createContract(app: ReturnType<typeof createApp>) {
    await request(app)
      .post('/api/contracts')
      .send({id: 'order-event', name: '订单事件', schema: {type: 'object', properties: {id: {type: 'string'}}}})
      .expect(201);
  }

  it('基于旧 revision 的保存返回 409 和最新内容，重新基于最新保存则成功', async () => {
    const {app} = setup();
    await createContract(app);

    // 甲先保存：revision 1 → 2
    const first = await request(app)
      .put('/api/contracts/order-event')
      .send({schema: {type: 'object', properties: {id: {type: 'string'}, note: {type: 'string'}}}, baseRevision: 1});
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(2);

    // 乙仍基于 revision 1 保存 → 409，响应里带着甲保存的内容（前端据此展示"别人改了什么"）
    const stale = await request(app)
      .put('/api/contracts/order-event')
      .send({schema: {type: 'object', properties: {id: {type: 'string'}, extra: {type: 'string'}}}, baseRevision: 1});
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('conflict');
    expect(stale.body.current.revision).toBe(2);
    expect(stale.body.current.schema.properties).toHaveProperty('note');

    // 乙的修改没有被保存，仓库里仍是甲的版本
    const current = await request(app).get('/api/contracts/order-event');
    expect(current.body.revision).toBe(2);
    expect(current.body.schema.properties).not.toHaveProperty('extra');

    // 乙改为基于 revision 2 重新保存 → 成功，revision 递增为 3
    const rebased = await request(app)
      .put('/api/contracts/order-event')
      .send({
        schema: {type: 'object', properties: {id: {type: 'string'}, note: {type: 'string'}, extra: {type: 'string'}}},
        baseRevision: 2,
      });
    expect(rebased.status).toBe(200);
    expect(rebased.body.revision).toBe(3);
  });

  it('冲突检查优先于破坏性检查', async () => {
    const {app} = setup();
    await createContract(app);
    await request(app)
      .put('/api/contracts/order-event')
      .send({schema: {type: 'object', properties: {id: {type: 'string'}, note: {type: 'string'}}}, baseRevision: 1})
      .expect(200);

    // 既基于旧 revision、又包含破坏性改动（删字段）→ 应报冲突而不是破坏性
    const response = await request(app)
      .put('/api/contracts/order-event')
      .send({schema: {type: 'object', properties: {}}, baseRevision: 1});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('conflict');
  });

  it('不合法 schema 与未知契约', async () => {
    const {app} = setup();
    await createContract(app);
    const invalid = await request(app)
      .put('/api/contracts/order-event')
      .send({schema: {type: 'objct'}, baseRevision: 1});
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toBe('invalid_schema');

    await request(app)
      .put('/api/contracts/nope')
      .send({schema: {}, baseRevision: 1})
      .expect(404);
  });
});
