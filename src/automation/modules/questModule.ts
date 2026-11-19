import {
  isCommandResultMessage,
  isEventMessage,
  isSnapshotMessage,
  type PluginMessage,
} from '../../protocol/index';
import type { AutoBattler } from '../../battler';
import type { AutoNavigator, NavGoal } from '../../navigator';
import type { UiAction } from '../../parse';
import type { WorkQueue } from '../../queue';
import { pickQuestGatherPoint, planUnmetObjective } from '../questPlan';
import type { AutomationHostContext, BehaviorModule } from '../types';

export interface QuestRunnerHost extends AutomationHostContext {
  navigator: AutoNavigator;
  battler: AutoBattler;
  getQueueFor: (characterId: string | null) => WorkQueue;
  knownNpcNames?: () => string[];
  knownMaps?: () => Array<{ mapId: string; name: string }>;
}

/**
 * 任務自動推進模組（從 FamilyController 抽離的獨立狀態機行為模組）。
 */
export class QuestBehaviorModule implements BehaviorModule {
  readonly id = 'quest';
  readonly label = '自動任務';
  readonly priority = 30;
  readonly category = 'QUESTING' as const;

  private activeQuestId: number | null = null;
  private questPatrolCommandId: string | null = null;
  private questPatrolIdx = 0;
  private questCooldownUntil = 0;
  private questSnapshotPending = false;
  private lastQuestStatus: string | null = null;
  private advancingQuest = false;
  private lastStopReason: string | null = null;
  private issuedNav = false;
  /** 這次採集對應的目標進度。快照更新後若數量沒增加，就停下，避免改採到別的材料還一直重排。 */
  private gatherWatch: { questId: number; description: string; current: number; awaitingSnapshot: boolean; sawSnapshot: boolean } | null = null;

  constructor(private host: QuestRunnerHost) {}

  getActiveQuestId(): number | null {
    return this.activeQuestId;
  }

  getLastStopReason(): string | null {
    return this.lastStopReason;
  }

  /** 正在走路、等待對話、採集或冷卻時，任務鏈不要把它當成卡住。 */
  isBusy(): boolean {
    if (this.activeQuestId === null) return false;
    if (this.questPatrolCommandId) return true;
    if (this.host.navigator.isActive()) return true;
    if (this.host.now() < this.questCooldownUntil) return true;
    const st = this.host.state();
    if (st.battle || st.dialog || st.shop) return true;
    const phase = this.host.getQueueFor(st.characterId).getStatus().phase;
    return ['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(phase);
  }

  isActive(): boolean {
    return this.activeQuestId !== null;
  }

  getSummary(): string {
    return this.activeQuestId !== null ? `任務自動推進中 (#${this.activeQuestId})` : '自動任務：閒置';
  }

  stop(reasonLog?: string): void {
    if (reasonLog) this.lastStopReason = reasonLog;
    if (this.activeQuestId === null) return;
    this.activeQuestId = null;
    this.questPatrolCommandId = null;
    this.questSnapshotPending = false;
    this.gatherWatch = null;
    if (reasonLog) {
      this.host.log(reasonLog);
      this.host.onChange();
    }
  }

  handleAction(action: UiAction): { handled: boolean; error: string | null } {
    if (action.kind === 'QUEST_AUTO') {
      return { handled: true, error: this.start(action.questId) };
    }
    if (action.kind === 'QUEST_AUTO_STOP') {
      this.stop('玩家取消任務自動推進');
      return { handled: true, error: null };
    }
    return { handled: false, error: null };
  }

  onPreMessage(msg: PluginMessage): void {
    if (isEventMessage(msg)) {
      if (msg.event.type === 'COMMAND_COMPLETED' && msg.event.code === 'DIALOG_OPENED' && !this.host.state().dialog) {
        this.questCooldownUntil = Math.max(this.questCooldownUntil, this.host.now() + 800);
      } else if (msg.event.type === 'DIALOG_OPENED' || msg.event.type === 'DIALOG_UPDATED') {
        this.questCooldownUntil = 0;
      }
      if (msg.event.type === 'COMMAND_COMPLETED' && msg.event.commandId === this.questPatrolCommandId) {
        this.questPatrolCommandId = null;
      }
    }
    if (isCommandResultMessage(msg) && msg.commandId === this.questPatrolCommandId && msg.status === 'REJECTED') {
      this.questPatrolCommandId = null;
    }
    if (msg.kind === 'snapshot') {
      this.questSnapshotPending = false;
      if (this.gatherWatch?.awaitingSnapshot) this.gatherWatch.sawSnapshot = true;
    }
  }

  onMessage(msg: PluginMessage): void {
    if (this.activeQuestId !== null && (isSnapshotMessage(msg) || isEventMessage(msg) || isCommandResultMessage(msg))) {
      this.advance();
    }
  }

  onNavigatorDone(): void {
    if (this.activeQuestId !== null) this.advance();
  }

  start(questId: number): string | null {
    const snap = this.host.state().snapshot;
    const quest = snap?.quests?.find(q => q.questId === questId);
    if (!quest) return '尚未收到任務資料';
    if (quest.status === 'COMPLETED') {
      this.stop();
      this.host.log(`任務【${quest.title}】已完成`);
      this.host.onChange();
      return null;
    }
    this.activeQuestId = questId;
    this.questPatrolCommandId = null;
    this.questPatrolIdx = 0;
    this.questCooldownUntil = 0;
    this.questSnapshotPending = false;
    this.lastQuestStatus = null;
    this.lastStopReason = null;
    this.issuedNav = false;
    this.gatherWatch = null;
    this.host.log(`任務自動推進開始：【${quest.title}】`);
    const err = this.advance();
    this.host.onChange();
    return err;
  }

  advance(): string | null {
    if (this.advancingQuest || this.activeQuestId === null || this.host.status() !== 'RUNNING') {
      return null;
    }
    this.advancingQuest = true;
    try {
      return this.step();
    } finally {
      this.advancingQuest = false;
    }
  }

  private step(): string | null {
    if (this.activeQuestId === null || this.host.status() !== 'RUNNING') return null;
    const questId = this.activeQuestId;
    const st = this.host.state();
    const snap = st.snapshot;
    const quest = snap?.quests?.find(q => q.questId === questId);
    if (!snap || !quest) return null;
    if (st.location && snap.mapId !== st.location.mapId) return null;

    if (quest.status === 'COMPLETED') {
      this.activeQuestId = null;
      this.questPatrolCommandId = null;
      this.host.log(`任務【${quest.title}】已完成`);
      this.host.onChange();
      return null;
    }

    if (st.battleResult === 'DEFEAT') {
      this.stop(`任務【${quest.title}】自動推進中止：戰鬥落敗`);
      return null;
    }
    if (st.battle) {
      const hasCombat = quest.objectives.some(
        o => !o.met && (o.type === 'KILL_MONSTERS' || o.type === 'CAPTURE_PETS' || o.type === 'DEFEAT_BOSS'),
      );
      if (hasCombat && this.host.battler.getStrategy() === 'MANUAL') {
        this.host.battler.setStrategy('ATTACK');
      }
      return null;
    }
    if (st.battleResult === 'VICTORY') {
      if (this.host.battler.getStrategy() === 'MANUAL') {
        this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'RETURN_TO_MAP' }, '關閉勝利視窗');
      }
      return null;
    }

    if (this.host.navigator.isActive()) return null;
    if (this.issuedNav && this.host.navigator.getStatus().phase === 'FAILED') {
      const why = this.host.navigator.getStatus().text;
      this.issuedNav = false;
      this.stop(`任務【${quest.title}】${why}`);
      return why;
    }
    if (
      this.questPatrolCommandId &&
      (st.pending[this.questPatrolCommandId] || st.inflight[this.questPatrolCommandId])
    ) {
      return null;
    }

    const activeQ = this.host.getQueueFor(st.characterId);
    const qStat = activeQ.getStatus();
    if (['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(qStat.phase)) {
      return null;
    }
    if (
      quest.status === 'IN_PROGRESS' &&
      qStat.phase === 'STOPPED' &&
      qStat.stopReason &&
      qStat.stopReason !== 'USER_STOPPED' &&
      qStat.stopReason !== 'DONE_TARGET'
    ) {
      this.stop(`任務【${quest.title}】自動推進中止：工作停止（${qStat.stopReason}）`);
      return null;
    }
    if (this.gatherWatch && this.gatherWatch.questId === questId && (qStat.phase === 'DONE' || qStat.phase === 'STOPPED')) {
      const watched = quest.objectives.find(o => o.description === this.gatherWatch?.description);
      if (!watched || watched.met || watched.current > this.gatherWatch.current) {
        this.gatherWatch = null;
      } else if (!this.gatherWatch.awaitingSnapshot) {
        this.gatherWatch = { ...this.gatherWatch, awaitingSnapshot: true, sawSnapshot: false };
        this.questSnapshotPending = true;
        this.host.send({ type: 'REQUEST_SNAPSHOT' }, '確認採集是否讓任務進度增加');
        return null;
      } else if (!this.gatherWatch.sawSnapshot) {
        return null;
      } else {
        const why = `任務【${quest.title}】找不到下一步：採集沒有讓「${watched.description}」增加（${watched.current}/${watched.required}）`;
        this.stop(why);
        return why;
      }
    }

    const now = this.host.now();
    if (this.lastQuestStatus !== quest.status) {
      this.lastQuestStatus = quest.status;
      this.questCooldownUntil = 0;
    }
    if (now < this.questCooldownUntil) return null;

    const dialog = st.dialog;
    const dialogMatchesNpc =
      !!dialog && (dialog.npcId === quest.npcId || dialog.npcName === quest.npcName);

    if (quest.status === 'AVAILABLE') {
      if (dialogMatchesNpc && dialog) {
        const demoOpt = dialog.options.find(o => o.id === 'ENABLE_DEMO_MODE');
        if (demoOpt) {
          this.questCooldownUntil = now + 700;
          this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: demoOpt.id }, '切換示範任務模式');
          return null;
        }
        const acceptOpt = dialog.options.find(o => o.id === `ACCEPT_QUEST:${questId}`);
        if (acceptOpt) {
          this.questCooldownUntil = now + 700;
          this.host.send(
            { type: 'CHOOSE_DIALOG_OPTION', optionId: acceptOpt.id },
            `接取任務：${quest.title}`,
          );
          return null;
        }
        this.questCooldownUntil = now + 700;
        this.host.send({ type: 'ACCEPT_QUEST', questId }, `接受任務 #${questId}`);
        return null;
      }
      if (dialog) {
        const closeOpt =
          dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ??
          dialog.options[dialog.options.length - 1];
        if (closeOpt) {
          this.questCooldownUntil = now + 400;
          this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話');
          return null;
        }
      }
      return this.goNav({ kind: 'NPC', query: quest.npcName, talk: true });
    }

    if (quest.status === 'READY') {
      if (dialogMatchesNpc && dialog) {
        const completeOpt = dialog.options.find(o => o.id === `COMPLETE_QUEST:${questId}`);
        if (completeOpt) {
          this.questCooldownUntil = now + 700;
          this.host.send(
            { type: 'CHOOSE_DIALOG_OPTION', optionId: completeOpt.id },
            `回報任務：${quest.title}`,
          );
          return null;
        }
        const demoOpt = dialog.options.find(o => o.id === 'ENABLE_DEMO_MODE');
        if (demoOpt) {
          this.questCooldownUntil = now + 700;
          this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: demoOpt.id }, '切換示範任務模式');
          return null;
        }
        this.stop('對話選項未含回報入口，請於主畫面確認前置步驟');
        return '對話選項未含回報入口，請於主畫面確認前置步驟';
      }
      if (dialog) {
        const closeOpt =
          dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ??
          dialog.options[dialog.options.length - 1];
        if (closeOpt) {
          this.questCooldownUntil = now + 400;
          this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話');
          return null;
        }
      }
      return this.goNav({ kind: 'NPC', query: quest.npcName, talk: true });
    }

    if (dialog) {
      const closeOpt =
        dialog.options.find(o => o.id === 'CLOSE' || o.id === 'BYE') ??
        dialog.options[dialog.options.length - 1];
      if (closeOpt) {
        this.questCooldownUntil = now + 400;
        this.host.send({ type: 'CHOOSE_DIALOG_OPTION', optionId: closeOpt.id }, '關閉對話繼續推進任務');
        return null;
      }
    }

    const unmet = quest.objectives.filter(o => !o.met);
    if (unmet.length === 0) {
      if (!this.questSnapshotPending) {
        this.questSnapshotPending = true;
        this.questCooldownUntil = now + 600;
        this.host.send({ type: 'REQUEST_SNAPSHOT' }, '更新任務狀態');
      }
      return null;
    }

    const nextObj = unmet[0];
    const snapPoints = [...(snap.gatherPoints.points ?? []), ...(snap.nearbyGatherPoints ?? [])];
    const plan = planUnmetObjective(nextObj, {
      npcNames: this.npcNames(snap.npcs.map(n => n.name)),
      maps: this.knownMaps(snap),
      gatherPoints: snapPoints,
      recipes: (this.host.state().staticData?.recipes ?? snap.recipes ?? []).map(r => ({
        recipeId: r.recipeId,
        name: r.name,
      })),
    });
    if (plan.kind === 'STUCK') {
      this.stop(`任務【${quest.title}】找不到下一步：${plan.reason}`);
      return plan.reason;
    }
    if (plan.kind === 'TALK') {
      this.questCooldownUntil = now + 400;
      return this.goNav({ kind: 'NPC', query: plan.npcName, talk: true });
    }
    if (plan.kind === 'VISIT') {
      this.questCooldownUntil = now + 400;
      return this.goNav({ kind: 'MAP', mapId: plan.mapId, name: plan.mapName });
    }
    if (plan.kind === 'CRAFT') {
      const needed = Math.max(1, nextObj.required - nextObj.current);
      activeQ.enqueue({
        kind: 'CRAFT',
        recipeId: plan.recipeId,
        recipeName: plan.recipeName,
        targetCount: needed,
      });
      return null;
    }

    if (plan.kind === 'GATHER') {
      const points = [...(snap.gatherPoints.points ?? []), ...(snap.nearbyGatherPoints ?? [])];
      const picked = pickQuestGatherPoint(nextObj.description, points);
      if (!picked) {
        const here = st.location?.mapId ?? snap.mapId;
        const hint = (nextObj.targetMaps ?? []).find(h => h.mapId && h.mapId !== here);
        if (hint) {
          this.questCooldownUntil = now + 400;
          return this.goNav({ kind: 'MAP', mapId: hint.mapId, name: hint.mapName ?? hint.mapId });
        }
        this.stop(`任務【${quest.title}】找不到下一步：宿主採集清單對不上「${nextObj.description}」`);
        return '宿主採集清單對不上目標';
      }
      const matchPoint = picked.point;
      if (matchPoint.skillId == null) {
        this.stop(`任務【${quest.title}】找不到下一步：採集點沒有技能編號（${nextObj.description}）`);
        return '採集點沒有技能編號';
      }
      const needed = Math.max(1, nextObj.required - nextObj.current);
      this.questSnapshotPending = false;
      this.gatherWatch = {
        questId,
        description: nextObj.description,
        current: nextObj.current,
        awaitingSnapshot: false,
        sawSnapshot: false,
      };
      activeQ.enqueue({
        kind: 'GATHER',
        skillId: matchPoint.skillId,
        skillName: matchPoint.skillName ?? '採集',
        ...(picked.itemId !== undefined ? { targetItemId: picked.itemId } : {}),
        targetName: picked.materialName,
        targetCount: needed,
        ...(matchPoint.requiredToolItemId ? { requiredToolItemId: matchPoint.requiredToolItemId } : {}),
        ...(matchPoint.requiredToolName ? { requiredToolName: matchPoint.requiredToolName } : {}),
      });
      return null;
    }

    const combatObj = unmet.find(
      o => o.type === 'KILL_MONSTERS' || o.type === 'CAPTURE_PETS' || o.type === 'DEFEAT_BOSS',
    );
    if (combatObj) {
      const hints = combatObj.targetMaps ?? [];
      if (hints.length === 0) {
        this.stop(`任務【${quest.title}】目標未提供目標地圖資訊（targetMaps）`);
        return '任務目標未提供目標地圖資訊';
      }
      const curMapId = st.location?.mapId ?? snap.mapId;
      const localHint = hints.find(h => h.mapId === curMapId);
      if (!localHint) {
        const hopOf = (id: string) => snap.nav.reachableMaps.find(r => r.mapId === id)?.hops ?? 999;
        const target = [...hints].sort((a, b) => hopOf(a.mapId) - hopOf(b.mapId))[0];
        return this.goNav({ kind: 'MAP', mapId: target.mapId, name: target.mapName ?? target.mapId });
      }
      if (this.host.battler.getStrategy() === 'MANUAL') {
        this.host.battler.setStrategy('ATTACK');
      }
      const pos = st.character ?? { x: snap.character.x, y: snap.character.y };
      const hx = localHint.x ?? pos.x;
      const hy = localHint.y ?? pos.y;
      const distToCenter = Math.hypot(pos.x - hx, pos.y - hy);
      const offsets: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [96, 0],
        [-96, 0],
        [0, 96],
        [0, -96],
        [64, 64],
        [-64, -64],
      ];
      let tx = hx;
      let ty = hy;
      if (distToCenter <= 160) {
        for (let tries = 0; tries < offsets.length; tries += 1) {
          const [dx, dy] = offsets[(this.questPatrolIdx + tries) % offsets.length];
          const cx = hx + dx;
          const cy = hy + dy;
          if (Math.hypot(pos.x - cx, pos.y - cy) >= 32) {
            tx = cx;
            ty = cy;
            this.questPatrolIdx = (this.questPatrolIdx + tries + 1) % offsets.length;
            break;
          }
        }
      } else {
        this.questPatrolIdx = 1;
      }
      this.questCooldownUntil = now + 250;
      const cmdId = this.host.send(
        { type: 'WALK_TO', mapId: curMapId, x: tx, y: ty },
        `巡邏目標區域：${localHint.mapName ?? localHint.mapId}`,
        'ARRIVED',
      );
      this.questPatrolCommandId = cmdId;
      return null;
    }

    this.stop(`任務【${quest.title}】找不到下一步：${unmet.map(o => `${o.description} (${o.current}/${o.required})`).join('、')}`);
    return '找不到下一步';
  }

  private goNav(goal: NavGoal): string | null {
    this.issuedNav = true;
    return this.host.navigator.go(goal);
  }

  private npcNames(here: string[]): string[] {
    return [...new Set([...(this.host.knownNpcNames?.() ?? []), ...here])];
  }

  private knownMaps(snap: { mapId: string; mapName: string | null; nav: { reachableMaps: Array<{ mapId: string; name: string | null }> } }): Array<{ mapId: string; name: string }> {
    const merged = new Map<string, string>();
    merged.set(snap.mapId, snap.mapName ?? snap.mapId);
    for (const m of snap.nav.reachableMaps) merged.set(m.mapId, m.name ?? m.mapId);
    for (const m of this.host.knownMaps?.() ?? []) merged.set(m.mapId, m.name);
    return [...merged.entries()].map(([mapId, name]) => ({ mapId, name }));
  }
}
