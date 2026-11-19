import { isCommandResultMessage, isEventMessage, type BattleEnemyState, type PluginCommand, type PluginMessage } from './protocol/index';
import type { FamilyState } from './state';

/** 自動戰鬥策略：手動＝外掛什麼都不做（預設），由人在面板或文字輸入操作。 */
export type BattleStrategy = 'MANUAL' | 'ATTACK' | 'FLEE';
export const STRATEGIES: ReadonlyArray<{ id: BattleStrategy; label: string }> = [
  { id: 'MANUAL', label: '手動' }, { id: 'ATTACK', label: '普通攻擊' }, { id: 'FLEE', label: '逃跑' },
];
export const strategyLabel = (s: BattleStrategy) => STRATEGIES.find(x => x.id === s)?.label ?? s;

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY = 'family.strategy.v1';

export interface BattlerHost {
  state(): FamilyState;
  send(command: PluginCommand, label: string, expect?: string): string | null;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  after(ms: number, fn: () => void): unknown;
  onChange(): void;
}

const RETRY_MS = 400;
const MAX_RETRY = 6;

/** 主人血量低於比例時先用恢復道具。捕捉再附加封印條件。 */
interface HealFields {
  healBelowHpRatio?: number;
  healItemId?: number;
}

export interface CaptureTurnOverride extends HealFields {
  mode: 'CAPTURE';
  sealStoneId: number;
  captureBelowHpRatio: number;
}

export interface HealTurnOverride extends HealFields {
  mode: 'HEAL';
  healItemId: number;
  healBelowHpRatio: number;
}

export type TurnOverride = CaptureTurnOverride | HealTurnOverride;

/**
 * 外掛端自動戰鬥：只在 BATTLE_TURN_READY 才出手，每個（場次，回合）最多送一次；
 * 預設「手動」＝完全不動。非手動策略在戰鬥結束後也會把勝敗視窗關掉（RETURN_TO_MAP／DEFEAT_RESCUE），
 * 否則宿主畫面會停在結算視窗。
 */
export class AutoBattler {
  private strategy: BattleStrategy = 'MANUAL';
  private turnOverride: TurnOverride | null = null;
  private done = new Set<string>();
  private mine = new Map<string, { kind: 'TURN' | 'RESULT'; key: string; battleId: number; round: number; tries: number; outcome?: 'WIN' | 'LOSE' }>();

  constructor(private host: BattlerHost, private storage: KvStorage | null = null) {
    try {
      const v = storage?.getItem(KEY);
      if (v === 'ATTACK' || v === 'FLEE' || v === 'MANUAL') this.strategy = v;
    } catch { /* 沿用預設 */ }
  }

  getStrategy(): BattleStrategy { return this.strategy; }

  setTurnOverride(override: TurnOverride | null): void {
    this.turnOverride = override;
  }

  setStrategy(s: BattleStrategy): void {
    this.strategy = s;
    try { this.storage?.setItem(KEY, s); } catch { /* 不影響功能 */ }
    this.host.log(`戰鬥策略：${strategyLabel(s)}`);
    this.host.onChange();
    // 切到自動時，若此刻正好輪到我方，立刻出手。
    const b = this.host.state().battle;
    if (s !== 'MANUAL' && b?.ready && b.round !== null) this.turn(b.battleId, b.round);
  }

  onMessage(m: PluginMessage): void {
    if (isEventMessage(m)) {
      const e = m.event;
      if (e.type === 'BATTLE_TURN_READY') this.turn(e.battleId, e.round);
      else if (e.type === 'BATTLE_ENDED' && this.strategy !== 'MANUAL' && (e.outcome === 'WIN' || e.outcome === 'LOSE')) {
        this.host.after(500, () => this.result(e.battleId, e.outcome as 'WIN' | 'LOSE', 0));
      }
      return;
    }
    if (isCommandResultMessage(m) && m.status === 'REJECTED') {
      const t = this.mine.get(m.commandId);
      if (!t) return;
      this.mine.delete(m.commandId);
      const retryable = m.reasonCode === 'BATTLE_NOT_READY' || m.reasonCode === 'GAME_BUSY' || m.reasonCode === 'GAME_NOT_READY';
      if (retryable && t.tries < MAX_RETRY) {
        this.done.delete(t.key);
        this.host.after(RETRY_MS, () => (t.kind === 'TURN' ? this.turn(t.battleId, t.round, t.tries + 1) : this.result(t.battleId, t.outcome!, t.tries + 1)));
      } else if (t.kind === 'TURN') {
        this.host.log(`自動戰鬥：被拒絕 ${m.reasonCode ?? ''}，放棄這一回合（改手動處理）`, 'warn');
      }
    }
  }

  private turn(battleId: number, round: number, tries = 0): void {
    if (this.strategy === 'MANUAL') return;
    const key = `T${battleId}:${round}`;
    if (this.done.has(key)) return;
    const b = this.host.state().battle;
    if (!b || b.battleId !== battleId) return;
    this.done.add(key);
    let cmd: PluginCommand;
    let label: string;
    let expect: string | undefined;
    const override = this.turnOverride;
    const capture = override?.mode === 'CAPTURE' ? override : null;
    const target = this.pickTarget(b.enemyStates, capture !== null);
    const hpRatio = target && target.maxHp > 0 ? target.hp / target.maxHp : 1;
    const self = b.player;
    const selfRatio = self && self.maxHp > 0 ? self.hp / self.maxHp : 1;
    const hurt = override?.healBelowHpRatio !== undefined && selfRatio <= override.healBelowHpRatio;
    if (override?.healItemId !== undefined && hurt) {
      cmd = { type: 'BATTLE_ACTION', battleId, action: { kind: 'ITEM', itemId: override.healItemId } };
      label = `自動戰鬥：使用恢復道具（第 ${round} 回合）`;
      expect = 'TURN_SUBMITTED';
    } else if (this.strategy === 'FLEE') {
      cmd = { type: 'BATTLE_FLEE', battleId }; label = `自動戰鬥：逃跑（第 ${round} 回合）`; expect = 'FLED';
    } else if (capture && target && (hpRatio <= capture.captureBelowHpRatio || hurt)) {
      cmd = {
        type: 'BATTLE_ACTION',
        battleId,
        action: { kind: 'CAPTURE', targetSlot: target.slot, sealStoneId: capture.sealStoneId },
      };
      label = `自動戰鬥：捕捉 ${target.name}（第 ${round} 回合）`;
      expect = 'TURN_SUBMITTED';
    } else {
      cmd = { type: 'BATTLE_ACTION', battleId, action: { kind: 'ATTACK', ...(target ? { targetSlot: target.slot } : {}) } };
      label = `自動戰鬥：攻擊${target ? ` ${target.name}` : ''}（第 ${round} 回合）`; expect = 'TURN_SUBMITTED';
    }
    const id = this.host.send(cmd, label, expect);
    if (id) this.mine.set(id, { kind: 'TURN', key, battleId, round, tries });
    else this.done.delete(key);
  }

  /** 捕捉時打最接近可收服的那隻；一般攻擊仍打清單上的第一隻。 */
  private pickTarget(enemies: readonly BattleEnemyState[], weakest: boolean): BattleEnemyState | undefined {
    const list = enemies;
    const living = list.filter(e => !e.isDead && e.hp > 0);
    const pool = living.length > 0 ? living : list;
    if (!weakest) return pool[0];
    return [...pool].sort((a, b) => {
      const ra = a.maxHp > 0 ? a.hp / a.maxHp : 1;
      const rb = b.maxHp > 0 ? b.hp / b.maxHp : 1;
      if (ra !== rb) return ra - rb;
      if (a.maxHp !== b.maxHp) return a.maxHp - b.maxHp;
      return a.slot - b.slot;
    })[0];
  }

  private result(battleId: number, outcome: 'WIN' | 'LOSE', tries: number): void {
    if (this.strategy === 'MANUAL') return;
    const key = `R${battleId}`;
    if (this.done.has(key)) return;
    this.done.add(key);
    const optionId = outcome === 'WIN' ? 'RETURN_TO_MAP' : 'DEFEAT_RESCUE';
    const id = this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId }, `自動戰鬥：關閉${outcome === 'WIN' ? '勝利' : '敗北'}視窗`, 'DONE');
    if (id) this.mine.set(id, { kind: 'RESULT', key, battleId, round: 0, tries, outcome });
    else this.done.delete(key);
  }
}
