import type {ContractRecord} from './store';

const now = () => new Date().toISOString();

function seeded(id: string, name: string, schema: ContractRecord['revisions'][number]['schema']): ContractRecord {
  return {id, name, revisions: [{revision: 1, schema, savedAt: now(), breaking: false, changes: []}]};
}

/** 开发环境默认种子数据：覆盖普通引用、枚举、以及自引用（树形）契约。 */
export function seedContracts(): ContractRecord[] {
  return [
    seeded('address', '收货地址', {
      type: 'object',
      properties: {
        recipient: {type: 'string'},
        phone: {type: 'string'},
        province: {type: 'string'},
        city: {type: 'string'},
        detail: {type: 'string'},
        zip: {type: 'string'},
      },
      required: ['recipient', 'phone', 'detail'],
    }),
    seeded('order-event', '订单事件', {
      type: 'object',
      properties: {
        orderId: {type: 'string'},
        buyerId: {type: 'string'},
        status: {type: 'string', enum: ['created', 'paid', 'shipped', 'closed']},
        shippingAddress: {$ref: 'address'},
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: {type: 'string'},
              quantity: {type: 'integer'},
              price: {type: 'number'},
            },
            required: ['sku', 'quantity'],
          },
        },
      },
      required: ['orderId', 'status', 'shippingAddress'],
    }),
    seeded('profile-event', '用户资料事件', {
      type: 'object',
      properties: {
        userId: {type: 'string'},
        nickname: {type: 'string'},
        locale: {type: 'string', enum: ['zh-CN', 'en-US']},
        tags: {type: 'array', items: {type: 'string'}},
      },
      required: ['userId'],
    }),
    seeded('category-tree', '分类树（自引用）', {
      type: 'object',
      properties: {
        name: {type: 'string'},
        slug: {type: 'string'},
        children: {type: 'array', items: {$ref: 'category-tree'}},
      },
      required: ['name'],
    }),
  ];
}
