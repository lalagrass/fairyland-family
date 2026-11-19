import {
  isCommandResultMessage, isEventMessage, isSnapshotMessage, planMapRoute,
  type PluginCommand, type PluginMessage, type SceneSnapshot, type SnapshotNpc,
} from './protocol/index';
import type { Directory } from './directory';
import type { FamilyState } from './state';

/** 導航目標：某個 NPC（可選擇到了就對話），或某張地圖。 */
export type NavGoal =
  | { kind: 'NPC'; query: string; talk: boolean }
  | { kind: 'MAP'; mapId: string; name: string };

export type NavPhase = 'IDLE' | 'WALKING' | 'WAIT_MAP' | 'PAUSED_BATTLE' | 'TALKING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface NavStatus {
  phase: NavPhase;
  goal: NavGoal | null;
  /** 規劃出的地圖序列（含起點與終點）。 */
  route: string[];
  text: string;
}

export interface NavHost {
  state(): FamilyState;
  send(command: PluginCommand, label: string, expect?: string): string | null;
  log(text: string, level?: 'info' | 'warn' | 'error'): void;
  after(ms: number, fn: () => void): unknown;
  dir: Directory;
  onChange(): void;
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
/** 與宿主「到了就能對話」的距離（TALK_RANGE_ARRIVAL）同值；走到這個距離內就直接對話。 */
export const TALK_NEAR = 140;
const RETRY_MS = 1000;
const MAX_RETRY = 90;
const MAX_BLOCKED_EXITS = 12;

const goalText = (g: NavGoal) => (g.kind === 'NPC' ? `${g.talk ? '對話' : '前往'} ${g.query}` : `前往 ${g.name}`);

/**
 * 外掛端自動導航器：把「前往 村長」拆成多段 WALK_TO（每段只在同一張圖內），換圖後等新快照再繼續，
 * 途中遇敵就暫停、戰鬥結束後從目前位置續走，最後視需要送 TALK_TO_NPC。
 * 每次重新派發或取消都會使舊的完成處理失效（token），所以過期的 COMMAND_COMPLETED 不會誤觸下一步。
 */
export class AutoNavigator {
  private token = 0;
  private current: { commandId: string; role: 'LEG' | 'APPROACH' | 'TALK'; fromMap: string; exitId?: string } | null = null;
  /** 這張圖上已經走不通（BLOCKED）的出口；換圖或重新派發就清空。 */
  private blocked = new Set<string>();
  /** 剛換圖：在看到不同於這張圖的新快照之前，不重新規劃（避免拿舊快照再走一次舊出口）。 */
  private awaitFrom: string | null = null;
  private retries = 0;
  private status: NavStatus = { phase: 'IDLE', goal: null, route: [], text: '導航：閒置' };

  constructor(private host: NavHost) {}

  getStatus(): NavStatus { return this.status; }
  isActive(): boolean { return ['WALKING', 'WAIT_MAP', 'PAUSED_BATTLE', 'TALKING'].includes(this.status.phase); }

  /** 開始導航；回傳錯誤文字（無法開始）或 null。 */
  go(goal: NavGoal): string | null {
    this.cancelInternal(false);
    this.awaitFrom = null;
    this.blocked.clear();
    const token = ++this.token;
    this.retries = 0;
    this.set({ phase: 'WALKING', goal, route: [], text: `導航：${goalText(goal)}` });
    this.step(token);
    return null;
  }

  /** 取消：使舊處理失效；若正在走路，送一個「走到目前位置」讓宿主停下。 */
  cancel(): void {
    if (!this.isActive()) return;
    this.cancelInternal(true);
    this.set({ ...this.status, phase: 'CANCELLED', text: '導航：已取消' });
  }

  private cancelInternal(stopWalking: boolean): void {
    this.token++;
    const walking = this.current && this.current.role !== 'TALK';
    this.current = null;
    if (stopWalking && walking) {
      const s = this.host.state();
      if (s.snapshot && s.character) this.host.send({ type: 'WALK_TO', mapId: s.snapshot.mapId, x: s.character.x, y: s.character.y }, '導航取消：原地停下', 'ARRIVED');
    }
  }

  /** 控制器把每一則（已通過守衛的）收到訊息交進來。 */
  onMessage(m: PluginMessage): void {
    if (!this.isActive()) return;
    if (isEventMessage(m)) {
      const e = m.event;
      if (e.type === 'GAME_STARTED' || e.type === 'GAME_STOPPED') { this.fail('遊戲重新啟動或停止，導航中止'); return; }
      if (e.type === 'COMMAND_COMPLETED') this.onCompleted(e.commandId, e.code, e.message);
      else if (e.type === 'COMMAND_REJECTED') this.onRejected(e.commandId, e.reasonCode, e.message);
      else if (e.type === 'LOCATION_CHANGED' && this.status.phase === 'WAIT_MAP') { const token = this.token; this.host.after(0, () => this.step(token)); }
      else if (e.type === 'BATTLE_STARTED' && this.status.phase !== 'PAUSED_BATTLE') this.set({ ...this.status, phase: 'PAUSED_BATTLE', text: '導航：遇到戰鬥，暫停' });
      else if (e.type === 'BATTLE_ENDED' && this.status.phase === 'PAUSED_BATTLE') this.resumeSoon('導航：戰鬥結束，繼續');
      return;
    }
    if (isCommandResultMessage(m) && m.status === 'REJECTED') { this.onRejected(m.commandId, m.reasonCode ?? 'CORE_REJECTED', m.message); return; }
    if (isSnapshotMessage(m) && this.status.phase === 'WAIT_MAP' ) {
      this.host.dir.learn(m.snapshot);
      const token = this.token;
      this.host.after(0, () => this.step(token));
    }
  }

  private onRejected(commandId: string, code: string, message?: string): void {
    if (!this.current || this.current.commandId !== commandId) return;
    this.current = null;
    // 畫面暫時被占住（遇敵轉場、結算視窗還沒關）：稍後重試，不算失敗。
    if (code === 'GAME_BUSY' || code === 'GAME_NOT_READY' || code === 'IN_BATTLE') { this.resumeSoon(`導航：遊戲忙碌（${code}），稍後重試`); return; }
    this.fail(`被拒絕 ${code}${message ? `（${message}）` : ''}`);
  }

  private onCompleted(commandId: string, code: string, message?: string): void {
    const cur = this.current;
    if (!cur || cur.commandId !== commandId) return; // 舊的／別人的指令：忽略
    this.current = null;
    const token = this.token;
    if (cur.role === 'TALK') {
      if (code === 'DIALOG_OPENED') this.set({ ...this.status, phase: 'DONE', text: `導航：已與 ${this.status.goal && this.status.goal.kind === 'NPC' ? this.status.goal.query : ''} 對話` });
      else this.fail(`對話失敗 ${code}${message ? `（${message}）` : ''}`);
      return;
    }
    switch (code) {
      case 'MAP_CHANGED':
        this.awaitFrom = cur.fromMap;
        this.blocked.clear();
        this.set({ ...this.status, phase: 'WAIT_MAP', text: '導航：已換圖，等新場景快照' });
        // 新快照可能已經先到（事件順序不保證），所以立刻檢查一次；還沒到就等 onMessage 的快照。
        this.host.after(0, () => this.step(token));
        return;
      case 'ARRIVED': {
        const g = this.status.goal;
        if (cur.role === 'APPROACH' && g && g.kind === 'NPC') {
          if (!g.talk) { this.set({ ...this.status, phase: 'DONE', text: `導航：已走到 ${g.query} 附近` }); return; }
          this.set({ ...this.status, phase: 'TALKING' });
          this.step(token, true); // 走到了就直接對話，不再用（可能過期的）位置判斷
          return;
        }
        if (cur.role === 'LEG' && cur.exitId) {
          // 走到了出口座標卻沒換圖（例如建築入口只是裝飾）：這個出口不算數，換另一個。
          this.blocked.add(cur.exitId);
          this.host.log('導航：走到出口但沒有換圖，換另一個出口', 'warn');
        }
        this.set({ ...this.status, phase: 'WALKING' });
        this.step(token);
        return;
      }
      case 'ENCOUNTER':
        this.set({ ...this.status, phase: 'PAUSED_BATTLE', text: '導航：遇敵，戰鬥結束後繼續' });
        return;
      case 'BLOCKED':
        // 這個出口走不到（例如建築入口沒有通路）：換同一個目的地的別個出口再試。
        if (cur.role === 'LEG' && cur.exitId) {
          this.blocked.add(cur.exitId);
          this.host.log(`導航：出口走不通（${message ?? 'BLOCKED'}），換另一個出口`, 'warn');
          this.set({ ...this.status, phase: 'WALKING' });
          this.step(token);
          return;
        }
        this.fail(`走路中斷 ${code}${message ? `（${message}）` : ''}`);
        return;
      default:
        this.fail(`走路中斷 ${code}${message ? `（${message}）` : ''}`);
    }
  }

  private resumeSoon(text: string): void {
    if (++this.retries > MAX_RETRY) { this.fail('等待遊戲可操作逾時'); return; }
    const token = this.token;
    this.set({ ...this.status, phase: 'WALKING', text });
    this.host.after(RETRY_MS, () => this.step(token));
  }

  private step(token: number, talkNow = false): void {
    if (token !== this.token || !this.status.goal || this.current) return;
    const goal = this.status.goal;
    const st = this.host.state();
    if (this.host.state().battle) { this.set({ ...this.status, phase: 'PAUSED_BATTLE', text: '導航：戰鬥中，暫停' }); return; }
    // 宿主在沒有場景資料的地圖（模擬野外）不會送快照；目標就是這張圖時，知道所在位置就算到了。
    if (goal.kind === 'MAP' && st.location?.mapId === goal.mapId) { this.set({ ...this.status, phase: 'DONE', text: `導航：已到達 ${st.location.mapName ?? goal.name}` }); return; }
    const snap = st.snapshot;
    if (!snap || !st.location || snap.mapId !== st.location.mapId) { this.set({ ...this.status, phase: 'WAIT_MAP', text: '導航：等待場景快照' }); return; }
    if (this.awaitFrom) {
      if (snap.mapId === this.awaitFrom) { this.set({ ...this.status, phase: 'WAIT_MAP', text: '導航：已換圖，等新場景快照' }); return; }
      this.awaitFrom = null;
    }
    this.host.dir.learn(snap);
    // 結算視窗沒關時宿主會回 GAME_BUSY，由重試處理（不在這裡猜，因為在遊戲裡手動關窗外掛收不到事件）。
    if (st.dialog || st.shop) { this.fail(`請先結束${st.dialog ? '對話' : '商店'}再導航`); return; }

    const targetMap = goal.kind === 'MAP' ? goal.mapId : this.resolveNpcMap(goal.query, snap);
    if (!targetMap) { this.fail(goal.kind === 'NPC' ? `不知道「${goal.query}」在哪張圖` : '沒有目標地圖'); return; }

    if (snap.mapId !== targetMap) {
      if (this.blocked.size > MAX_BLOCKED_EXITS) { this.fail(`試了 ${this.blocked.size} 個出口都到不了下一張圖`); return; }
      const route = planMapRoute(this.host.dir.adjacency(snap), snap.mapId, targetMap);
      if (!route) { this.fail(`找不到從 ${snap.mapName ?? snap.mapId} 到 ${this.host.dir.mapName(targetMap) ?? targetMap} 的路線（只知道看過的地圖出口）`); return; }
      const next = route[1];
      const c0 = st.character;
      const exit = snap.exits.filter(e => e.targetMapId === next && !this.blocked.has(e.id))
        .sort((a, b) => (c0 ? dist(c0.x, c0.y, a.x, a.y) - dist(c0.x, c0.y, b.x, b.y) : 0))[0];
      if (!exit) { this.fail(snap.exits.some(e => e.targetMapId === next) ? `通往 ${next} 的出口都走不通` : `這張圖沒有通往 ${next} 的出口`); return; }
      const names = route.map(m => this.host.dir.mapName(m) ?? m);
      this.set({ ...this.status, phase: 'WALKING', route, text: `導航：${names.join(' → ')}　現在前往出口「${exit.name}」` });
      this.issue({ type: 'WALK_TO', mapId: snap.mapId, x: exit.x, y: exit.y }, `導航：走向出口「${exit.name}」`, 'LEG', 'MAP_CHANGED', snap.mapId, exit.id);
      return;
    }

    // 已在目標地圖
    if (goal.kind === 'MAP') { this.set({ ...this.status, phase: 'DONE', text: `導航：已到達 ${snap.mapName ?? snap.mapId}` }); return; }
    const npc = this.findNpc(snap, goal.query);
    if (!npc) { this.fail(`這張圖找不到「${goal.query}」`); return; }
    const c = this.host.state().character;
    const near = c ? dist(c.x, c.y, npc.x, npc.y) <= TALK_NEAR : false;
    if (!goal.talk) {
      if (near) this.set({ ...this.status, phase: 'DONE', text: `導航：已在 ${npc.name} 附近` });
      else this.issue({ type: 'WALK_TO', mapId: snap.mapId, x: npc.x, y: npc.y }, `導航：走向 ${npc.name}`, 'APPROACH', 'ARRIVED', snap.mapId);
      return;
    }
    if (near || talkNow) {
      this.set({ ...this.status, phase: 'TALKING', text: `導航：與 ${npc.name} 對話` });
      this.issue({ type: 'TALK_TO_NPC', npcId: npc.id }, `導航：對話 ${npc.name}`, 'TALK', 'DIALOG_OPENED', snap.mapId);
    } else {
      this.issue({ type: 'WALK_TO', mapId: snap.mapId, x: npc.x, y: npc.y }, `導航：走向 ${npc.name}`, 'APPROACH', 'ARRIVED', snap.mapId);
    }
  }

  private findNpc(snap: SceneSnapshot, q: string): SnapshotNpc | null {
    const talkable = snap.npcs.filter(n => n.talkable);
    return talkable.find(n => n.name === q) ?? talkable.find(n => n.name.includes(q) || (q.length > 1 && q.includes(n.name))) ?? null;
  }

  /** 目標 NPC 所在地圖：目前這張圖看得到就用它，否則查已知目錄。 */
  private resolveNpcMap(q: string, snap: SceneSnapshot): string | null {
    // 完全同名的優先：「斯坦」不能因為這張圖有「旅行商人斯坦萊」就被當成已經在這裡。
    const here = this.findNpc(snap, q);
    if (here && here.name === q) return snap.mapId;
    const hits = this.host.dir.findNpc(q);
    const exact = hits.find(h => h.name === q);
    if (exact) return exact.mapId;
    if (here) return snap.mapId;
    return hits.length ? hits[0].mapId : null;
  }

  private issue(command: PluginCommand, label: string, role: 'LEG' | 'APPROACH' | 'TALK', expect: string, fromMap: string, exitId?: string): void {
    const id = this.host.send(command, label, expect);
    if (!id) { this.fail('指令送不出去（遊戲未執行？）'); return; }
    this.current = { commandId: id, role, fromMap, exitId };
  }

  private fail(why: string): void {
    this.token++;
    this.current = null;
    this.set({ ...this.status, phase: 'FAILED', text: `導航失敗：${why}` });
    this.host.log(`導航失敗：${why}`, 'warn');
  }

  private set(s: NavStatus): void {
    this.status = s;
    this.host.onChange();
  }
}
