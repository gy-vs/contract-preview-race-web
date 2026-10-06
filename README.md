# contract-preview-race-web

事件契约工作台：管理 JSON Schema 子集契约、跨契约引用、revision 化保存、
破坏性改动把关、样例实时校验。前端 React + Vite，后端 Express，存储默认进程内。

## 运行

```bash
npm install
npm run dev      # Vite http://localhost:4173，API http://127.0.0.1:4174（已配代理）
npm run build    # tsc --noEmit + vite build
npm test         # vitest
npm start         # 仅起 API/静态服务器（需先 build）
```

## 契约格式

支持的 JSON Schema 子集关键字：`type`、`properties`、`required`、`enum`、`items`，
外加跨契约引用 `$ref`：

```json
{
  "type": "object",
  "properties": {
    "shippingAddress": { "$ref": "addresses" },
    "billingAddress":  { "$ref": "addresses@3" }
  },
  "required": ["shippingAddress"]
}
```

- `"addresses"` / `"addresses@latest"`：跟随该契约的最新 revision；
- `"addresses@3"`：钉死 revision 3，上游后续改动与它无关；
- 树形结构可以自引用（如 `children: {type: "array", items: {$ref: "comment-tree"}}`）。

## 核心行为

- **每次保存生成新 revision，乐观锁**：保存时必须带 `expectedRevision`；
  基于旧 revision 的保存返回 `409` 并附当前内容，前端保留未保存文本、
  展示两份 revision 的差异，支持“保留我的文本更新基线”或直接用最新版覆盖。
- **破坏性改动把关**：删字段、字段变必填、类型互转/收窄（number→integer）、
  删枚举值、新增元素约束默认被 `422` 挡住，返回清单；作者显式
  `confirmBreaking: true` 后才能发布。加字段、放宽类型、加枚举值不拦截。
- **影响传播**：源头发布破坏性 revision 后，所有“跟随最新”直接或间接
  引用它的契约在列表中标红，并给出传导链（如 `shipments → orders → addresses`）；
  钉死 revision 的引用不受影响；上游再发一个兼容 revision 后标记消失。
- **预览竞态安全**：右侧贴样例后防抖校验；快速切换契约或响应乱序返回时，
  只显示“当前选中契约 + 最新一次请求”的结果。当前契约写在
  `location.hash`（`#/contracts/<id>`），刷新后回到同一份。
- **深嵌套不爆栈**：样例校验、JSON 解析/序列化、结构检查、兼容比对全部为
  迭代式实现；4000 层嵌套样例可正常校验并定位到叶子路径（错误数超过
  300 条会截断显示，防止递归样例每层报错撑爆内存）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/contracts` | 列表（含 affected 影响来源与传导链） |
| GET | `/api/contracts/:id` | 单份契约全部 revisions |
| GET | `/api/contracts/:id/revisions/:rev` | 指定 revision |
| POST | `/api/preview/:id?` | 用编辑中的 schema + 样例做校验，错误带 JSONPath |
| PUT | `/api/contracts/:id` | 保存（乐观锁 + 破坏性确认，body 见下） |

保存 body：

```json
{ "name": "订单事件", "expectedRevision": 1, "schema": { }, "confirmBreaking": false }
```

## 存储

`src/server/store.ts` 定义 `ContractStore` 接口（list/get/save），默认实现
`InMemoryContractStore` 为进程内 Map（重启回到种子数据）。接数据库时实现
同一接口注入 `ContractService` 即可，其余代码不需要改动。

## 代码结构

```
src/shared/types.ts        子集 Schema、revision、issue 等共享类型
src/server/
  json-parse.ts            迭代式 JSON 解析/序列化（深嵌套兜底）
  refs.ts                  $ref 语法与解析
  schema-check.ts          契约自身结构校验
  validate.ts              样例校验（迭代式，错误定位到样例路径）
  compat.ts                相邻 revision 的破坏性改动判定
  impact.ts                破坏性改动沿“跟随最新”引用边反向传播
  store.ts / seed.ts       存储接口（可替换）/ 种子契约
  service.ts / index.ts    业务编排与 Express 路由
src/client/                React 三栏工作台（列表 / 编辑 / 预览）
test/                      API + 解析器测试
```
