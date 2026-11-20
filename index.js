/**
 * dsh-turn-guard — turn 级守卫插件（单步超时）
 *
 * 职责：监听 session/event 的 step 边界，若 agent 携带
 *   agent.__pluginConfig.turnGuard.stepSec（各入口插件挂载，配置单位：秒），
 *   则每步从 step/start 起计时，超过 stepSec 强制 agent.cancel({kind:'hook'})。
 *
 * 【2026-11-15 移除空回复重试】
 *   原职责二是「turn/end 时本轮没有非空可见正文就 followup 重试」。它解决的问题是真的
 *   （模型退化时会只思考不说话，turn 以 reason.kind="completed" 正常结束，用户看到没反应），
 *   但归属放错了：本插件是通用守卫，不知道消息要投到哪、发不发得出去。
 *
 *   实测暴露的缺口（2026-11-15 16:33）——重试确实产出了 1979 字正文，用户却一个字没收到：
 *     imessage._deliver → await whenIdle() → turn/end 一响立即返回 → streamPoller 清掉 → 收工
 *     （300ms 后）turn-guard.setTimeout → followup → 新 turn 跑起来，但已经没有任何监听者
 *
 *   根因是「重试」本该由投递方负责：只有单向通道（iMessage）才需要兜底，
 *   Web 空回复是能直接被看见的。现在重试逻辑已移交 dsh-imessage 的 _deliver 内部循环。
 *
 * 设计要点：
 *   - 零前缀映射：不感知会话类型，只读 agent 上挂的配置；无配置不干预（等同 web）。
 *   - 窄短路：session/event 里高频事件是 assistant/chunk（每 token 一条），
 *     handler 只处理 step/start / step/end / turn/end，其余立即 return。
 *   - 定时器成对：step/start 起、step/end 清（step/end 在 agent-loop 的 finally 里
 *     必发，完成/失败/取消都会到）；turn/end 兜底再清一次（双保险零成本）。
 *   - dispose 清空 Map：防 session 残留。
 *   - 事件订阅姿势与官方 agent-instructions 同款（ctx.on("session/event")，
 *     回调签名 (session, event)）。
 */
import z from "@deepseek-ai/schemastery";

export const name = "dsh-turn-guard";

/** 只需 agents（session 事件由 sessions 服务发布，事件本身经 ctx 广播）。 */
export const inject = ["agents"];

export const Config = z.object({
  /** 保留空对象：插件仍可在此处接受未来配置，但当前无独立开关。 */
});

/** 日志（带前缀与时间戳，console 双写以进 dsh-web.log——其他插件同款姿势）。 */
function makeLogger(ctx) {
  const ts = () => new Date().toISOString();
  return {
    info: (m) => { console.log(`[${ts()}] [tg] ${m}`); try { ctx.logger?.info?.(`[turn-guard] ${m}`); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [tg:warn] ${m}`); try { ctx.logger?.warn?.(`[turn-guard] ${m}`); } catch {} },
    error: (m) => { console.error(`[${ts()}] [tg:err] ${m}`); try { ctx.logger?.error?.(`[turn-guard] ${m}`); } catch {} },
  };
}

export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const agents = ctx.agents;

  /** sessionId → 当前 step 的超时定时器（仅对有配置的会话建立）。 */
  const timers = new Map();

  const clearTimer = (sessionId) => {
    const t = timers.get(sessionId);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(sessionId);
    }
  };

  /** 该会话是否受本插件管（只认入口插件挂的 stepSec > 0）。 */
  const guardSec = (agent) => {
    const sec = agent?.__pluginConfig?.turnGuard?.stepSec;
    return Number.isFinite(sec) && sec > 0 ? sec : 0;
  };

  ctx.on("session/event", (session, event) => {
    const sessionId = session?.id;
    if (!sessionId) return;

    // 窄短路：本插件只关心 step 边界与 turn 边界。assistant/chunk 每 token 一条，必须先挡掉。
    if (event.type !== "step/start" && event.type !== "step/end" && event.type !== "turn/end") return;

    const agent = agents?.get(sessionId);
    const sec = guardSec(agent);

    if (event.type === "step/start") {
      if (sec <= 0) return; // 无配置不干预
      if (timers.has(sessionId)) clearTimer(sessionId); // 防御：理论上同 step 不会重复
      const timeoutMs = sec * 1000;
      const timer = setTimeout(() => {
        if (!timers.has(sessionId)) return; // 已被 end 清理
        timers.delete(sessionId);
        log.warn(`session ${sessionId}: step 超时 ${sec}s，cancel 当前 turn`);
        try {
          agent.cancel({ kind: "hook", reason: `step timeout (${sec}s)` });
        } catch (e) {
          log.error(`session ${sessionId}: cancel 失败 ${e instanceof Error ? e.message : e}`);
        }
      }, timeoutMs);
      timers.set(sessionId, timer);
      return;
    }

    // step/end 或 turn/end：清定时器（step/end 在 agent-loop finally 必发；
    // turn/end 兜底，防任何漏网）。
    clearTimer(sessionId);
  });

  // 插件卸载时清空所有定时器（防 session 残留）。
  ctx.on("dispose", () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  log.info("已加载（单步超时；stepSec 读 agent.__pluginConfig.turnGuard.stepSec；空回复重试已移交 dsh-imessage）");
}
