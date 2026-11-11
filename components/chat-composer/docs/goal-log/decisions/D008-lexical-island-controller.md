# D008：Lexical Island Vanilla Controller——Port 决定与双源维护约定

- **日期**：2026-11-12
- **状态**：已落地（Node 8 项 + 浏览器 14/14，React 泄漏审计 NONE）
- **关联**：D006（A+ 采纳）；PRODUCT-LINE-PLAN Phase 1；writing-tests 失效模式清单（12 条，测试文件头部）

## 决定

1. **island 包自包含**：`lexical-island/` 独立 package（lexical@0.36.2 + @lexical/plain-text + @lexical/history 直接依赖，零 react）。纯逻辑（keynav.ts）与 DOM 接线（create-controller.ts）分离。
2. **keynav.ts 双源维护**：`decideEnter`/`ImeTracker` 在 island 内保有 TS 镜像（DOM 事件必须同步执行），Rust keynav crate 是契约权威——**两侧用同一组 KD 契约测试向量**（KD01/02/03/04/06/07/08/09/10/11 已在 island 测试中复刻）。任一侧语义变更必须双侧同步 + 对拍。
3. **Enter 仲裁优先级 = COMMAND_PRIORITY_HIGH**（archive 同款）：`registerPlainText` 在 EDITOR 优先级注册了 KEY_ENTER_COMMAND 且返回 true 截停传播——island 的仲裁必须先跑。实测：EDITOR 优先级时 Enter 提交事件永不触发（教训实录）。
4. **Placeholder 不用 React**：纯 DOM 元素 + update listener 切换显隐。
5. **destroy = LIFO 回收**：register* 返回的解除函数按序登记、destroy 时逆序全解 + `setRootElement(null)` + root/placeholder 移除——资源归零断言过（失效模式 2）。
6. **双重初始化显式报错**：容器内已有 `[data-lexical-root]` 即抛（失效模式 1）；测试对准**活容器**（重挂载后存在多个 #island，querySelectorAll 取最后一个）。

## 调试实录（每条烧过一轮）

1. mount 后未 focus → 重挂载输入打空（首次 mount 有 focus、remount 没有）——mount 助手统一 focus。
2. `eventsOf` 返回 undefined 误导排查——Enter 没触发提交是优先级截停，不是事件系统问题；先把✔/✖改成即时打印才定位。
3. tail 截断日志（run 脚本）让早期 rev 消失——去掉 tail 全量留证。
4. Node 复刻脚本（engine-pump-smoke / node-e2e-replica）分离「泵逻辑 bug」与「浏览器环境」变量的方法有效——本轮浏览器问题全是测试/优先级问题，泵语义在 Node 已证清白。

## 后果

- Phase 1 PoC（控制器部分）达成：mount/输入/IME/Enter/序列化/clear/destroy/重挂载/双重初始化拒绝——浏览器 14/14 + Node 8/8。
- Dioxus 挂载 PoC（A1 尾/A3 头）未做：island 是普通 DOM 包，Dioxus 只需渲染容器 div + onmounted 时调 createController——下一轮。
- island 的 Rust 权威对拍（keynav Rust↔TS 同向量）已由同 fixtures 保证；将来 Rust 侧语义变更先改 Rust 测试再同步 TS。
