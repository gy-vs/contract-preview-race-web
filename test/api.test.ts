import {describe, expect, it, beforeEach} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {ContractService} from '../src/server/service';
import {InMemoryContractStore} from '../src/server/store';
import {SEED_CONTRACTS} from '../src/server/seed';
import type {Express} from 'express';
import type {SchemaNode} from '../src/shared/types';
import {stringifyIterative} from '../src/server/json-parse';

function freshApp(): Express {
  return createApp(new ContractService(new InMemoryContractStore(SEED_CONTRACTS)));
}

function addressSchema(overrides: Partial<SchemaNode> = {}): SchemaNode {
  return {
    type: 'object',
    properties: {
      country: {type: 'string', enum: ['CN', 'US', 'JP']},
      city: {type: 'string'},
      line1: {type: 'string'},
      postalCode: {type: 'string'},
      ...((overrides.properties ?? {}) as SchemaNode['properties']),
    },
    required: overrides.required ?? ['country', 'city', 'line1'],
  };
}

let app: Express;
beforeEach(() => {
  app = freshApp();
});

describe('契约工作台 API', () => {
  it('返回种子契约列表', async () => {
    const res = await request(app).get('/api/contracts');
    expect(res.status).toBe(200);
    const ids = res.body.map((item: {id: string}) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['addresses', 'orders', 'shipments']));
    for (const item of res.body) expect(item.affected).toEqual([]);
  });

  it('能创建新契约', async () => {
    const res = await request(app)
      .put('/api/contracts/payments')
      .send({name: '支付事件', expectedRevision: 0, schema: {type: 'object', properties: {amount: {type: 'number'}}}});
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(1);
  });

  it('拒绝结构非法的 schema', async () => {
    const res = await request(app)
      .put('/api/contracts/payments')
      .send({name: '支付', expectedRevision: 0, schema: {type: 'weird'}});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_schema');
  });
});

describe('并发保存的乐观锁', () => {
  it('基于旧 revision 的后保存者被 409 拒绝，且当前内容随响应返回', async () => {
    // A 先保存成功：revision 1 -> 2
    const a = await request(app)
      .put('/api/contracts/addresses')
      .send({name: '地址', expectedRevision: 1, schema: addressSchema({properties: {district: {type: 'string'}}})});
    expect(a.status).toBe(200);
    expect(a.body.revision).toBe(2);

    // B 仍基于 revision 1 修改：被拒
    const b = await request(app)
      .put('/api/contracts/addresses')
      .send({name: '地址', expectedRevision: 1, schema: addressSchema({properties: {zip: {type: 'string'}}})});
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('version_conflict');
    // 响应里带当前 schema，前端据此展示别人改了什么
    expect(b.body.current.latest.schema.properties).toHaveProperty('district');
    expect(b.body.current.latest.schema.properties).not.toHaveProperty('zip');
    // revisions 里能同时看到 B 的基线（rev 1）和 A 的新发布（rev 2）
    expect(b.body.current.revisions.map((r: {revision: number}) => r.revision)).toEqual([1, 2]);

    // B 合并后基于 revision 2 重试，可以成功
    const merged = addressSchema({properties: {district: {type: 'string'}, zip: {type: 'string'}}});
    const retry = await request(app)
      .put('/api/contracts/addresses')
      .send({name: '地址', expectedRevision: 2, schema: merged});
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(3);
  });

  it('过期 revision 的保存即使改动本身是破坏性的，也先返回 409 而不是 422', async () => {
    // A 发布 rev2（非破坏）
    await request(app)
      .put('/api/contracts/addresses')
      .send({name: '地址', expectedRevision: 1, schema: addressSchema({properties: {district: {type: 'string'}}})});

    // B 基于 rev1 且删除 city（相对 rev1 是破坏性）：应被乐观锁挡在 409
    const b = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN', 'US', 'JP']},
            line1: {type: 'string'},
            postalCode: {type: 'string'},
          },
          required: ['country', 'line1'],
        },
      });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('version_conflict');
  });
});

describe('递归引用的样例校验', () => {
  it('树形自引用契约校验深度嵌套样例，不栈溢出且能定位错误路径', async () => {
    // 构造 4000 层 children 嵌套，最深处 text 给成数字
    const depth = 4000;
    const sample: Record<string, any> = {id: 'root'} as any;
    let cursor: any = sample;
    for (let i = 0; i < depth; i++) {
      cursor.children = [{id: `n${i}`}];
      cursor = cursor.children[0] as Record<string, unknown>;
    }
    cursor.text = 12345; // 应为 string

    const res = await request(app)
      .post('/api/preview/comment-tree')
      .send({
        schema: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            text: {type: 'string'},
            children: {type: 'array', items: {$ref: 'comment-tree'}},
          },
          required: ['id'],
        },
        sample: stringifyIterative(sample),
      });
    expect(res.status).toBe(200);
    const typeIssue = res.body.issues.find((issue: {code: string}) => issue.code === 'type');
    expect(typeIssue).toBeTruthy();
    // 路径必须一路定位到叶子：$.children[0].children[0]...text
    expect(typeIssue.path.endsWith('.text')).toBe(true);
    expect((typeIssue.path.match(/children/g) ?? []).length).toBe(depth);
    expect(res.body.valid).toBe(false);
  });

  it('深层缺必填字段也能定位', async () => {
    const depth = 3000;
    const sample: Record<string, any> = {};
    let cursor: any = sample;
    for (let i = 0; i < depth; i++) {
      cursor.children = [{}];
      cursor = cursor.children[0] as Record<string, unknown>;
    }
    cursor.id = 'leaf';

    const res = await request(app)
      .post('/api/preview/comment-tree')
      .send({
        schema: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            children: {type: 'array', items: {$ref: 'comment-tree'}},
          },
          required: ['id'],
        },
        sample: stringifyIterative(sample),
      });
    // 根节点缺 id
    const rootMissing = res.body.issues.find(
      (issue: {code: string; path: string}) => issue.code === 'required' && issue.path === '$.id',
    );
    expect(rootMissing).toBeTruthy();
    // 中间每一层除最后一层外都缺 id，报错数量应与深度相关（这里只验证一条深层路径存在）
    const deepMissing = res.body.issues.find(
      (issue: {code: string; path: string}) => issue.code === 'required' && issue.path.includes('[0].id'),
    );
    expect(deepMissing).toBeTruthy();
  });

  it('引用地址契约校验订单样例：错误定位到被引用契约内的具体路径', async () => {
    const res = await request(app)
      .post('/api/preview/orders')
      .send({
        schema: {
          type: 'object',
          properties: {
            orderId: {type: 'string'},
            shippingAddress: {$ref: 'addresses'},
          },
          required: ['orderId', 'shippingAddress'],
        },
        sample: JSON.stringify({
          orderId: 'o-1',
          shippingAddress: {country: 'DE', city: 'Berlin', line1: 'x'},
        }),
      });
    expect(res.status).toBe(200);
    const issue = res.body.issues.find((item: {code: string}) => item.code === 'enum');
    expect(issue.path).toBe('$.shippingAddress.country');
    expect(issue.message).toContain('CN');
  });

  it('钉死 revision 的引用按钉死的版本解析', async () => {
    // 把 addresses rev2 改成四字母国家码枚举（破坏性），再用 @1 钉旧版
    await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        confirmBreaking: true,
        schema: {type: 'object', properties: {country: {type: 'string', enum: ['CHN', 'USA']}}, required: ['country']},
      });

    const pinned = await request(app)
      .post('/api/preview/orders')
      .send({
        schema: {type: 'object', properties: {addr: {$ref: 'addresses@1'}}},
        sample: JSON.stringify({addr: {country: 'CN', city: 'SH', line1: 'x'}}),
      });
    expect(pinned.status).toBe(200);
    expect(pinned.body.valid).toBe(true);

    const latest = await request(app)
      .post('/api/preview/orders')
      .send({
        schema: {type: 'object', properties: {addr: {$ref: 'addresses'}}},
        sample: JSON.stringify({addr: {country: 'CN'}}),
      });
    expect(latest.body.valid).toBe(false);
    expect(latest.body.issues[0].path).toBe('$.addr.country');
  });
});

describe('破坏性改动', () => {
  it('删字段 / 加必填 / 收窄类型 / 删枚举默认被挡住，确认后可发布', async () => {
    const removed = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN', 'US', 'JP']},
            city: {type: 'string'},
            postalCode: {type: 'string'},
          },
          // 删掉 line1，同时把原本可选的 postalCode 改成必填
          required: ['country', 'city', 'postalCode'],
        },
      });
    expect(removed.status).toBe(422);
    const codes = removed.body.breaking.map((change: {code: string}) => change.code).sort();
    expect(codes).toContain('property_removed');
    expect(codes).toContain('required_added');

    const narrowed = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN']},
            city: {type: 'integer'},
            line1: {type: 'string'},
          },
          required: ['country', 'city', 'line1'],
        },
      });
    expect(narrowed.status).toBe(422);
    const narrowCodes = narrowed.body.breaking.map((change: {code: string}) => change.code);
    expect(narrowCodes).toContain('enum_value_removed');
    expect(narrowCodes).toContain('type_changed');

    // 显式确认后发布成功
    const confirmed = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        confirmBreaking: true,
        schema: narrowed.body ? {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN']},
            city: {type: 'integer'},
            line1: {type: 'string'},
          },
          required: ['country', 'city', 'line1'],
        } : {},
      });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.revision).toBe(2);
  });

  it('非破坏性改动（加字段、放宽类型、加枚举值）直接通过', async () => {
    const res = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址 v2',
        expectedRevision: 1,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN', 'US', 'JP', 'DE']},
            city: {type: 'string'},
            line1: {type: 'string'},
            postalCode: {type: 'string'},
            geo: {type: 'number'},
          },
          required: ['country', 'city', 'line1'],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.breaking).toEqual([]);
  });
});

describe('破坏性改动沿引用链传递', () => {
  it('被引用契约破坏性发布后，跟随最新的直接与间接引用方都标记受影响，并给出传导链', async () => {
    // addresses rev2：删掉 city / line1（破坏性），已确认
    const save = await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        confirmBreaking: true,
        schema: {
          type: 'object',
          properties: {country: {type: 'string', enum: ['CN', 'US', 'JP']}},
          required: ['country'],
        },
      });
    expect(save.status).toBe(200);

    const list = await request(app).get('/api/contracts');
    const byId = new Map<string, any>(list.body.map((item: {id: string}) => [item.id, item] as const));

    const orders = byId.get('orders');
    expect(orders.affected).toHaveLength(1);
    expect(orders.affected[0].source).toBe('addresses');
    expect(orders.affected[0].chain).toEqual(['orders', 'addresses']);

    // shipments 经 orders 间接引用 addresses，影响要一路传到最上层
    const shipments = byId.get('shipments');
    expect(shipments.affected).toHaveLength(1);
    expect(shipments.affected[0].source).toBe('addresses');
    expect(shipments.affected[0].chain).toEqual(['shipments', 'orders', 'addresses']);
  });

  it('钉死旧 revision 的引用不受影响', async () => {
    // 新建一个钉死 addresses@1 的契约
    await request(app)
      .put('/api/contracts/locked-consumer')
      .send({
        name: '钉死消费方',
        expectedRevision: 0,
        schema: {type: 'object', properties: {addr: {$ref: 'addresses@1'}}},
      });
    // addresses 破坏性发布
    await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        confirmBreaking: true,
        schema: {type: 'object', properties: {country: {type: 'string'}}, required: ['country']},
      });

    const list = await request(app).get('/api/contracts');
    const byId = new Map<string, any>(list.body.map((item: {id: string}) => [item.id, item] as const));
    expect(byId.get('locked-consumer').affected).toEqual([]);
    expect(byId.get('orders').affected.length).toBeGreaterThan(0);
  });

  it('上游修好后（再发一个兼容 revision）受影响标记消失', async () => {
    await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 1,
        confirmBreaking: true,
        schema: {type: 'object', properties: {country: {type: 'string'}}, required: ['country']},
      });
    let list = await request(app).get('/api/contracts');
    expect((list.body as any[]).find((item: {id: string}) => item.id === 'orders')!.affected.length).toBeGreaterThan(0);

    // rev3 恢复字段（可选），相对 rev2 是纯加字段（非破坏）；源头条件不再成立
    await request(app)
      .put('/api/contracts/addresses')
      .send({
        name: '地址',
        expectedRevision: 2,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN', 'US', 'JP']},
            city: {type: 'string'},
            line1: {type: 'string'},
            postalCode: {type: 'string'},
          },
          required: ['country'],
        },
      });
    list = await request(app).get('/api/contracts');
    expect((list.body as any[]).find((item: {id: string}) => item.id === 'orders')!.affected).toEqual([]);
    expect((list.body as any[]).find((item: {id: string}) => item.id === 'shipments')!.affected).toEqual([]);
  });
});
