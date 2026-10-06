import {beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {InMemoryContractStore} from '../src/server/store';

/**
 * 破坏性改动沿引用传递：
 *  - 破坏性保存默认被挡，作者确认（force）后才发布
 *  - 跟随最新的引用者被标记为「受影响」，且影响沿引用链一路传递到最上层
 *  - 钉死旧 revision 的引用者不受影响
 */
describe('破坏性改动与影响传递', () => {
  let app: ReturnType<typeof createApp>;

  // 依赖链：order-app →latest order-event →latest address；legacy-report 钉死 address@1
  beforeEach(async () => {
    app = createApp(new InMemoryContractStore());
    await request(app).post('/api/contracts').send({
      id: 'address',
      name: '地址',
      schema: {type: 'object', properties: {detail: {type: 'string'}, zip: {type: 'string'}}, required: ['detail']},
    }).expect(201);
    await request(app).post('/api/contracts').send({
      id: 'order-event',
      name: '订单事件',
      schema: {type: 'object', properties: {orderId: {type: 'string'}, addr: {$ref: 'address'}}, required: ['orderId']},
    }).expect(201);
    await request(app).post('/api/contracts').send({
      id: 'order-app',
      name: '订单应用事件',
      schema: {type: 'object', properties: {event: {$ref: 'order-event'}}},
    }).expect(201);
    await request(app).post('/api/contracts').send({
      id: 'legacy-report',
      name: '遗留报表',
      schema: {type: 'object', properties: {addr: {$ref: 'address@1'}}},
    }).expect(201);
  });

  async function summaries(): Promise<Array<{id: string; breaking: boolean; affectedBy: string[]}>> {
    const response = await request(app).get('/api/contracts').expect(200);
    return response.body;
  }

  it('破坏性保存默认被 422 挡住，报告里列出每处改动；force 后才发布', async () => {
    // 删 zip 字段 + detail 类型收窄 + city 变为必填，一次凑齐三类破坏性改动
    const schema = {
      type: 'object',
      properties: {detail: {type: 'integer'}, city: {type: 'string'}},
      required: ['detail', 'city'],
    };
    const blocked = await request(app).put('/api/contracts/address').send({schema, baseRevision: 1});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('breaking');
    const messages = blocked.body.report.map((issue: {message: string}) => issue.message).join('\n');
    expect(messages).toContain('字段被删除');
    expect(messages).toContain('类型由 string 变为 integer');
    expect(messages).toContain('字段由可选变为必填');

    // 被挡住时不产生新 revision
    const detail = await request(app).get('/api/contracts/address');
    expect(detail.body.revision).toBe(1);

    const forced = await request(app).put('/api/contracts/address').send({schema, baseRevision: 1, force: true});
    expect(forced.status).toBe(200);
    expect(forced.body.revision).toBe(2);
    expect(forced.body.breaking).toBe(true);
  });

  it('破坏性发布后，影响沿跟随最新的引用链传递到最上层', async () => {
    const schema = {type: 'object', properties: {detail: {type: 'string'}}, required: ['detail']};
    // 删掉 zip 字段 → 破坏性
    await request(app).put('/api/contracts/address').send({schema, baseRevision: 1, force: true}).expect(200);

    const list = await summaries();
    const byId = new Map(list.map(item => [item.id, item]));
    expect(byId.get('address')!.breaking).toBe(true);
    // 直接引用者受影响
    expect(byId.get('order-event')!.affectedBy).toEqual(['address']);
    // 间接引用者（隔一层）也受影响
    expect(byId.get('order-app')!.affectedBy).toEqual(['address']);
    // 钉死 address@1 的不受影响
    expect(byId.get('legacy-report')!.affectedBy).toEqual([]);
    expect(byId.get('legacy-report')!.breaking).toBe(false);
  });

  it('非破坏性改动不标记任何受影响', async () => {
    const schema = {
      type: 'object',
      properties: {detail: {type: 'string'}, zip: {type: 'string'}, city: {type: 'string'}}, // 仅新增可选字段
      required: ['detail'],
    };
    const saved = await request(app).put('/api/contracts/address').send({schema, baseRevision: 1});
    expect(saved.status).toBe(200);
    expect(saved.body.breaking).toBe(false);

    const list = await summaries();
    for (const item of list) {
      expect(item.affectedBy).toEqual([]);
      expect(item.breaking).toBe(false);
    }
  });

  it('破坏性发布后再保存一个兼容 revision，受影响标记消失', async () => {
    const breaking = {type: 'object', properties: {detail: {type: 'string'}}, required: ['detail']};
    await request(app).put('/api/contracts/address').send({schema: breaking, baseRevision: 1, force: true}).expect(200);
    let list = await summaries();
    expect(new Map(list.map(i => [i.id, i])).get('order-event')!.affectedBy).toEqual(['address']);

    // 把 zip 加回来（新增可选字段，非破坏性）→ 最新 revision 不再破坏性，影响解除
    const restored = {
      type: 'object',
      properties: {detail: {type: 'string'}, zip: {type: 'string'}},
      required: ['detail'],
    };
    await request(app).put('/api/contracts/address').send({schema: restored, baseRevision: 2}).expect(200);
    list = await summaries();
    const byId = new Map(list.map(i => [i.id, i]));
    expect(byId.get('address')!.breaking).toBe(false);
    expect(byId.get('order-event')!.affectedBy).toEqual([]);
    expect(byId.get('order-app')!.affectedBy).toEqual([]);
  });
});
