# 实现验收记录

验收日期：2026-11-06。本报告针对 2.0.2 的 11 工具实现，包含明文参数和手动压缩修复。发布内容已移除旧四工具版本的 fidelity-review/evidence/probes。

结论：11 个独立函数及计划中的共享恢复能力已落盘。所有函数 description、原始参数定义和 executionMode 与冻结参考逐项比较通过。Pi 平铺命名、notes 字符分页、system 指导和 deliberate checkpoint fence 为明确保留的适配，不将此结果解读为整个 Codex token-budget 后端 100% 复刻。

当前实现保留精确有界历史恢复和手动压缩前 checkpoint，并提供 11 个独立函数、跨 agent journal 和原生历史图片。为匹配 Codex schema，原 aggregate 的 scope/kind/snapshot cursor 接口不继续暴露；历史偏移统一采用 Unicode code point。

## 环境与结果

本地 Node 为 `v24.16.0`。固定依赖保持 `0.84.4`，没有为兼容测试改动目标项目的依赖版本或 lockfile。最新版测试在 `/tmp` 的隔离副本安装依赖执行。

| 环境 | 验证 | 结果 |
|---|---|---|
| Pi agent-core / coding-agent `0.84.4` | typecheck + 全部 8 个 npm 测试入口 | 通过 |
| Pi agent-core / coding-agent / pi-ai `1.5.0` | typecheck + 同一组 8 个入口 | 通过 |
| pi-subagents 兼容分支 `0.76.1` 源码公共 API | required-child-extensions 注册与公开 preflight 按运行时 ID 查询 | 通过 |
| 上游 npm pi-subagents `0.84.0`，Pi `1.5.0` 隔离环境 | 已安装公共 API 的同一注册与 preflight 合约 | 通过 |
| npm package self export | `pi-token-budget/api` 可导入 factory/query | 通过 |
| diff 格式 | `git diff --check` | 通过 |

`npm test` 的八个入口是 smoke、integration、contract、coordination、coordination-integration、recovery、sdk-context、subagents-contract。额外的兼容分支与上游运行通过 `PI_TOKEN_BUDGET_TEST_SUBAGENTS_MODULE` 导入对应公共模块。

## pi-subagents 接入复核修正

复核发现，adapter 原先将持久存储用的 sessionKey 传给公共注册 API。对于文件会话，该值是 session 文件路径，但兼容分支和上游启动器都按 Pi 运行时 session ID 查询。原有合约也沿用了文件 key，验证了注册成功和冲突处理，却没有覆盖真实启动查询；memory-session SDK 测试没有不同的文件 key，因此也未暴露这一问题。

现在 adapter 改为传入 task.agent.sessionId。新的 subagents-contract 明确使用不同的运行时 ID 与 session 文件路径，调用 pi-subagents 包导出的公共 preflight，确认按运行时 ID 能得到 pi-token-budget 的 requiredExtensionIds，文件路径不被误当作别名，dispose 后启动要求消失。新增回归在修复前的 fixture 与兼容分支公共 API 上都失败，修复后在 fixture、兼容分支和上游安装模块上均通过。公共 preflight 有意隐藏 required extension 路径；实际入口加载继续由 sdk-context 单独验证。

## 增量笔记与新窗口 notes 发现

system 工作流使用直接指令 `Take incremental notes while you work so you do not miss important info.`。每次新窗口 bootstrap 另行列出当前 agent 在换窗时已有的 notes：完整虚拟路径、字节大小、更新时间，最近更新优先。最多 25 个文件、整个 notes 索引最多 6000 字符，完整行停止并提示如何查找省略项。空目录和目录读取失败分别说明；读取失败不阻塞换窗。笔记正文保持按需读取，文件元数据不进入 system。

integration 验证真实目录中的新旧 notes 排序、引号/换行路径的 JSON 完整性、将返回路径原样传给 notes_read_file、数量/字符上限、空目录与目录读取错误。sdk-context 验证手动 checkpoint 自动换窗后，真实 provider context 收到实际存在的 `/root/notes/checkpoint`（没有假设 `.md` 文件名），并通过该路径成功恢复 checkpoint 正文。该测试同时确认正文不进入 bootstrap，文件索引不进入 system。这里验证的是提示词投递和恢复路径；不宣称已强制每次最终回复前记笔记，也不以离线 fake stream 代表真实模型遵从率。

## 工具定义

冻结参考 commit：`f3a90545aed3188ee1e5c119ec89a742de399cdc`。

- 注册数：11。未注册旧的 notes/history aggregate，也未注册 delete。
- description：11/11 与原文一致。
- 字段、description、required、nullable 和枚举：11/11 在明确适配后对比通过。比较时去掉 notes_read_file 两个 Pi 扩展字段，以及冻结参考中的四处 encrypted 标记；其他定义逐项一致。
- 并行标记：8 parallel、3 sequential，11/11 一致。
- 参数执行验证：缺必填参数、类型错误、错误枚举、非法数字、未知字段和不属于当前函数的字段返回宿主工具错误；空 text 的 write/append 可用。

加密标记修复：运行时移除两个 notes 写入 text 和两个字面搜索 query 的 encrypted 标记。recovery 对实际注册的全部 schema 检查不存在 encrypted 字段，sdk-context 对实际传给 provider 的 11 个工具重复验证。工作流提示词和 checkpoint fence 不作调整；已有不可读文件不会因此自动恢复。离线测试验证请求定义，不代表已完成受影响 provider 的在线对照测试。

## 功能证据

`src/tests/recovery.ts` 验证：同根任务的父、子、兄弟、显式后代共享；同目录无关任务隔离；resume 保留任务身份；跨 agent notes 可读写；相对 agent 地址和非法地址；已有 notes 目录复用；新孩子的数据在临时目录移除后仍可访问。

同一套测试验证了字符串前缀、创建/更新时间排序、覆盖旧文件不改变创建顺序、独立 window/role/tool 过滤、namespace 与 name 的成对匹配、错误 window 不会被忽略、未知窗口返回空结果、未知 agent 报错。

分页验证使用含 emoji、非 BMP 字符和汉字的长单行，循环读取 notes/history 的所有页面，按返回 end 拼接并与原文逐字符比较。另测负行号、UTF-8 byte cap。四个独立进程合计 160 次 append 没有丢失或重复；并发写入仍遵守容量上限；死进程遗留锁可回收。

图片验证覆盖 user 和 toolResult 图像，跨窗口与跨 agent 回读，独立进程退出后的 journal 恢复，以及 text-only model 能力说明。

Fence 验证覆盖所有非写入工具的拦截、别的 agent notes 不能满足 checkpoint、超限写入失败后重试、本 agent 成功写入请求 rollover、后续再次写入被挡，以及既有 continuation coordination 回归。

`src/tests/smoke.ts` 和 integration 继承并适配了 main 的 canonical 文本、安全投影、最多三个命中区间、source 关联、排除自身调用和 6000 字符完整行打包回归。emoji 搜索坐标可原样回读；thinking/嵌套结果不进入检索。旧 aggregate 指导仅注入一次非持久迁移提示。

手动 `/compact` 的回归覆盖：同一次原生压缩等待 checkpoint settled、重复请求合并、own-agent 单次写入、嵌套自动压缩竞态、写入失败保留窗口及 fence、显式重试、Esc、保存后取消、失败后复用、正常新输入使 checkpoint 失效，以及独立 overflow 紧急路径。成功后继续未完成工作；无剩余任务时等待用户。

## 真实 SDK 与主动换窗边界

`src/tests/sdk-context.ts` 直接验证了手动 compact 等待模型保存自己的 checkpoint，并在同一次原生压缩切换到 w2，无需 new_context。断言只有一对 compaction_start/compaction_end，且没有 session_compact_failed 事件。测试的 keepRecentTokens 为 32，避免原先极小的 1 导致 Pi 在工具结果结尾找不到 cut point；Pi 的 compaction preparation 仍是扩展执行前置条件。测试在真实 Pi SDK 中使用离线 fake stream，直接捕获 provider context。确认稳定指导进入 system，前导 system 的位置得到保留，真实 user/tool-result ID 可见，用户原始记录保持不变，任务内容未进入 systemPrompt，换窗后窗口身份更新。新窗口不再携带旧原始会话；受控 user-request index 按设计保留引用。

同一测试在另一个 cwd 创建前台 SDK child，加载生成的 required 入口与 ambient 扩展；最终仍为一套 11 个工具。独立 Node 进程用相同入口启动 memory session，写入含图像的历史记录后退出，父 session 通过实际 history_read_item 工具执行取回原生图像。工具白名单没有被扩展。

## 手动压缩误报修复（2.0.2）

在真实 Pi 1.5.0 TUI 中，用 tmux、隔离会话和离线 provider 复现：手动输入 `/compact` 后先出现 `Error: Compaction cancelled`，随后保存一次 checkpoint 并成功换到 w2。根因是原实现返回 cancel=true 安排 checkpoint，再次调用压缩；Pi 将第一次取消按错误显示。

修复仅使用扩展公开接口：异步等待 checkpoint 的 agent_settled，使用最新分支返回 compaction，让同一次原生手动压缩完成。没有修改 Pi/OI 或 pi-subagents，也没有拦截终端输入或隐藏错误消息。checkpoint 写入失败或用户主动取消时仍保留当前窗口。

| 实际终端场景 | 结果 |
|---|---|
| 修复前正常 `/compact` | 1 次 checkpoint，1 次成功换窗，出现中间取消错误 |
| 修复后正常 `/compact` | 1 次 checkpoint，1 次成功换窗，没有取消错误或失败事件 |
| checkpoint 回合中按 Esc，随后继续输入 | 取消模型回合和换窗，0 次成功换窗，后续对话正常完成 |

固定 Pi 0.84.4 和隔离 Pi 1.5.0 均通过类型检查及全部 8 套测试。终端测试未调用在线模型。用户主动按 Esc 时 Pi 仍按自身行为显示取消信息；模型不遵守保存指令时也不承诺换窗成功。

agent-core contract 的采样次数：

| 情况 | 采样次数 | 含义 |
|---|---:|---|
| 只有 terminating new_context | 1 | 可在下次模型采样前结束 batch |
| new_context 与普通工具混合 | 2 | terminate 不构成全 batch 停止 |
| terminating batch 后有 steer | 2 | 队列可继续采样 |
| terminating batch 后有 follow-up | 2 | 队列可继续采样 |

因此，插件不能保证 Codex 相同的下一次采样前换窗时机。保留 settled/自动 compaction 执行点，不在流中 abort。

## 验证范围

本次验证不调用在线模型，不依赖真实 API key。pi-subagents 验证包含真实公共 API 合约和真实 SDK child 入口加载，不覆盖完整调度器的每一种 runner、denyExtensions、远程机器和 agent 策略组合。能力策略继续由 pi-subagents/Pi 宿主执行。

历史输出额外做了离线实测：一个含 1,110,012 字符 read 结果、两条用户消息和一条 assistant 消息的窗口，list_windows 只返回 4 条记录的计数；list_items 完整响应为 1,119 字符，其文件 preview 为 400 字符；搜索唯一命中词时完整响应为 739 字符，并返回可回读的 400 字符区间与 read 来源。未提供 limit_chars 的 read_item 返回 11,839 字符（正文 11,753 字符）；role=user 列表只返回两条用户消息。此实测验证有界输出，不代表已实现相关性排序、工具证据去重或自动对话正文优先。默认值保持不变。

预算引擎沿用 Pi 的 reminder/hard-trigger/fence；不包含 Codex total/body_after_prefix + buffer 的底层预算算法。Codex 工作流原角色为 developer，本项目通过 Pi 公共 systemPrompt 扩展点实现稳定指导。历史分支导航的完整窗口状态迁移仍为既有限制。

运行时及文档均在 pi-token-budget 项目内实现。没有修改 Pi 核心或 pi-subagents 源码。源码摘要和测试环境元数据见 [implementation-acceptance.json](implementation-acceptance.json)。
