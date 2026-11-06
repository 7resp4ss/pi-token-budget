# 11 个工具与跨 agent 恢复机制实现

本次实现直接替换原来的 4 个模型函数。现在注册 **11 个独立函数**。`notes`、`history` 作为概念分组保留，不再作为带 `operation` 参数的模型工具。没有保留兼容别名，也没有模型可见的删除工具。

Codex 参考版本：`f3a90545aed3188ee1e5c119ec89a742de399cdc`。工具说明、参数说明、required、nullable、枚举及并行能力冻结在 `src/tests/fixtures/codex-tools.json`。运行时定义位于 `src/tools/specs.ts`。每个工具的完整提示词和 schema 见 [tool-prompts.zh-CN.md](tool-prompts.zh-CN.md)。

## 工具与实现位置

| Pi 函数 | Codex 函数 | 执行模式 | 主要实现 |
|---|---|---|---|
| `history_list_windows` | `history.list_windows` | parallel | `src/tools/history.ts` / `HistoryStore.listWindows` |
| `history_list_items` | `history.list_items` | parallel | `HistoryStore.listItems` |
| `history_read_item` | `history.read_item` | parallel | `HistoryStore.readItem`，原生图片附件 |
| `history_search_contents` | `history.search_contents` | parallel | `HistoryStore.searchContents` |
| `notes_list_files_by_prefix` | `notes.list_files_by_prefix` | parallel | `src/tools/notes.ts` / `NotesStore.listFiles` |
| `notes_read_file` | `notes.read_file` | parallel | `NotesStore.readFile` |
| `notes_search_contents` | `notes.search_contents` | parallel | `NotesStore.searchContents` |
| `notes_append_to_file` | `notes.append_to_file` | sequential | `NotesStore.appendToFile` |
| `notes_write_file` | `notes.write_file` | sequential | `NotesStore.writeFile` |
| `get_context_remaining` | `functions.get_context_remaining` | parallel | `src/tools/get-context-remaining.ts` |
| `new_context` | `functions.new_context` | sequential | `src/tools/new-context.ts` / deferred rollover |

Pi 的普通 `registerTool` 不提供 Codex 的 namespace 声明能力，所以采用平铺名称。每次注册仍携带该函数自己的 schema 和 executionMode。`defineTool` 只复用注册、校验和错误传播，不按 `operation` 分派。每个函数执行前按自己的字段表验证；未知字段和属于其他函数的参数会明确报错。执行错误抛给 Pi，由宿主生成错误结果。

运行时 schema 移除 Codex 的四处 `encrypted: true`：notes_write_file.text、notes_append_to_file.text、notes_search_contents.query 和 history_search_contents.query。notes 正文及字面搜索参数使用普通字符串，不向 provider 请求加密参数。冻结参考 fixture 保留原标记，验收将其列为明确适配差异。Pi 的本地 notes/journal 使用宿主文件权限保护，没有参数解密实现。

## 参数、过滤、排序和分页

History 的 `agent_name` 可省略或传 null，默认当前 agent。绝对地址直接解析，relative 地址拼接在当前 agent 之下。`role` 接受 `user | assistant | tool | system | developer | null`。Pi 的 `toolResult` 归一为 `tool`；custom 消息及 compaction/branch summary 归一为 `user`。普通用户请求索引额外按原始消息角色筛选，避免把控制消息当成用户需求。

`history_list_items` 和 `history_search_contents` 分别支持 window、role、tool_namespace、tool_name。namespace 和 name 必须匹配同一个 callable。assistant 多个 toolCall 中不能拿 A 的 namespace 与 B 的 name 拼成匹配。toolResult 通过 toolCallId 回溯原始调用；无关联 ID 时才使用 toolName。Pi 内置及普通平铺工具归到 `functions`；`notes_*`、`history_*` 映射回对应概念 namespace。

`history_read_item` **同时要求 item_id 和 window_id**。agent、window、item 必须匹配。错误的 window 不会被忽略。list/search 对未知 window 返回空结果；未知或跨任务 agent 返回错误。

History 按当前持久化分支的条目顺序排列；`recent_first` 反转该顺序。list_windows、list_items 默认 limit 50，search 默认 20，最大 limit 200。`max_chars_per_item` 仅属于 list_items，用于限制每条 preview；search 使用 historyItemPreviewChars。list/search 仅描述图片存在，不返回图片数据。

Notes prefix 为字符串前缀，`check` 能匹配 `checkpoint.md`，不要求存在同名目录。省略 prefix/path_prefix 使用当前 agent 的 notes 根。支持 `file_order_by=name|created_at|updated_at`、`file_order=ascending|descending`，默认 name/ascending。搜索的 `recent_file_first=true` 按**创建时间**倒序；覆盖旧文件不会把它变成新文件。文件创建时间单独持久化；更新时间来自文件 mtime。

Notes list 默认最多 100 个，最大 500；search 默认最多 50 个文件、每文件 10 行，最大分别为 500 和 100。字面子串匹配区分大小写。空字符串 write/append 合法。

Notes 行号为 1-based、首尾包含，负数从末尾计数。`notes_read_file` 在 Codex 字段之外保留 `offset_chars` / `limit_chars`，用于读取超长单行。先选行，再按字符分页。history/notes 的字符偏移统一按 Unicode code point 计算，不按 UTF-16 code unit 切断 emoji。容量限制仍按 UTF-8 字节计算。

Read 先为路径和范围头预留空间，再返回完整的实际片段；不会再整体截断一次。返回的 offset/end/totalChars 和 next offset 对应实际返回内容，超出末尾的 offset 收敛到末尾。正常配置下全文输出受 maxToolOutputChars 限制；若将上限配置得小于必要的元数据头，仍保留完整的短范围头和至少一个可读取字符。图片内容不计入文本字符上限。

History list/search 使用 `min(maxToolOutputChars, 6000)` 的索引输出上限。preview 预留 JSON 转义及坐标元数据空间；所有 list/search 按完整行停止输出，省略时说明需要缩小过滤条件。为保持 11 个函数各自的 Codex schema，原 aggregate history 的 `operation/scope/kind/cursor` 参数被替换；不再暴露 snapshot cursor。大量列表应通过 agent/window/role/tool/prefix、limit 与方向缩小范围。

历史文本沿用 main 的 canonical safe text 实现：构造时只索引元数据，读取时按条目缓存渲染；structured thinking 和嵌套 toolResult block 不进入正文。过滤造成的非连续区间不拼接成可跨越匹配的字符串。搜索每项最多返回三个 regions，包含 matches 的 start/end 及可直接传给 history_read_item 的 offset_chars/limit_chars；坐标与直接读取使用同一份 Unicode code-point 正文。bashExecution 的 output 也可恢复。

普通 list/search 先过滤本插件控制消息、bootstrap、notes/history 和两个窗口控制工具的调用与结果，再应用 limit。明确提供 tool_namespace 或 tool_name 时，可以检索对应内部工具记录；已知 ID 仍可直接读取。当前正在执行的 history 调用按 toolCallId 排除，避免搜索自身参数。这个默认策略保留 main 的防递归检索修复，schema 不增加 scope/kind 字段。

### 大量工具输出的干扰边界

每个真实 session entry 是独立历史项。assistant 的工具调用与其顶层 toolResult 分别存放，整个窗口不会合成一段大正文。旧文件读取结果也不会自动注入新窗口的 system 指导。

| 读取方式 | 默认返回范围 | 大量 read/bash 输出的行为 |
|---|---|---|
| history_list_windows | 窗口 ID 与记录数 | 不返回文件正文 |
| history_list_items | 每条 preview 400 字符，整个响应最多 6000 字符 | 大结果只占一条并显示全文字符数；其他工具记录仍会占用列表名额 |
| history_search_contents | 每项合计约 400 字符 preview，最多三个命中区间，整个响应最多 6000 字符 | 返回命中附近的片段及可回读坐标，不直接返回全文 |
| history_read_item | 默认文本预算 12000 字符，先预留地址和分页头 | 明确读到 read/bash 结果时，仍可能返回约 1.2 万字符；可用 limit_chars 缩小 |

这里的限制是输出长度控制，不包含语义相关性排序、相似结果去重或自动优先排列用户需求。普通 read/bash 结果是保留的任务证据，默认不会被过滤。若历史中有很多工具记录，它们仍可能占满一次 list/search 的返回名额；默认按历史顺序排列，recent_first 可以反转方向。

恢复时宜先读 checkpoint，再按 window_id 和 role=user 查找需求，通过关键词搜索定位证据，最后按返回的 offset_chars/limit_chars 读取对应片段。role=assistant 仍可能包含工具调用参数，当前公开 schema 没有只选 assistant 自然语言正文的 kind 参数。需要较长片段时可显式指定 limit_chars=1500 或 2000。历史图片只在显式 history_read_item 时附加，图片数据不受文本字符上限约束。

## 根任务、地址和存储

任务边界是“一次根任务及其注册子 agent”。同 cwd、同 git 仓库或同 worktree 不构成共享依据。普通新会话或 fork 默认创建独立任务；恢复原 session 使用持久 locator 找回 runId 和地址。外部 launcher 传入 TaskContext 时，才显式加入已有根任务。

`src/task-registry.ts` 保存 runId、sessionKey、sessionId、sessionFile、canonical agentName、notesRoot 和 historyDir。sessionKey 优先使用绝对 session 文件路径，无文件时使用 UUID。窗口状态仍按 session 持久化。

```text
<root-session-dir>/pi-token-budget/
  sessions/<session-key-hash>.json       # session -> root task / agent
  tasks/<runId>/
    registry.json                       # 该根任务允许访问的 agent
    child-extension.ts                  # 本项目生成的子扩展入口
    notes/<agent-address-hash>/          # 新注册子 agent 的 notes
    history/<agent-address-hash>/
      entries/<item-id-hash>.json        # 不可变原始条目，保留图片
      branch.json                       # 原子提交的当前分支 ID 列表
  notes/<sessionId>/                     # 保留原根会话/已有 notes 位置
```

已有 notes 目录通过 registry 映射复用，不移动或覆盖。新注册子 agent 的 notes 默认放在根任务目录，即使它的临时 worktree/session 目录被删除，其他 agent 仍能读取。已有 legacy notes 目录继续按原地址保存，由宿主管理其生命周期。

无 session 文件的 SDK 会话使用 `$PI_CODING_AGENT_DIR` / `$PI_AGENT_DIR` 下的专用 memory-session 存储，不把相对路径落在当前 cwd。history journal 因此也能在 memory session 的进程退出后恢复。

根地址为 `/root`。自动子地址为 `/root/agent_<session-key-hash>`。pi-subagents 的所有层级继承同一个根任务入口，所以自动地址为稳定的平铺子地址，不伪造无法从公共接口取得的实际父子拓扑。通用 API 支持显式层级，例如 `/root/reviewer/checker`。地址段只接受小写字母、数字、下划线，不接受空段、`.`、`..` 或保留的子段 `root`。本项目不提供 Codex 的特殊 `/morpheus` 地址。

相对 notes 路径属于当前 agent；跨 agent 路径必须是 `/root/.../notes/<path>`。只解析 registry 中登记的 agent。正常阶段，读、list、search、write、append 都允许访问同一任务内其他 agent 的 notes。`get_context_remaining` 返回当前 agent 和登记地址，便于模型发现可访问对象。

## 并发写入与历史持久化

`src/storage.ts` 提供跨进程文件锁和原子 rename。对同一个 notes 文件，容量检查、读取旧内容、追加或覆盖、metadata 更新和提交都在同一个锁内。成功后的读立即看到提交内容。写入临时文件放在模型不可见的 metadata 目录，防止 list/search 看到未提交文件。锁等待有上限，死进程锁可回收。

`HistoryJournal` 只为新 ID 写入记录，然后原子提交 branch manifest。同步点包括 session_start、context、message_end、agent_settled、换窗准备和 shutdown。Pi 在 message_end 扩展回调之后才持久化当前消息，因此该回调可能只能同步上一条；下一次 context/settled 会补齐。这是跨 agent history 的最终一致性边界。

当前 agent 的工具从活分支构建 `HistoryStore`。跨 agent 工具只读 journal，不使用可能修复或追加 session 文件的 SessionManager reader。每条原始记录含图像块；`history_read_item` 将合法的原生 `ImageContent` 附加到 tool result。文本模型得到明确的图片数量与能力说明。

journal 的记录文件保留旧条目，manifest 描述当前已提交分支。它不等于一个自动合并所有分支的全局会话库。窗口状态在旧分支导航时的完整迁移仍沿用项目既有限制。

## checkpoint fence 与换窗

保留用户主动设计的 fence：fallback 或手动 checkpoint 请求真正进入分支后，所有工具都先被拦截。写入前，`new_context`、`get_context_remaining`、history 和 notes 只读工具同样被阻止。只有一次 `notes_write_file` 或 `notes_append_to_file` 可以通过，而且目标必须是当前 agent 自己的 notes。

写入失败释放 claim，允许纠正后重试。schema/宿主层执行错误也通过 tool_result 释放未成功 claim。成功写入后自动请求 rollover，并返回 terminate=true。其他 agent 的 notes 写入不能解除该 fence。继续保留 continuation ownership 协议。

用户手动 `/compact` 不受剩余预算阈值限制。Pi 准备出可压缩历史后，`session_before_compact` 返回 Promise，等待 `manual-checkpoint` 控制回合结束。请求包含 requestId、windowId、phase（awaiting/saved/compacting）和有无已排队提示的状态。模型保存一次自己的 checkpoint，工具 batch 结束并触发 `agent_settled` 后，原生压缩的同一次调用使用最新分支构建新窗口，不需要再调用 new_context，也不再通过“首次取消、再次压缩”实现正常流程。

重复命令在首次提示投递前合并。Esc 通过 compaction 的 AbortSignal 联动取消 checkpoint 模型回合，等待其 settled 后才退出；context 回调清除失效或重复控制消息。checkpoint 已保存但 compaction 失败时，下一次显式 `/compact` 可复用该 checkpoint；普通用户消息使它失效并重新开放工具。继续消息只恢复未完成工作；没有剩余任务时等待用户。手动 checkpoint 等待期间拒绝嵌套的 threshold/overflow compaction，并忽略这些被拒绝尝试的失败事件，防止它们重置成功笔记或提前替换上下文。其他时刻真实 overflow 仍使用紧急直接换窗。正常手动换窗没有中间取消错误；用户主动取消或 checkpoint 未保存时仍取消原生压缩，保留当前窗口。过短会话可能在扩展 hook 前就被判定不可压缩。

主动 `new_context` 幂等设置 pendingNewContext，并返回 terminate=true。真正 rollover 在 eligible settled 边界执行；Pi 自动 compaction 也可先消费请求。只有用户取消手动压缩时，才用公开的 ctx.abort 联动取消其 checkpoint 回合；正常流程不打断请求。没有改 Pi 私有状态，也没有修改 provider payload。

Pi agent-core 只有在**当前工具 batch 的所有 finalized results 都 terminate=true** 时才提前结束该 batch。混合普通工具时不能保证停止；steer/follow-up 队列也可能继续触发采样。已用真实 agent-core 离线测试固定这四种情况。插件层实现因此不能承诺与 Codex 相同的“下一次采样前必定换窗”。

提示词要求先保存 checkpoint 和 window/item anchors，再调用 new_context。回执不再建议调用之后补 notes。当前实现保留 Pi 的 reminder/hard-trigger/fence 策略，不重建 Codex 的 total/body_after_prefix + buffer 预算引擎。预算查询分别说明全窗口剩余和 hard trigger 剩余。

## 提示词角色与 ID 注入

Codex 参考实现的 workflow guidance 进入 **developer** 指导，不是 system。本项目仅使用 Pi 的公开扩展接口，在 `before_agent_start` 返回链式 systemPrompt，保存前面扩展的内容，并用 `<pi_token_budget_guidance>` 标记去重。

进入 system 的是稳定工作流、两个 namespace 的原始说明、11 个工具的名字映射、fence 和恢复规则。动态的 agent/window identity、reminder、fallback、manual-checkpoint、continuation 继续使用受这些规则约束的 custom 消息，display=false。当前窗口身份在每次 context 回调刷新，避免同一个 run 内自动换窗后 systemPrompt 中出现过期 window ID。新 Pi 的前导 system/developer 消息顺序得到保留。

增量笔记的工作流恢复为直接指令 `Take incremental notes while you work so you do not miss important info.`。它要求工作时持续记录，不再使用 `It is a good idea...` 的建议式措辞。这是提示词要求；当前没有新增每次最终回复之前强制写 notes 的完成检查。

每次生成新窗口 bootstrap 时，从当前 agent 的 NotesStore 读取真实文件元数据，按更新时间倒序追加 `Existing notes for <agent> at this context-window reset` 索引。每行 JSON 包含可直接传给 notes_read_file 的完整虚拟路径、bytes 和 updated_at；不读取或注入笔记正文，不将目录快照放进 system。子 agent 只列自己的 notes，其他 agent 的笔记仍通过显式路径访问。

notes 索引最多 25 个文件、整个索引最多 6000 个 Unicode code point，按完整 JSON 行停止，超出时报告省略数量并指向 notes_list_files_by_prefix。路径中的引号和换行使用 JSON 转义，回读时可保持原样。空目录明确报告没有文件；读取目录失败时报告索引不可用并提示工具发现，仍允许换窗。它是换窗时的快照，后续更改可通过列表工具刷新。手动 /compact、主动 new_context 和紧急 overflow 都走同一个 bootstrap 生成入口。

`projectItemIds` 只在模型上下文副本中，为可恢复的非 assistant 消息添加真实 `[id: ...]`。它使用原始分支记录匹配，不生成虚构 ID，不改用户原文、图片、toolCallId 或持久化内容。检查点索引也提供相应 window。notes/history 内容始终作为恢复数据，不能升级为 system 指令。

## pi-subagents 的非侵入式接入

`src/subagents-adapter.ts` 从 `pi.getAllTools().sourceInfo.path` 发现 pi-subagents 所属 package，读取其导出的 `./required-child-extensions`。也支持 `PI_TOKEN_BUDGET_SUBAGENTS_MODULE` 或 factory 的 `subagents.modulePath` 指定公共模块/包目录。运行时代码不写死 OI 工作区路径。

adapter 用 `ctx.sessionManager.getSessionId()` 提供的运行时 session ID，调用公共 `registerRequiredChildExtensions`，注册根任务目录中的 child-extension.ts。pi-subagents 的启动与公共 preflight 都按该运行时 ID 查询，不能改用 session 文件路径。TaskRegistry 的 `sessionKey` 仍优先采用文件路径，供持久存储和自动地址生成使用；这两种身份用途不同。入口只导入本项目，并显式携带该根任务的 TaskContext。foreground SDK 和 detached runner 都可加载它，后代继续继承根入口。不通过同进程全局环境变量传递每个孩子的身份。

重复 ambient/generated 加载通过 session-local event bus 同步握手，共享同一套工具和状态机；晚加载的任务入口可在 session_start 前补入 TaskContext。已有其他 required-extension owner 时，adapter 不替换、不 dispose，发出可定位诊断，供 owner 合并所需入口或改用通用 factory。

adapter 不修改 tools whitelist，不绕过 denyExtensions，也不强迫非原生 runner 加载本地模块。缺工具时给出诊断。对实际 pi-subagents 完整调度器的每一种 runner/deny-policy 组合，本次不宣称全部端到端覆盖；验证包括公共注册 API、公共启动 preflight 按运行时 ID 查到 requiredExtensionIds，以及真实 Pi SDK 的前台/独立进程入口加载。公共 preflight 有意省略 required extension 的实际路径，入口加载由 SDK 测试另外验证。

## 通用 launcher API

```ts
import { createTokenBudgetExtension, getTokenBudgetTask } from "pi-token-budget/api";

// 在父会话 session_start 之后取得共享任务。
const parent = getTokenBudgetTask(parentPi)!;

// 传给子会话自己的 resource loader。
const factory = createTokenBudgetExtension({
  task: {
    ...parent.context,
    parentAgentName: parent.agentName,
    agentName: "reviewer", // 可省略，按 session identity 自动产生稳定名字
  },
});

// extensionFactories: [{ name: "token-budget", factory }]
```

API 是显式注册通道。未携带已有 context 的新 session 继续隔离。此处的代码由外部 launcher 使用；本项目不修改 pi-subagents。

## 验证入口

`npm run typecheck && npm test` 包括原有 smoke、换窗 integration、coordination、agent-core contract，以及 recovery、sdk-context、subagents-contract。

- integration/smoke：手动压缩取消/重试/新输入失效、精确命中坐标、安全投影、来源关联、完整行输出边界、旧 aggregate 指导迁移。
- recovery：11 项定义逐项比对、任务隔离/共享、地址、过滤/排序、Unicode 分页完整重建、图片、fence、跨进程追加和 byte cap。
- sdk-context：真实 SDK 的手动 checkpoint 自动换窗链路、provider context、system 指导、真实 user/tool result ID、原文不变、换窗、memory session、跨工作目录、独立进程图片恢复、重复加载、白名单。
- subagents-contract：发现公共模块、文件路径与运行时 ID 不同时的公共启动 preflight 查询、继承入口生成、dispose 清理、注册冲突和外部 owner 保留；可指定安装的 OI/upstream 模块重复验证。
- agent-core contract：仅 terminating 工具、混合 batch、steer、follow-up 的实际采样次数。

新验收结果见 [implementation-acceptance.zh-CN.md](implementation-acceptance.zh-CN.md)。2.0.0 发布时清理了旧四工具版本的 fidelity-review/evidence/probes。
