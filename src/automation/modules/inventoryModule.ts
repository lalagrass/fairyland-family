import type { PluginCommand, PluginMessage } from '../../protocol';
import type { AutomationHostContext, BehaviorModule } from '../types';
import type { InventoryPolicy } from '../strategyStore';
import type { FamilyState } from '../../state';

export function inventoryAction(st: FamilyState, cfg: InventoryPolicy) {
  const c = st.character;
  if (!c || c.inBattle || st.battle || st.battleResult || st.dialog || st.shop || c.activeWork) return null;
  const supplies = [
    { item: cfg.hpItem, threshold: cfg.hpThreshold, value: c.hp, max: c.maxHp },
    { item: cfg.staminaItem, threshold: cfg.staminaThreshold, value: c.satiety, max: c.maxSatiety },
  ];
  for (const { item, threshold, value, max } of supplies) {
    const owned = st.inventory.find(it => it.itemId === item && it.count > 0);
    if (owned && value != null && max != null && max > 0 && value * 100 < max * threshold) {
      return {
        signature: ['use', item, value, max, threshold].join('/'),
        command: { type: 'GAME_COMMAND', command: { type: 'USE_ITEM', itemId: item } } satisfies PluginCommand,
        label: `自動補給：${owned.name ?? item}`,
      };
    }
  }
  if (!st.warehouse) return null;
  const room = st.warehouse.cap - st.warehouse.items.reduce((sum, it) => sum + it.count, 0);
  if (room <= 0) return null;
  const deposit = st.inventory.find(it => it.count > 0 && cfg.deposit.includes(it.itemId)
    && !cfg.keep.includes(it.itemId) && !supplies.some(rule => rule.item === it.itemId));
  if (!deposit) return null;
  return {
    signature: ['deposit', deposit.itemId, deposit.count, room].join('/'),
    command: { type: 'WAREHOUSE_DEPOSIT', itemId: deposit.itemId, count: Math.min(deposit.count, room) } satisfies PluginCommand,
    label: `自動存倉：${deposit.name ?? deposit.itemId}`,
  };
}

/** Consume only host-confirmed snapshots. Repeated heartbeats or unchanged rejected requests never dispatch twice. */
export class InventoryModule implements BehaviorModule {
  readonly id = 'inventory-policy';
  readonly label = '背包自動補給與存倉';
  readonly category = 'RESTING' as const;
  readonly priority = 35;
  private last = new Map<string, string>();
  private pending = new Map<string, string>();
  private session: string | null = null;
  private lastPoll = -Infinity;

  isActive() { return this.pending.size > 0; }
  getSummary() { return this.label; }
  onMessage(msg: PluginMessage, ctx: AutomationHostContext) {
    const st = ctx.state();
    if (st.sessionId !== this.session) {
      this.last.clear();
      this.pending.clear();
      this.session = st.sessionId;
      this.lastPoll = -Infinity;
    }
    const cid = msg.characterId;
    if (msg.kind === 'command-result' && msg.status === 'REJECTED' && this.pending.get(cid) === msg.commandId) {
      this.pending.delete(cid);
    }
    if (msg.kind === 'event' && msg.event.type === 'COMMAND_COMPLETED' && this.pending.get(cid) === msg.event.commandId) {
      this.pending.delete(cid);
      if (ctx.status() === 'RUNNING' && st.characterId === cid) ctx.send({ type: 'REQUEST_SNAPSHOT' }, '更新背包策略狀態', undefined, cid);
    }
    if (msg.kind === 'heartbeat' && cid === st.characterId && st.snapshot && ctx.status() === 'RUNNING') {
      const cfg = ctx.getStrategyConfig(cid).inventoryPolicy;
      const enabled = cfg && (cfg.deposit.length || (cfg.hpItem != null && cfg.hpThreshold)
        || (cfg.staminaItem != null && cfg.staminaThreshold));
      // Map HP and satiety have no independent change events. Poll only while a rule is enabled.
      if (enabled && ctx.now() - Math.max(this.lastPoll, st.snapshotAt ?? 0) >= 5000) {
        this.lastPoll = ctx.now();
        ctx.send({ type: 'REQUEST_SNAPSHOT' }, '檢查背包策略', undefined, cid);
      }
    }
    if (msg.kind !== 'snapshot' || cid !== st.characterId || ctx.status() !== 'RUNNING') return;
    const pending = this.pending.get(cid);
    if (pending && (st.pending[pending] || st.inflight[pending])) return;
    this.pending.delete(cid);
    const cfg = ctx.getStrategyConfig(cid).inventoryPolicy;
    const next = cfg && inventoryAction(st, cfg);
    if (!next) { this.last.delete(cid); return; }
    if (next.signature === this.last.get(cid)) return;
    this.last.set(cid, next.signature);
    const id = ctx.send(next.command, next.label, 'DONE', cid);
    if (id) this.pending.set(cid, id);
    else this.last.delete(cid);
  }
}
