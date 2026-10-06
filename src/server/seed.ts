import type {StoredContract} from '../shared/types';
import type {SchemaNode} from '../shared/types';

/** 演示数据：地址 -> 订单 -> 发货单 的引用链，外加一个树形自引用的评论树。 */
export const SEED_CONTRACTS: StoredContract[] = [
  {
    id: 'addresses',
    name: '地址',
    revisions: [
      {
        revision: 1,
        createdAt: 0,
        schema: {
          type: 'object',
          properties: {
            country: {type: 'string', enum: ['CN', 'US', 'JP']},
            city: {type: 'string'},
            line1: {type: 'string'},
            postalCode: {type: 'string'},
          },
          required: ['country', 'city', 'line1'],
        },
      },
    ],
  },
  {
    id: 'orders',
    name: '订单事件',
    revisions: [
      {
        revision: 1,
        createdAt: 0,
        schema: {
          type: 'object',
          properties: {
            orderId: {type: 'string'},
            status: {type: 'string', enum: ['created', 'paid', 'shipped', 'cancelled']},
            total: {type: 'number'},
            shippingAddress: {$ref: 'addresses'},
          },
          required: ['orderId', 'status', 'shippingAddress'],
        },
      },
    ],
  },
  {
    id: 'shipments',
    name: '发货事件',
    revisions: [
      {
        revision: 1,
        createdAt: 0,
        schema: {
          type: 'object',
          properties: {
            shipmentId: {type: 'string'},
            order: {$ref: 'orders'},
          },
          required: ['shipmentId', 'order'],
        },
      },
    ],
  },
  {
    id: 'comment-tree',
    name: '评论树（自引用）',
    revisions: [
      {
        revision: 1,
        createdAt: 0,
        schema: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            text: {type: 'string'},
            children: {type: 'array', items: {$ref: 'comment-tree'}},
          },
          required: ['id'],
        },
      },
    ],
  },
];

export function latestSchema(contract: StoredContract): SchemaNode {
  return contract.revisions[contract.revisions.length - 1].schema;
}
