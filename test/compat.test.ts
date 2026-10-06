import {describe, expect, it} from 'vitest';
import {findBreakingChanges} from '../src/server/compat';
import {createResolver} from '../src/server/resolve';
import type {SchemaNode} from '../src/shared/schema';

const noRefs = createResolver([]);

function breaking(oldSchema: SchemaNode, newSchema: SchemaNode): string[] {
  return findBreakingChanges(oldSchema, newSchema, noRefs).map(issue => `${issue.path}: ${issue.message}`);
}

describe('破坏性改动判定', () => {
  it('完全相同的 schema 没有破坏性', () => {
    const schema: SchemaNode = {type: 'object', properties: {a: {type: 'string'}}, required: ['a']};
    expect(findBreakingChanges(schema, {...schema}, noRefs)).toEqual([]);
  });

  it('删除字段是破坏性，新增可选字段不是', () => {
    const oldS: SchemaNode = {type: 'object', properties: {a: {type: 'string'}, b: {type: 'number'}}};
    const removed: SchemaNode = {type: 'object', properties: {a: {type: 'string'}}};
    expect(breaking(oldS, removed)).toEqual(['$.b: 字段被删除']);

    const added: SchemaNode = {type: 'object', properties: {a: {type: 'string'}, b: {type: 'number'}, c: {type: 'string'}}};
    expect(findBreakingChanges(oldS, added, noRefs)).toEqual([]);
  });

  it('必填约束两个方向的变化都算破坏性', () => {
    const oldS: SchemaNode = {type: 'object', properties: {a: {type: 'string'}, b: {type: 'string'}}, required: ['a']};
    const moreRequired: SchemaNode = {...oldS, required: ['a', 'b']};
    expect(breaking(oldS, moreRequired)).toEqual(['$.b: 字段由可选变为必填']);
    const lessRequired: SchemaNode = {...oldS, required: []};
    expect(breaking(oldS, lessRequired)).toEqual(['$.a: 字段由必填变为可选']);
  });

  it('类型收窄是破坏性，integer → number 放宽不是', () => {
    expect(breaking({type: 'number'}, {type: 'integer'})).toEqual(['$: 类型由 number 变为 integer']);
    expect(breaking({type: 'string'}, {type: 'number'})).toEqual(['$: 类型由 string 变为 number']);
    expect(findBreakingChanges({type: 'integer'}, {type: 'number'}, noRefs)).toEqual([]);
    expect(breaking({}, {type: 'string'})).toEqual(['$: 新增类型约束 string']);
    expect(breaking({type: 'string'}, {})).toEqual(['$: 移除了类型约束 string']);
  });

  it('删枚举值是破坏性，新增枚举值不是；新增枚举约束是破坏性', () => {
    const oldS: SchemaNode = {type: 'string', enum: ['a', 'b', 'c']};
    expect(breaking(oldS, {type: 'string', enum: ['a', 'b']})).toEqual(['$: 删除枚举值: "c"']);
    expect(findBreakingChanges(oldS, {type: 'string', enum: ['a', 'b', 'c', 'd']}, noRefs)).toEqual([]);
    expect(findBreakingChanges(oldS, {type: 'string'}, noRefs)).toEqual([]);
    expect(breaking({type: 'string'}, {type: 'string', enum: ['a']})).toEqual(['$: 新增枚举约束']);
  });

  it('嵌套字段的改动带完整路径', () => {
    const oldS: SchemaNode = {
      type: 'object',
      properties: {lines: {type: 'array', items: {type: 'object', properties: {qty: {type: 'number'}}}}},
    };
    const newS: SchemaNode = {
      type: 'object',
      properties: {lines: {type: 'array', items: {type: 'object', properties: {qty: {type: 'integer'}}}}},
    };
    expect(breaking(oldS, newS)).toEqual(['$.lines[*].qty: 类型由 number 变为 integer']);
  });

  it('引用字符串相同视为等价；改钉死的 revision 会解析后比较', () => {
    const records = [
      {id: 'address', name: '地址', revisions: [
        {revision: 1, schema: {type: 'object', properties: {zip: {type: 'string'}}} as SchemaNode, savedAt: '', breaking: false, changes: []},
        {revision: 2, schema: {type: 'object', properties: {zip: {type: 'integer'}}} as SchemaNode, savedAt: '', breaking: true, changes: []},
      ]},
    ];
    const resolve = createResolver(records);
    const oldS: SchemaNode = {type: 'object', properties: {addr: {$ref: 'address@1'}}};
    // 引用没变 → 不等被引用契约内部的账
    expect(findBreakingChanges(oldS, {type: 'object', properties: {addr: {$ref: 'address@1'}}}, resolve)).toEqual([]);
    // 改钉 address@2（zip 收窄为 integer）→ 破坏性
    const repinned: SchemaNode = {type: 'object', properties: {addr: {$ref: 'address@2'}}};
    expect(findBreakingChanges(oldS, repinned, resolve).map(i => `${i.path}: ${i.message}`))
      .toEqual(['$.addr.zip: 类型由 string 变为 integer']);
  });

  it('自引用契约对比自身修订会收敛，不死循环', () => {
    const oldS: SchemaNode = {
      type: 'object',
      properties: {name: {type: 'string'}, children: {type: 'array', items: {$ref: 'tree'}}},
    };
    // 同样的自引用结构（引用字符串相同直接短路），仅把 name 收窄为枚举 → 只有一处破坏性
    const newS: SchemaNode = {
      type: 'object',
      properties: {name: {type: 'string', enum: ['a']}, children: {type: 'array', items: {$ref: 'tree'}}},
    };
    expect(breaking(oldS, newS)).toEqual(['$.name: 新增枚举约束']);
  });
});
