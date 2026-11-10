# app-react（产品线 UI，Phase 1 恢复中）

从 archive/ts 复活的 React + Lexical 产品 UI。处置表见
`docs/architecture/composer-asset-inventory.md` §3。

## 当前状态（Phase 1 第一步：整体恢复 + 基线跑通）

- 代码 = archive/ts 原样（B01–B32 浏览器测试 + 76 单元测试 + 14 变异）。
- 引擎仍是 archive/ts 的 TS core.ts——**这是受控测试 Adapter，不是最终实现**
  （PRODUCT-LINE-PLAN §4.4：不得把 Mock 当成最终实现）。
- 下一步（Phase 1 第二步 → Phase 2）：core.ts 调用点收口到 Bridge 门面，接
  composer-runtime WASM。

## 命令（校机执行）

```sh
npm ci
npm run typecheck
npm test          # 76 单元
npm run test:browser   # 34 浏览器（CE_BROWSER_CHANNEL=msedge）
npm run test:mutations # 14 变异
```
