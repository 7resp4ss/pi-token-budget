/** Run with node --experimental-strip-types scripts/render-tool-prompts.mjs. */
import fs from 'node:fs';
import { TOOL_SPECS, NAMESPACE_DESCRIPTIONS } from '../src/tools/specs.ts';
import { SYSTEM_GUIDANCE, HISTORY_TOOL_MIGRATION_HINT, manualCheckpointMessage, guidanceMessage, reminderMessage, fallbackMessage, bootstrapText, continuationMessage, newContextConfirmation } from '../src/prompts.ts';
const identity={agentName:'/root',firstWindowId:'w1',previousWindowId:null,currentWindowId:'w1',windowNumber:1};
const next={...identity,previousWindowId:'w1',currentWindowId:'w2',windowNumber:2};
const notes=[{path:'checkpoint.md',bytes:256,createdAt:'2026-11-05T00:00:00.000Z',updatedAt:'2026-11-05T01:00:00.000Z'},{path:'decisions.md',bytes:128,createdAt:'2026-11-05T00:00:00.000Z',updatedAt:'2026-11-05T00:00:00.000Z'}];
const sections=[
'# 模型实际收到的工具定义与工作流提示词',
'本文由 `scripts/render-tool-prompts.mjs` 从当前运行时代码生成。工具定义参考的 Codex commit 为 `f3a90545aed3188ee1e5c119ec89a742de399cdc`。11 个函数分别注册；不存在 `notes` / `history` 的 operation 分派。',
'各函数 description 与 Codex 原文一致。平铺函数名替代 namespace；notes_read_file 的 offset_chars/limit_chars 为 Pi 扩展。运行时移除四处 encrypted 标记，notes 正文和字面搜索参数使用普通字符串；冻结参考 fixture 保留原标记。',
'## Namespace 说明',
'Pi 无独立 namespace 声明接口。这两段说明随稳定 workflow 进入 systemPrompt。原始固定容量说明会根据 notesMaxFileBytes 替换数字。',
...Object.entries(NAMESPACE_DESCRIPTIONS).flatMap(([name,description])=>[`### ${name}`,'```text\n'+description+'\n```']),
'## 11 个独立工具',
...Object.entries(TOOL_SPECS).flatMap(([name,spec])=>[
`### ${name}`,
`Codex：\`${spec.codexName}\`。执行模式：\`${spec.executionMode}\`。`,
'```text\n'+spec.description+'\n```',
'```json\n'+JSON.stringify(spec.parameters,null,2)+'\n```',
]),
'## 稳定工作流：systemPrompt',
'Codex 原工作流为 developer 指导。Pi 使用 before_agent_start 的公开 systemPrompt 扩展点；保留已有内容并对本段去重。动态窗口身份及任务数据不写入本段。',
'```text\n'+SYSTEM_GUIDANCE+'\n```',
'## 动态控制文本',
'以下为示例实例，运行时使用真实 agent/window、remaining、条目 ID 和 notes 文件元数据。identity/reminder/fallback/manual-checkpoint/continuation 采用 custom 消息，display=false。bootstrap 为无摘要 compaction 的恢复引导，并列出当前 agent 在换窗时已有的 notes（最近更新优先，最多 25 个文件、整个 notes 索引最多 6000 字符）；不注入笔记正文。过期 source_context_window_id 必须被忽略。',
...[
['首窗口 identity',guidanceMessage(identity)],
['reminder',reminderMessage('w1',6144,['item_1 — user — example request (window w1)'])],
['fallback（保留主动设计的 fence）',fallbackMessage('w1',['item_1 — user — example request (window w1)'])],
['manual checkpoint（用户 /compact）',manualCheckpointMessage('w1',['item_1 — user — example request (window w1)'])],
['旧 aggregate 指导的一次性迁移提示',HISTORY_TOOL_MIGRATION_HINT],
['新窗口 bootstrap',bootstrapText(next,[],[],notes)],
['continuation',continuationMessage(2)],
['new_context 工具回执',newContextConfirmation()],
].flatMap(([name,value])=>[`### ${name}`,'```text\n'+value+'\n```']),
];
fs.writeFileSync(new URL('../docs/tool-prompts.zh-CN.md',import.meta.url),sections.join('\n\n')+'\n');
