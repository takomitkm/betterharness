# 空会话行为（Empty-Session Behavior）——DSH / OpenCode / zcode / Codex「新建对话 → 关闭」残留对照

> 调查日期：2026-11-11 ~ 11-12（本机，Asia/Taipei，UTC+8）
> 调查对象：DeepSeek Harness（DSH）、OpenCode、zcode、Codex（桌面版）
> 结论一句话：**DSH 与 OpenCode 会在「新建对话」时立即创建一个持久化会话记录，即使从未输入任何内容、随后直接关闭，该空会话记录仍会残留；zcode 虽也即时建行，但空会话从不持久化；Codex 桌面版本地完全不存线程，本地无任何残留（线程存服务端）。**

---

## 1. 背景与动机

DSH（DeepSeek Harness）用户观察到两个相关症状：

1. **「新建对话很慢，连点几次后崩溃」** —— 反复点击新建按钮时响应迟缓，多次连点可能导致程序异常。
2. **「有一个未命名绘画……全部是空的」** —— 会话列表中出现一个显示为「未命名/Untitled」的会话，点进去**一条消息都没有**（零 `user/message`、零 `assistant/message`），但会话文件在磁盘上确实存在。

需要弄清的核心问题是：**其他 agent / harness（OpenCode、zcode、Codex）是否也在「新建对话」时就创建会话记录？新建后直接关闭，是否也会残留？** 这决定「空会话残留」是 DSH 特有的实现缺陷，还是各家共有的通用行为。

---

## 2. 调查对象与本机存储布局

| Agent | 本机存储 | 形态 |
|---|---|---|
| **DSH** | `~/.dsh/sessions/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd` | 每会话一个 zstd 压缩 JSONL 事件日志（append-only） |
| **OpenCode** | `~/.local/share/opencode/opencode.db`（~207 MB，SQLite） | 单库，核心表 `session_v2` + `session_message` |
| **zcode** | `~/.zcode/cli/db/db.sqlite`（~839 MB，WAL） | 单库，核心表 `session` / `message` / `part` / `session_entry` 等 |
| **Codex**（桌面版） | `~/.codex/state_5.sqlite`、`~/.codex/sqlite/codex.db` 等 | 多库；`threads` 表 + 本地 catalog |

所有查询均为**只读**（SQLite 以 `mode=ro` 打开；DSH 会话文件直接流式解压读取），不修改任何 agent 的本地数据。

---

## 3. 逐 Agent 发现

### 3.1 DSH —— **是，残留**（两类都有）

**DSH 会话模型**：一个会话 = header（`sessionId`、`createdAt`、`cwd`、`agentPreset`）+ append-only 事件日志。派生视图（消息列表、标题、状态）全部从日志折叠而来，不单独存储。**零事件也是合法状态，header 会持久化。**

**A. 纯「新建 → 直接关闭」（从未输入）残留，确认 2 例：**

| 会话 | 文件大小 | 事件行数 | 内容 |
|---|---|---|---|
| `session-86a559a2-0f21-482b-abf7-d3da9101115f` | 337 B（zstd） | 4 | **仅** `session` header + `permission/preset` + `sandbox/mode` + `approval/policy`，**零消息、零 turn** |
| `session-b8d13438-c328-433f-a1c2-8c01c723366e` | 346 B（zstd） | 4 | 同上（header + 3 个 scaffold 事件），**零消息** |

这两个文件是最纯的证据：**用户从未输入内容、从未开始 turn、直接关闭**，但 header + 权限/沙箱/审批 scaffold 已落盘。

**B. 「新建 → 贴入长文 → 用户中止」（你点名的空对话），确认 1 例：**

`session-9e2b47d0-05be-4e6f-8191-22e31f2b9a50`（4083 B zstd，9 行）时间线（+08:00）：

| 时间 | 事件 |
|---|---|
| 11-04 11:13:11 | 创建（`createdAt:1793761991425`，`cwd:C:\Users\takomi\Downloads\dc2`） |
| 11-04 11:13:34 | `turn/start`（turn:1） |
| 11-04 11:13:37 | `turn/end`，`reason.kind=user`（**用户中止**，约 3 秒） |
| 11-09 23:08:56 | `session/end-seed`（空对象） |

事件序列：`session` header → `permission/preset` → `sandbox/mode` → `approval/policy` → `agent/inbox/spliced`（**注入 1 条用户消息**——一段关于 board/rootfs/DHCP/ICS 的长调查日志）→ `turn/start` → `agent/inbox/spliced`（`removedCount:1, inserted:[]`）→ `turn/end`（aborted）→ `session/end-seed`。

**关键点：全程零 `user/message`、零 `assistant/message` 事件。** 用户消息只以「inbox-spliced（已消费/已移除）」形式出现，从未成为正式消息事件。因此 UI 折叠出「零消息 + 未命名（derived 占位标签）」，即「全部是空的」。这是 **create → message → abort** 残留，与 A 类（纯 create → close）互为补充。

**总体规模**：全机 1006 个 DSH 会话目录中，17 个 <6 KB（疑似空壳/极小），其中确认的 header+scaffold-only 纯空壳如上；`session-9e2b47d0` 为 create→message→abort 型。

### 3.2 OpenCode —— **是，残留**

`session_v2` 表**保留 3 条零消息行**：

| `session_v2` id | 标题 | `time_created` |
|---|---|---|
| `ses_38ef5a43a101FJCJlpwKgcDeED` | API Test | 1792131395405 |
| `ses_544c6b41a101pdR2yS5zOCiWUB` | Test | 1792098913410 |
| `ses_ebe94b39affeitc0a0DGj7V2zT` | Test | 1792098913388 |

全库 88 个会话，`session_message` 计数分布 `[(0,3),(3,7),(4,4),(5,1),(6,2),(7,1),(8,2),(9,4),(10,1),(12,2)]` —— 即 3 个会话有 `session_v2` 行但 **0 条消息**。**OpenCode 直接回答：会残留。**

### 3.3 zcode —— **否，不残留**

- 全库 **1234 个会话**，**0 个零消息会话**（经 `message`/`part` 表以 `session_id` 外键统计）。
- `time_deleted` 列**从未被设置**（无软删除记录）。
- 会话创建时序（最新 6 个样例）：`session` 行与首个 `session_entry`（runtime/model_selection + runtime/execution_state）在**点击后 1–6 ms 内**写入；首条 `message` 在创建后 **76–347 ms** 到达。

**解读**：zcode **确实**在「点新建」时就创建 `session` 行（这是它的会话句柄），但**空的 `session` 行从不持久化/从不保留**——所有 1234 个会话都至少有一条消息。zcode 的持久化时机绑定在「真正来第一条消息」上；「新建后没输入就关闭」不会留下空壳行。（`sess_b04530c3-…` 一处 `first_msg` 早于 `time_created` 约 4.2 天，疑为 id 复用/回滚，单点异常，不影响总体结论。）

### 3.4 Codex（桌面版）—— **本地不残留（线程存服务端）**

- `~/.codex/state_5.sqlite` 的 `threads` 表：**0 行**（`archived`/`is_pinned`/`has_user_event` 分布全部为空）。
- `~/.codex/sqlite/codex.db`（本地 app-server catalog，13 表）：所有 session-bearing 表**空**；`local_thread_catalog_hosts` 仅 1 行 `{host_id:'local'}`，`initial_build_complete:1`、`observation_sequence:2` —— 本地 catalog **已完整构建过**，却 0 线程。
- `~/.codex`、`Documents`、`AppData\Roaming\OpenAI`、`AppData\Local\OpenAI` 全目录 walk：**无任何 session/rollout `.jsonl` 文件**（仅发现无关的 WeChat `session.db*`）。
- `.codex-global-state.json`：`local-projects: {}`（**空**），6 个本地数据迁移已完成；`desktop-first-seen-at-ms` 存在 → 桌面版。
- 日志体：`delete session success session_id="magpie-…"`（服务端会话 id）、`list_models` 请求 `https://chatgpt.com/backend-api/codex/models?client_version=0.166.0`、MCP `server/discover` 到 `chatgpt.com/backend-api/ps/mcp`。

**结论**：本机 Codex 桌面版把线程存在 ChatGPT **服务端**（`chatgpt.com/backend-api`），本地只有二进制/运行时与空 catalog，**本地可查部分零残留**；服务端是否残留无法从本机验证（且 ChatGPT 的「新建对话」通常在真正发送前不创建会话）。

---

## 4. 对照总表

| Agent | 新建对话即建记录？ | 关闭后残留？ | 残留形态 |
|---|---|---|---|
| **DSH** | ✅ 是 | ✅ **是** | `session.v4.jsonl.zstd` 空壳（header + permission/sandbox/approval scaffold，零消息零 turn，337–346 B）；或 create→message→abort 型（header + scaffold + inbox-spliced + turn start/end aborted，4083 B） |
| **OpenCode** | ✅ 是 | ✅ **是** | `session_v2` 零消息行（3 例） |
| **zcode** | ✅ 是（1–6 ms 内写行） | ❌ **否** | 无——0/1234 零消息会话，空行从不持久化 |
| **Codex** | 本地无记录 | ❌ **本地否** | 本地 `threads` 0 行、catalog 0 行、无会话文件；线程存服务端 |

---

## 5. 机制解释

- **DSH / OpenCode**：把「会话」当作一等持久化对象，**创建即落盘**（DSH 落 header+scaffold，OpenCode 落 `session_v2` 行）。关闭时不回收空对象 → 残留。DSH 的「未命名」只是从日志派生（无 user 消息触发自动标题）的占位标签，**不是**独立的「空会话状态」。
- **zcode**：`session` 行是会话句柄，但**持久化绑定首条消息**（或空行即弃）。因此「没输入就关」不会残留。这与 DSH 把空会话建模为「显式持久化空容器」是**相反策略**。
- **Codex**：桌面版本地无线程存储（服务端架构），本地无可残留物。

**对 DSH 症状的意义**：DSH 每次点「新建」都会创建并持久化一个空会话文件；「连点几次」会积累多个空壳；会话列表从缓存元数据列出所有持久化空会话（无需打开日志体）→ 表现为列表里出现一串「未命名/全部是空的」会话，反复新建也带来磁盘/列表开销。这与「新建对话很慢、连点几次后崩溃」的体感一致（反复新建 = 反复创建+持久化空容器 + 列表重建）。

**可考虑的改进方向（仅供参考）**：DSH 可将「从未产生任何用户消息」的空会话视为非持久化（仅在首条消息到达时落盘），或提供空会话的惰性回收；这样既保留「零事件合法」的模型，又避免空壳堆积。

---

## 6. 证据附录（本机路径 / 表名 / 会话 id）

**DSH**
- `C:\Users\takomi\.dsh\sessions\--S-apps-llm-agentwork--\session-26309967-f103-436a-9eca-d8ecd2a5df4a\session.v4.jsonl.zstd`（对照：有真实消息的会话）
- `C:\Users\takomi\.dsh\sessions\--C-Users-takomi-codearts-2026-10-30-05-47-28--\session-86a559a2-0f21-482b-abf7-d3da9101115f\session.v4.jsonl.zstd`（337 B，纯空壳）
- `C:\Users\takomi\.dsh\sessions\--S-work-WCIS-source-export-agents-memo~0020-~0020dsh--\session-b8d13438-c328-433f-a1c2-8c01c723366e\session.v4.jsonl.zstd`（346 B，纯空壳）
- `C:\Users\takomi\.dsh\sessions\--C-Users-takomi-Downloads-dc2--\session-9e2b47d0-05be-4e6f-8191-22e31f2b9a50\session.v4.jsonl.zstd`（4083 B，create→message→abort）
- 全机会话目录计数：1006；<6 KB：17

**OpenCode**
- `~/.local/share/opencode/opencode.db` → `session_v2`（88 行；3 零消息行 id 见 3.2）、`session_message`

**zcode**
- `~/.zcode/cli/db/db.sqlite` → `session`（1234 行，`time_deleted` 全空）、`message`/`part`（`session_id` 外键）、`session_entry`（`entcnt` 分布 `[(2,18),(3,675),(4,278),(5,129),(6,21),(7,7),(8,13),(9,12),(10,2),(11,2),(12,7),(13,7)]`）、`title_source`（generated=56 / first_input=1129 / custom=49）

**Codex**
- `~/.codex/state_5.sqlite` → `threads`（0 行）、`thread_sections`、`logs_2.sqlite`（~1490 行，`thread_id` 全 NULL）
- `~/.codex/sqlite/codex.db` → `local_thread_catalog_hosts` / `local_thread_catalog_sync_state` / `local_thread_catalog_metadata`（catalog 空但 `initial_build_complete:1`）
- `~/.codex/.codex-global-state.json` → `local-projects: {}`、`desktop-first-seen-at-ms`、6 个已完成迁移
