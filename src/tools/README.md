# Model-Facing Tools

四个模型专属工具，通过 `deps.ts` 的 `ToolDeps` 接口与编排层解耦。`history` 保持单工具工作流，flat schema 再由运行时按 operation 严格校验。

## 总览

| 工具 | 文件 | 角色 | 通道 |
|---|---|---|---|
| `get_context_remaining` | [get-context-remaining.ts](./get-context-remaining.ts) | 预算仪表盘：实时剩余 token + 窗口身份 | 拉式（模型主动查） |
| `new_context` | [new-context.ts](./new-context.ts) | 换窗声明：无参数意图声明，turn 边界执行 | 推式（延迟消费） |
| `notes` | [notes.ts](./notes.ts) | 持久检查点：跨窗口存活的虚拟文件系统 | 写入通道（信息延续主通道） |
| `history` | [history.ts](./history.ts) | 会话恢复：窗口/条目浏览、字面量定位、稳定 ID 精读 | 恢复索引与读取 |

## get_context_remaining

- **无参数**。返回一句话：`You have {n} tokens left in this context window. (window {wN})`，无数据时 `unknown`
- 数据源：pi 的 `ctx.getContextUsage()`（最后一条 assistant 的服务端 usage + 尾部估算）
- 换窗后到下一次 usage 返回之前返回 `unknown`（与 codex 行为一致）
- notes 膨胀时（阈值从 `notesMaxFileBytes` 派生：单文件 cap/16、总量 cap/4）追加 ⚠ 软警告行，提醒模型精简检查点（次通道；主通道在 reminder 消息内）
- 不产生持久注入——只在被调用时消耗 ~15 token

## new_context

- **无参数**（纯意图声明：不摘要、不配置保留项）
- `execute()` 只置位 `pendingNewContext` 标记并立即返回确认文案——**绝不打断当前响应**
- 真正换窗在 turn 边界（`agent_settled` → `ctx.compact()` → `session_before_compact` 拦截）或 pi 自动压缩触发时
- 换窗提交后由编排层注入续跑消息，任务在新窗口自动继续
- **确认文案携带本窗口的 recent-item 索引**（同一份 25×120 参数、与 reminder 同源）：主动换窗是唯一一条 reminder/fallback 都没触发过的路径，模型从未见过 item id，notes 里就没有锚点。该文本是**旧窗口**的 tool result，换窗哨兵连同旧 trace 一起丢弃 → 新窗口零成本，而模型当场还有行动能力（此路径无 fence，可再 `notes.append` 抄 id）。

## notes

多操作工具，包装 [stores/notes-store.ts](../stores/notes-store.ts)：

| 操作 | 参数 | 说明 |
|---|---|---|
| `write` | `path`, `text` | 创建/整文件替换 |
| `append` | `path`, `text` | 追加（检查点累积）；撞顶报错含剩余配额与可清理文件提示 |
| `delete` | `path` | 显式删除一个普通 note 文件；不会自动清理或完成 checkpoint fence |
| `read` | `path`, `start_line?`, `stop_line?`, `offset_chars?`, `limit_chars?` | 全文、行区间（负数=从尾部数）或字符窗口（与 history 的 `read_item` 对齐，可越过超长单行）；limit 钉到输出上限，头部位置永远诚实 |
| `search` | `query`, `prefix?`, `max_files?`, `max_matches_per_file?` | 字面量子串 |
| `list` | `prefix?`, `max_results?` | 路径前缀列表；超派生阈值时附加膨胀软警告行 |

约束（store 层强制）：虚拟路径不可逃逸、单文件不超过生效配置上限、读立即可见写；删除只接受普通文件路径。

## history

单个只读工具包装 [stores/history-store.ts](../stores/history-store.ts)。schema 公开所有操作字段，`execute` 再按 operation 使用白名单严格校验；错传字段、缺少条件、类型错误都会返回带纠正示例的 `isError=true`，不会静默忽略。

| operation | 必填参数 | 可选参数与默认值 |
|---|---|---|
| `list_windows` | — | — |
| `list_items` | — | `window_id?`, `role?`, `kind=message`, `scope=task`, `tool_name?`, `limit=20`, `recent_first=true` |
| `search_contents` | `query` | `window_id?`, `role?`, `kind=all`, `scope=task`, `tool_name?`, `limit=10`, `recent_first=true` |
| `read_item` | `item_id` | `offset_chars=0`, `limit_chars=2000` |

`scope=task` 保留用户/助手可见文字和普通工具证据，过滤当前/旧 history、`notes`、`new_context`、`get_context_remaining` 的调用及结果、本插件 custom message 和 bootstrap。`scope=all` 显式包含这些内部记录用于诊断，但仍不返回 structured thinking 或嵌套 tool-result block。正在执行的 history tool-call block 即使在 `scope=all` 也按 `toolCallId` 排除，避免查询参数命中自身。

`kind` 与 `role` 取交集：

- `message`：user/assistant 可见正文和图片占位，不匹配同条消息的工具参数
- `tool_call`：assistant 工具调用
- `tool_result`：顶层工具结果和 bashExecution 输出
- `all`：当前 scope 内全部安全投影内容

`tool_name` 单独使用时隐含 `kind=tool_result`；搭配 `kind=all` 可同时匹配该工具的调用和结果。混合 assistant 消息按 block 投影，过滤内部 history 调用时不会丢掉同条消息中的正文或普通工具调用。工具结果优先使用显式 `toolName`，缺失时只向前查找 `toolCallId`；无法关联的来源标为 `unknown`，不会错误绑定未来调用。

每个 entry 只有一份 canonical safe text。搜索返回原文 UTF-16 坐标、最多三个短 excerpt region 和可直接传给 `read_item` 的 `read_offset/read_limit`；emoji、超长单行和多命中都不需要重新猜位置。过滤造成的不连续区间不会被拼成一个可跨越匹配的字符串。已知 item id 可直接读取，包括 task 视图隐藏的内部条目。

`list_windows/list_items/search_contents` 使用 opaque cursor 分页。首调用记录 session id、固定 branch leaf、归一化过滤器、当前 tool-call 排除项和最后记录；续页只允许 `operation+cursor`。游标 checksum/shape/version 不符、跨 session、operation 不符或 snapshot 不再是当前 branch 祖先时均明确失败。首批之后追加的 entry 不进入该分页快照，同 session 进程重启后仍可续页。

短期四工具版本（`history_list_windows/history_list_items/history_search/history_read_item`）已撤销；只在当前有效持久 guidance 包含这些名字时，通过 `context` 事件注入一次非持久迁移提示。

**recent-item 索引**：reminder/fallback/new_context 统一使用 `scope=task, kind=all`，先过滤再取 25×120 字符。用户请求索引继续使用原 user entry id，编辑文件索引继续指向真实 edit/write assistant entry。

**防爆炸保证**：read 正文受全局上限约束；list/search 使用 `min(maxToolOutputChars, 6000)`，只打包完整记录。预算不足以容纳完整 preview 时会缩短正文但保留 id、canonical 坐标和 cursor；仍放不下则返回明确错误。

**惰性渲染**：构造阶段只扫描窗口、角色、块类型和工具调用关联元数据；list 只渲染当前页，search 收集到 `limit+1` 后停止，read 只渲染目标 item。

## 共享约定

- 所有工具描述末尾附 `TOOL_PRIVATE_USAGE_HINT`（私有簿记，不对用户泄露）
- 成功输出经 `textResult()`，可纠正失败经 `errorResult()` 并由兼容 hook 标记 `isError=true`；两者都受全局字符上限约束
- item id 为不透明字符串，模型原样回传；window id 即窗口序号（`w1`、`w2`…），与 bootstrap 身份块、history 标签同源同词
