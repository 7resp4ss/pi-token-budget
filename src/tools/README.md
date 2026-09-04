# Model-Facing Tools

四个模型专属工具（`ToolExposure::DirectModelOnly` 等价物：只出现在模型工具列表，用户/MCP 不可调用），每个工具一个文件，通过 `deps.ts` 的 `ToolDeps` 接口与编排层解耦。

## 总览

| 工具 | 文件 | 角色 | 通道 |
|---|---|---|---|
| `get_context_remaining` | [get-context-remaining.ts](./get-context-remaining.ts) | 预算仪表盘：实时剩余 token + 窗口身份 | 拉式（模型主动查） |
| `new_context` | [new-context.ts](./new-context.ts) | 换窗声明：无参数意图声明，turn 边界执行 | 推式（延迟消费） |
| `notes` | [notes.ts](./notes.ts) | 持久检查点：跨窗口存活的虚拟文件系统 | 写入通道（信息延续主通道） |
| `history` | [history.ts](./history.ts) | 冷存储寻址：旧窗口条目只读随机访问 | 恢复通道（按 item id 精读） |

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

## notes

多操作工具，包装 [stores/notes-store.ts](../stores/notes-store.ts)：

| 操作 | 参数 | 说明 |
|---|---|---|
| `write` | `path`, `text` | 创建/整文件替换 |
| `append` | `path`, `text` | 追加（检查点累积）；撞顶报错含剩余配额与可清理文件提示 |
| `read` | `path`, `start_line?`, `stop_line?`, `offset_chars?`, `limit_chars?` | 全文、行区间（负数=从尾部数）或字符窗口（与 history `read_item` 对齐，可越过超长单行）；limit 钉到输出上限，头部位置永远诚实 |
| `search` | `query`, `prefix?`, `max_files?`, `max_matches_per_file?` | 字面量子串 |
| `list` | `prefix?`, `max_results?` | 路径前缀列表；超派生阈值时附加膨胀软警告行 |

约束（store 层强制）：虚拟路径不可逃逸、单文件 ≤1MB、读立即可见写。

## history

多操作只读工具，包装 [stores/history-store.ts](../stores/history-store.ts)：

| 操作 | 参数 | 返回 |
|---|---|---|
| `list_windows` | — | `(window_id, item_count)` 元数据，**零内容** |
| `list_items` | `window_id?`, `role?`, `limit?`, `recent_first?` | 截断预览条目 |
| `read_item` | `item_id`†, `offset_chars?`, `limit_chars?` | **字符级分页**读取单条 |
| `search_contents` | `query`†, `window_id?`, `role?`, `limit?` | 匹配条目 + 定位预览 |

† 必填。

**防爆炸保证**：参数级分页（字符 offset/limit、条数 limit）+ 输出统一截断（`maxToolOutputChars`）——任何操作都无法返回无界内容。

## 共享约定

- 所有工具描述末尾附 `TOOL_PRIVATE_USAGE_HINT`（私有簿记，不对用户泄露）
- 所有输出经 `textResult()` 截断
- item id 为不透明字符串，模型原样回传；window id 即窗口序号（`w1`、`w2`…），与 bootstrap 身份块、history 标签同源同词
