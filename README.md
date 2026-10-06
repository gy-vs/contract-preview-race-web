# contract-preview-race-web

事件契约工作台：把散落在 wiki 里的契约集中管理，带样例预览校验、乐观并发保存、破坏性改动守护与影响传递标记。

## 运行

```bash
npm install
npm run dev      # Express(4174) + Vite(4173，/api 代理到后端)
npm run build    # tsc --noEmit + vite build
npm test         # vitest
```

## 契约格式（JSON Schema 子集）

支持 `type` / `properties` / `required` / `enum` / `items`，以及指向另一份契约的引用：

```jsonc
{
  "type": "object",
  "properties": {
    "orderId": {"type": "string"},
    "shippingAddress": {"$ref": "address"},      // 跟随最新 revision
    "billingAddress":  {"$ref": "address@3"}     // 钉死 revision 3
  },
  "required": ["orderId"]
}
```

`$ref` 必须是节点内唯一关键字。自引用（树形契约）合法，新建契约允许跟随最新的自引用。

## 行为约定

- **revision**：每次保存产生一个新 revision；`GET /api/contracts/:id/revisions/:rev` 可取历史版本。
- **乐观并发**：保存带 `baseRevision`，落后于最新则 `409` 并返回当前最新内容；前端保留未保存文本并展示与对方版本的行级 diff。
- **预览校验**：`POST /api/contracts/:id/preview`，`{schema, sample}` 或 `{schema, sampleText}`。校验连同引用一起展开，错误定位到样例内路径（`$.lines[0].sku`）。校验器全程显式栈迭代，几千层嵌套样例不会栈溢出；深样例请走 `sampleText` 原文通道（`JSON.stringify` 本身承受不了深嵌套）。编辑中契约的「跟随最新」自引用解析到编辑中的 schema。
- **破坏性改动**：删字段、必填约束变化、类型收窄（`integer→number` 放宽除外）、删枚举值/新增枚举约束、数组元素约束变化、引用改目标后不兼容。默认 `422 breaking` 挡住，`force: true` 确认发布。
- **影响传递**：破坏性发布后，所有「跟随最新」引用它的契约（含多层间接引用）在列表中标记 `affectedBy`；钉死旧 revision 的不受影响。最新 revision 变为兼容后标记消失。
- **前端竞态**：契约载入与预览响应都按序号 + 契约 id 双重核对（并 abort 旧请求），快速切换时右侧只显示当前选中契约的结果；当前契约同步在 `?contract=` 查询参数里。

## 结构

```
src/shared/schema.ts    共享类型、$ref 解析、路径工具
src/server/store.ts     ContractStore 接口（可替换）+ 进程内实现
src/server/schema-check.ts  子集合法性校验
src/server/validate.ts  样例校验（迭代，无递归）
src/server/compat.ts    破坏性改动判定（引用对记忆化，支持自引用）
src/server/impact.ts    影响沿跟随最新引用链的传递分析
src/server/index.ts     Express 路由，createApp(store?) 可注入存储
src/client/             React 工作台（列表 / 编辑器 / 预览三栏）
test/                   冲突保存、递归引用校验、破坏性传递等接口测试
```

未引入 ajv / json-schema-diff 等库：校验与兼容判断均为本仓库实现。
