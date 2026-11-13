# OUT-021：E3d 完成——不可靠网络 E2E 12/12×3 稳定 + 六套 92 判据全绿

- **轮次**：goal 后第二十一次输出
- **日期**：2026-11-13

## 本轮做了什么

1. **菜单点击选择**（Pick 事件）：点击某项 = 定位 + 接受（替换写回不提交）。
2. **场景化 executor**（`?scenario=`）：reject/uncertain/超时真触发 + SetScenario
   运行时切换 + composerTest 注入钩子。
3. **不可靠网络 E2E**（taino-network-e2e.mjs，12 判据 ×3 稳定）：丢 ack→uncertain/
   无轮次开立/LookupResult 恢复（FM25）/迟到超时不降级（FM04）/rejected→Retry 同
   身份（FM15）/uncertain 阻塞下第二条 queued（FM05）/turn 闸门保持排队（FM12）/
   end_turn 派发/菜单 Pick/零错误。
4. **跨机构建铁律**：解包+touch+build+bindgen+run 同脚本（根治 cargo mtime 误判）。
5. **上游确认**：dioxus-desktop 适配器零排期；PR #24 open 等响应。

## 验证证据（校机）

- `e3d-final2.log`：**六套全绿 = 92 判据**（18+14+12+6+24+12）
- `net-stab1/2/3.log`：network 三连跑 12/12 稳定
- `e3d-build8.log`：wasm32 构建零错误

## 汇报两个生态问题的结论（见对话）

- dioxus-desktop 适配器：上游无排期（ROADMAP/issues 零提及）——desktop 切 taino
  需 DomBridge trait 抽象（web=web-sys / desktop=IPC→WebView JS 代理），上游规模工作。
- React WASM 线排除 CI 是范围取舍（独立构建链），本轮已补 composer-react 工作流。

## goal-log：D001–D021 + OUT-001–OUT-021
