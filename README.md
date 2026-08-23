# dsh-turn-guard — turn 级单步超时插件（防模型退化死循环）

dsh 的 **turn 级单步超时插件**：对 agent 会话的每一步（step）施加超时控制——当某一步运行超过配置时限，强制中断（`agent.cancel`），防止模型退化导致的无意义死循环。

## 背景与动机

dsh 的 turn（一次对话）由 `agent-loop` 的 `while(true)` 驱动，**没有总时长/最大步数上限**（设计上支持长编码任务）。模型退化时（陷入循环、持续生成无意义内容），turn 无限运行，无兜底。

真实事故：webhook 处理退款短信时，模型（deepseek-v4-flash:0731）陷入调查循环 → 推理退化输出 "nope" 无限重复 → 无任何兜底，用户手动中断。

本插件目标：**防止模型退化导致的无意义死循环**——每一步（step）若超过配置时限即强制中断，正常处理不受影响。

## 设计原则

- **插件化**：不改 dsh 本体，全部通过插件扩展（dsh 事件机制 + `agent.cancel` 公开方法）
- **无配置 = 不干预**：某会话没配超时，等同 web 会话行为（模型自主跑，可手动停）
- **解耦**：turn-guard 不感知会话类型（无前缀映射）；各入口插件负责把自己的超时配置挂到 agent，turn-guard 只读 agent 上的配置
- **可扩展**：未来新会话类型/新守卫（步数上限、循环检测）零 turn-guard 改动

## 架构总览

```
┌─ 各入口插件（imessage / webhook / heartbeat / dreaming）─────────────┐
│  settings 段加 stepTimeoutSec（设置页可编辑，单位：秒）               │
│  创建/恢复 agent 后：                                                 │
│    agent.__pluginConfig.turnGuard = { stepSec: <自己的值> }           │
└──────────────────────────────────────────────────────────────────────┘
                           ↓（agent 挂配置）
┌─ dsh-turn-guard 插件（零映射）────────────────────────────────────────┐
│  ctx.on("session/event") 监听 step/start、step/end、turn/end          │
│  agents.get(session.id) → 读 agent.__pluginConfig?.turnGuard?.stepSec │
│    ├── 有值 → step/start 起定时器（stepSec × 1000 ms），               │
│    │        step/end 清；超时 agent.cancel({kind:'hook'})             │
│    └── 无值 → 不干预（等同 web）                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## 配置项（单位：秒）

| 插件 | settings 段 | 默认 |
|---|---|---|
| imessage | `imessage.stepTimeoutSec` | 0（不限制） |
| webhook | `webhook.hooks.<id>.stepTimeoutSec`（每个 hook 独立） | 0（不限制） |
| heartbeat | `heartbeat.stepTimeoutSec` | 0（不限制） |
| dreaming | `dreaming.stepTimeoutSec` | 0（不限制） |

`0` / 未配置 = 不限制（等同 web 会话行为）。设置页（Settings → 各插件）均有「单步超时（秒）」输入框，`getConfig` 自动回填当前值，保存即热生效（无需重启）。

## 工作机制

### agent 通用扩展容器 `__pluginConfig`
- **作用**：agent 上的插件共享扩展配置（不止 turn-guard 用，未来插件都用）
- **结构**：按插件名分区 `{ turnGuard: { stepSec }, loopGuard: {...}, xxx: {...} }`
- **挂载方式**：`Object.defineProperty(agent, "__pluginConfig", { enumerable: false, writable: true, configurable: true })`——不可枚举，避免被遍历/序列化干扰
- **生命周期**：纯内存属性，**不持久化**。resume 恢复的 agent 是新对象——各入口插件在 create + resume + 复用所有路径统一挂载（幂等）
- **会话独立**：每个 agent 绑定唯一 session，多会话并发互不影响

### 单步超时逻辑
```js
// session/event 里识别 step 边界（窄短路：assistant/chunk 等高频事件直接 return）
if (event.type === "step/start") {
  const agent = agents.get(session.id);
  const sec = agent?.__pluginConfig?.turnGuard?.stepSec;
  if (!sec) return; // 无配置不干预
  timers.set(session.id, setTimeout(() => {
    agent.cancel({ kind: "hook", reason: `step timeout (${sec}s)` });
  }, sec * 1000)); // 底层 setTimeout 需要毫秒，这里转换
} else if (event.type === "step/end" || event.type === "turn/end") {
  clearTimeout(timers.get(session.id));
}
```

### cancel 语义
- `agent.cancel({kind:"hook", reason})` 是 `AgentCancelCause` 的合法值，**中止整个 turn**（abort signal → `turnEnds={kind:"aborted"}` → `turn/end` 落盘）
- 默认清 inbox（`keepInbox: false`）：模型已退化时 pending 消息留着只会继续跑
- `step/end` 在 agent-loop 的 `finally` 里必发（完成/失败/取消/max-tokens 都到）——**定时器必然被清理，无泄漏**

## 行为矩阵

| 会话类型 | 配置 | 行为 |
|---|---|---|
| gateway-*（imessage） | 有（如 300s） | 每步超 300 秒打断 |
| webhook-* | 有（每 hook 可配） | 同上 |
| heartbeat-* | 无（默认） | 不限制 |
| dreaming-* | 有（如 600s） | 每步超 600 秒打断 |
| session-*（web） | 永远不管 | 不限制（交互式） |

## 结构

```
dsh-turn-guard/
├── index.js              # host 插件：session/event 监听 + 定时器 + agent.cancel
├── cordis.patch.yml      # 插入 host 插件行
└── package.json          # dsh.bundle
```

纯 host 插件（无 client/设置页——配置入口在各入口插件的设置页）。

## 依赖 dsh 服务（host）

`agents`（通过 `agents.get(session.id)` 取 agent 读配置；`session/event` 事件由 sessions 服务经 ctx 广播）

## 技术核实（源码依据）

- `step/start`/`step/end` 事件真实存在且必然成对（`dsh-agent-loop` `turn()` 里 `step/end` 在 `finally` 发出，完成/失败/取消/max-tokens 都到）
- `agent.cancel({kind:"hook", reason})` 是 `AgentCancelCause` 合法值，中止整个 turn（abort signal → `turnEnds={kind:"aborted"}` → `turn/end` 落盘）
- `ctx.on("session/event", (session, event) => ...)` 订阅姿势与官方 `dsh-agent-instructions` 同款
- 事件频率不是问题：step 粒度 = 一次 LLM 请求 + 工具执行（秒级），set/clearTimeout 微秒级；真正火线是 `assistant/chunk`（每 token 一条），handler 窄短路只处理 step/start/step/end/turn/end

## 安装

主实例 profile 挂载（dependencies + bundles 两处）：
```bash
dsh plugin --profile web add /Users/fatatalia/project/dsh-turn-guard
```
或手动加 `package.json` 的 `dependencies`（`"dsh-turn-guard": "link:..."`）+ `dsh.profile.bundles`。

## 验证

- **正常路径不误伤**：正常任务快速完成，定时器设置/清除无副作用
- **超时路径**：临时把某会话 `stepTimeoutSec` 设小（如 3），发一条需要长时间推理的指令，确认：
  - 会话日志 `turn/end reason={"kind":"aborted","reason":{"kind":"hook","reason":"step timeout (3s)"}}`
  - `step/end` 在 finally 正常发出（定时器无泄漏）
  - agent 回 idle

## 已知局限与未来扩展

- **单步超时只防"单步卡死/持续输出"**（如模型在一步内无限生成）——防不住**多步快速循环**（每一步都快速完成）
- 未来扩展（同插件零改动）：
  - **步数上限**：`__pluginConfig.turnGuard.maxSteps`，`step/start` 计数超限 cancel（防多步无限循环）
  - **循环特征检测**：相同工具调用重复 N 次 → cancel（更精准）

## 相关

- 方案文档（设计稿 + 实现状态）：`docs/turn-guard-plan.md`（在代码东工作区）
- 前置修复（入口层兜底）：dsh-webhook deliver 工具调用轮次上限（15 轮）
- 事故记录：webhook 模型循环事故（2026-08-21）
