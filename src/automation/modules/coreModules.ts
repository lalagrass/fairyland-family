import type { AutoBattler } from '../../battler';
import type { AutoNavigator } from '../../navigator';
import type { UiAction } from '../../parse';
import type { WorkQueue } from '../../queue';
import type { AutomationHostContext, BehaviorModule } from '../types';

export function createNavigationModule(nav: AutoNavigator): BehaviorModule {
  return {
    id: 'navigation',
    label: '跨圖尋路',
    priority: 10,
    category: 'NAVIGATING',
    isActive: () => nav.getStatus().phase !== 'IDLE' && nav.getStatus().phase !== 'DONE',
    getSummary: () => nav.getStatus().text,
    handleAction(action: UiAction) {
      if (action.kind === 'NAV') return { handled: true, error: nav.go(action.goal) };
      if (action.kind === 'NAV_CANCEL') {
        nav.cancel();
        return { handled: true, error: null };
      }
      return { handled: false, error: null };
    },
    stop: () => nav.cancel(),
  };
}

export function createBattleModule(battler: AutoBattler): BehaviorModule {
  return {
    id: 'battle',
    label: '自動戰鬥',
    priority: 5,
    category: 'COMBAT',
    isActive: ctx => Boolean(ctx.state().battle),
    getSummary: () => `戰鬥策略：${battler.getStrategy()}`,
    handleAction(action: UiAction, ctx: AutomationHostContext) {
      if (action.kind !== 'STRATEGY') return { handled: false, error: null };
      battler.setStrategy(action.strategy);
      const cid = ctx.state().characterId;
      ctx.onChange();
      void cid;
      return { handled: true, error: null };
    },
    onMessage(msg, ctx) {
      // 若單角策略設定了低血撤退百分比，在戰鬥就緒時檢查是否應切換逃跑策略
      if (msg.kind !== 'event' || msg.event.type !== 'BATTLE_TURN_READY') return;
      const cfg = ctx.getStrategyConfig(msg.characterId);
      if (cfg.lowHpRetreatPct <= 0) return;
      const p = msg.event.player;
      if (!p || p.maxHp <= 0) return;
      const hpPct = (p.hp / p.maxHp) * 100;
      if (hpPct <= cfg.lowHpRetreatPct && battler.getStrategy() !== 'FLEE') {
        battler.setStrategy('FLEE');
        ctx.log(`血量 ${Math.round(hpPct)}% ≤ 門檻 ${cfg.lowHpRetreatPct}%，自動切換為逃跑策略`, 'warn');
      }
    },
  };
}

export function createWorkQueueModule(getQueueFor: (charId?: string | null) => WorkQueue): BehaviorModule {
  return {
    id: 'work-queue',
    label: '自動採集與製造',
    priority: 20,
    category: 'WORKING',
    isActive: ctx => {
      const q = getQueueFor(ctx.state().characterId).getStatus();
      return ['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(q.phase);
    },
    getSummary: ctx => getQueueFor(ctx.state().characterId).getStatus().text,
    handleAction(action: UiAction, ctx: AutomationHostContext) {
      if (action.kind === 'QUEUE_GATHER') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.enqueue({
          kind: 'GATHER',
          skillId: action.skillId,
          skillName: action.skillName,
          ...(action.targetItemId !== undefined ? { targetItemId: action.targetItemId } : {}),
          targetName: action.targetName,
          targetCount: action.count,
          ...(action.requiredToolItemId !== undefined ? { requiredToolItemId: action.requiredToolItemId } : {}),
          ...(action.requiredToolName ? { requiredToolName: action.requiredToolName } : {}),
        });
        return { handled: true, error: null };
      }
      if (action.kind === 'QUEUE_CRAFT') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.enqueue({
          kind: 'CRAFT',
          recipeId: action.recipeId,
          recipeName: action.recipeName,
          targetCount: action.count,
        });
        return { handled: true, error: null };
      }
      if (action.kind === 'QUEUE_STOP') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.stop('USER_STOPPED');
        return { handled: true, error: null };
      }
      if (action.kind === 'QUEUE_REMOVE') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.removeJob(action.index);
        return { handled: true, error: null };
      }
      if (action.kind === 'QUEUE_REORDER') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.reorderJob(action.fromIndex, action.toIndex);
        return { handled: true, error: null };
      }
      if (action.kind === 'QUEUE_STOP_CONDITIONS') {
        const target = getQueueFor(action.targetCharacterId ?? ctx.state().characterId);
        target.setStopConditions(action.patch);
        return { handled: true, error: null };
      }
      return { handled: false, error: null };
    },
  };
}
