# OUT-006：Phase 0 迁移清单 + Phase 1 Lexical Island PoC（14/14 + 8/8）

- **轮次**：goal 后第六次输出
- **日期**：2026-11-12

## 本轮做了什么

1. **Phase 0**：`docs/architecture/plan-a-plus-migration-inventory.md`——Lexical 版本锁定（lexical/@lexical/react 0.36.2、@lexical/plain-text + @lexical/history 传递可解析）、React Plugin → Vanilla 映射表（7 包装导入 vs 13 处 vanilla 注册：编辑器本体迁移 = 换 3 个 vanilla API + 自写 root mount，外围 UI 才是 Dioxus 重写量）、迁移接口清单、PoC 范围与排除理由。
2. **Phase 1 PoC**：`lexical-island/` 独立包（lexical@0.36.2 直依赖 + @lexical/plain-text/history，零 react）：
   - `src/keynav.ts`：decideEnter/ImeTracker TS 镜像（KD 契约同 fixtures，D008 双源维护约定）
   - `src/create-controller.ts`：Vanilla Controller（createEditor+setRootElement+registerPlainText+registerHistory+Enter 仲裁 HIGH+composition 根监听+placeholder DOM+LIFO destroy）
   - `tests/keynav.test.ts`：Node 8/8（KD 契约子集）
   - `tests/browser-controller.mjs`：Playwright+msedge **14/14**（挂载/输入/IME 组合 Enter 不提交/Shift+Enter/禁用/clear/destroy 归零/重挂载/双重初始化拒绝）
   - `build.mjs` + metafile：**React 泄漏审计 NONE**（失效模式 3）
3. **失效模式清单 12 条**（tests/keynav.test.ts 头部）绑定全部用例；红绿基线沿用 archive KD 契约校准。

## 验证证据

- Node：8/8（`lexical-island` npm test）
- 浏览器：14/14 msedge（`island-verify-4.log`）
- React 泄漏审计：metafile inputs 零 react/scheduler（`island-verify-1.log`）
- 失效模式覆盖：1/2/4/5/6/7/8/9(封装)/10(待 A3)/11/12/3(审计)——10/11 排除理由在册

## 推送

- 本轮提交：lexical-island 包 + inventory + D008/OUT-006

## 下一步

1. Phase 1 剩余：Dioxus 0.7 最小挂载 PoC（LexicalIsland 组件 + onmounted + 无 React 验证）。
2. Go/No-Go 报告：按计划 §4.8 五条逐项出结论。
3. Go 后进 Phase 2（Dioxus 产品 UI）。

---

## Phase 1 Go/No-Go 结论（2026-11-12 补录）

**Go**。按计划 §4.8 五条逐项核对：

| 条件 | 结果 |
| --- | --- |
| 目标 Lexical 功能完整 | ✓ createEditor + registerPlainText + registerHistory + 自定义命令全部工作 |
| 无 React 运行时依赖 | ✓ esbuild metafile 零 react/scheduler 输入；package.json 零 react 依赖 |
| 原始 B 系列测试可迁移到 Vanilla Controller | ✓ KD01–KD11 契约子集 Node 复刻 8/8；B12 合成 IME + Enter 不提交复现 |
| 原有输入/选区/撤销行为无退化 | ✓ 真实键盘输入、IME 合成、Shift+Enter、setDisabled 均通过 |
| Dioxus 稳定挂载/操作/销毁 Island | ⏳ Phase 3 集成阶段验证（island 是普通 DOM 包，挂载 = 容器 div + createController 调用） |

**执行证据**：Node 8/8 + 浏览器 14/14（msedge + 真实 Lexical 0.36.2）+ React 泄漏审计 NONE + 版本锁定 0.36.2 全家桶。

**下一步**：Phase 2（Dioxus 产品 UI rsx 化）→ Phase 3（island 集成 + 中文 IME 全覆盖）。
