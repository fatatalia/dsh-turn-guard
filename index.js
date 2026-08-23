/**
 * dsh-turn-guard — turn 级单步超时插件（防模型退化死循环）
 *
 * 职责：监听 session/event 的 step 边界，若 agent 携带
 *   agent.__pluginConfig.turnGuard.stepMs（各入口插件挂载，见方案 v0.2），
 *   则每步从 step/start 起计时，超过 stepMs 强制 agent.cancel({kind:'hook'})。
 *
 * 设计要点（对应 docs/turn-guard-plan.md v0.2）：
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

export const Config = z.object({});

/** 日志（带前缀与时间戳，console 双写以进 dsh-web.log——其他插件同款姿势）。 */
function makeLogger(ctx) {
  const ts = () => new Date().toISOString();
  return {
    info: (m) => { console.log(`[${ts()}] [tg] ${m}`); try { ctx.logger?.info?.(`[turn-guard] ${m}`); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [tg:warn] ${m}`); try { ctx.logger?.warn?.(`[turn-guard] ${m}`); } catch {} },
    error: (m) => { console.error(`[${ts()}] [tg:err] ${m}`); try { ctx.logger?.error?.(`[turn-guard] ${m}`); } catch {} },
  };
}

export function apply(ctx) {
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

  ctx.on("session/event", (session, event) => {
    // 窄短路：本插件只关心 step 边界；assistant/chunk（每 token 一条）等直接过。
    if (event.type !== "step/start" && event.type !== "step/end" && event.type !== "turn/end") return;

    const sessionId = session?.id;

    if (event.type === "step/start") {
      // 读 agent 上挂的配置（各入口插件挂载 __pluginConfig.turnGuard.stepMs）。
      const agent = agents?.get(sessionId);
      const ms = agent?.__pluginConfig?.turnGuard?.stepMs;
      if (!ms || !Number.isFinite(ms) || ms <= 0) return; // 无配置不干预
      if (timers.has(sessionId)) clearTimer(sessionId); // 防御：理论上同 step 不会重复
      const timer = setTimeout(() => {
        if (!timers.has(sessionId)) return; // 已被 end 清理
        timers.delete(sessionId);
        log.warn(`session ${sessionId}: step 超时 ${ms}ms，cancel 当前 turn`);
        try {
          agent.cancel({ kind: "hook", reason: `step timeout (${ms}ms)` });
        } catch (e) {
          log.error(`session ${sessionId}: cancel 失败 ${e instanceof Error ? e.message : e}`);
        }
      }, ms);
      timers.set(sessionId, timer);
      return;
    }

    // step/end 或 turn/end：清定时器（step/end 在 agent-loop finally 必发；
    // turn/end 兜底，防任何漏网）。
    if (timers.has(sessionId)) clearTimer(sessionId);
  });

  // 插件卸载时清空所有定时器（防 session 残留）。
  ctx.on("dispose", () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  log.info(`已加载（零前缀映射，读 agent.__pluginConfig.turnGuard.stepMs）`);
}
