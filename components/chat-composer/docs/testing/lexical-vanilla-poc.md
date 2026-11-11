# lexical-vanilla-poc.md（Phase 1 Go/No-Go 报告）

> A+ 计划 Phase 1 交付。详细设计决策见 `docs/goal-log/decisions/D008-lexical-island-controller.md`；失效模式清单见 `lexical-island/tests/keynav.test.ts` 头部。

## Go/No-Go 结论：**Go**

按 A+ 计划 §4.8 五条逐项核对：

| 条件 | 结果 |
| --- | --- |
| 目标 Lexical 功能完整 | ✓ createEditor + registerPlainText + registerHistory + 自定义命令 |
| 无 React 运行时依赖 | ✓ esbuild metafile 零 react/scheduler 输入；package.json 零 react 依赖 |
| 原始 B 系列测试可迁移到 Vanilla Controller | ✓ KD01–KD11 契约子集 Node 复刻 8/8；B12 合成 IME + Enter 不提交复现 |
| 原有输入/选区/撤销行为无退化 | ✓ 真实键盘输入、IME 合成、Shift+Enter、setDisabled 均通过 |
| Dioxus 稳定挂载/操作/销毁 Island | ⏳ Phase 3 集成阶段验证（island 是普通 DOM 包，挂载 = 容器 div + createController 调用） |

## 测试结果

| 测试集 | 数量 | 环境 |
| --- | --- | --- |
| Node 单元（KD 契约） | 8/8 | node --test --test-reporter=spec |
| 浏览器行为（失效模式 1/2/4/6/9/11） | 14/14 | Playwright + msedge + Lexical 0.36.2 |
| React 泄漏审计 | 0 react/scheduler | esbuild metafile 审计 |

## 版本锁定

| 包 | 版本 |
| --- | --- |
| lexical | 0.36.2 |
| @lexical/plain-text | 0.36.2（传递提升） |
| @lexical/history | 0.36.2（传递提升） |
| @lexical/react | 0.36.2（仅参考实现） |
| react | 19.3.1（仅参考实现） |

## 失效模式清单（12 条）

详见 `lexical-island/tests/keynav.test.ts` 头部。摘要：

| # | 失效 | 绑定用例 |
| --- | --- | --- |
| 1 | 双重初始化 | browser: 显式报错 ✓ |
| 2 | 销毁残留 | browser: 容器归零 + 组合不再触发 ✓ |
| 3 | React 泄漏 | build: metafile 审计 ✓ |
| 4 | IME 组合中 Enter 误发 | browser: 合成事件验证 ✓ |
| 5 | 组合结束宽限窗 | node: KD03 + KD11 ✓ |
| 6 | Shift+Enter 误提交 | browser ✓ |
| 7 | repeat 连发 | node KD06 ✓ |
| 8 | 非 Enter 误拦 | node KD08 ✓ |
| 9 | getDocument 上下文 | controller.read 封装 ✓ |
| 10 | setDocument 污染撤销栈 | PoC 排除（A3 验证：setDocument + historic tag） |
| 11 | setDisabled 后输入 | browser ✓ |
| 12 | 多实例干扰 | browser: 双容器独立 ✓ |

## 下一步

A3：Dioxus + Island 集成（中文 IME 全覆盖 + 附件混排 + 撤销栈 + Selection 行为）。
