import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type {
  PluginCommand,
  SnapshotActiveWork,
  SnapshotBattleStatus,
  SnapshotBattleUnitSummary,
} from './protocol/index';
import { STRATEGIES, type BattleStrategy } from './battler';
import type { DirNpc } from './directory';
import {
  LOG_TAGS,
  TAG_CLASS,
  collapseAndFilterLogs,
  isDevModeEnabled,
} from './log_utils';
import { buildMenu, type MenuItem } from './menu';
import type { NavStatus } from './navigator';
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from './notify';
import { INPUT_HELP, type UiAction } from './parse';
import { stopReasonLabel, type QueueStatus } from './queue';
import { initialState, type FamilyState, type LogTag } from './state';

type Perform = (action: UiAction) => string | null;
type SubmitText = (text: string) => string | null;

/** 畫面上除了鏡像狀態之外，還要顯示的外掛端資訊。 */
export interface UiAux {
  nav: NavStatus;
  strategy: BattleStrategy;
  known: DirNpc[];
  queue?: QueueStatus;
  queues?: Record<string, QueueStatus>;
  devMode?: boolean;
  activeQuestId?: number | null;
}

const NO_QUEUE: QueueStatus = { phase: 'IDLE', jobs: [], activeJobIndex: 0, stopReason: null, text: '工作佇列：閒置' };
const NO_AUX: UiAux = {
  nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置' },
  strategy: 'MANUAL',
  known: [],
  queue: NO_QUEUE,
  queues: {},
  activeQuestId: null,
};

const fmtTime = (t: number): string => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const cmdAction = (command: PluginCommand, label: string): UiAction => ({ kind: 'COMMAND', command, label });

const STATUS_LABELS: Record<string, string> = {
  PETRIFY: '石化',
  SLEEP: '睡眠',
  CONFUSE: '混亂',
  POISON: '中毒',
  SHIELD: '護盾',
  ATK_UP: '攻↑',
  DEF_DOWN: '防↓',
  GUARD_UP: '格擋↑',
  COUNTER: '反擊',
  EVADE_UP: '閃避↑',
  HASTE: '加速',
  PROTECT: '守護',
  FEIGN: '裝死',
};
const DEBUFF_SET = new Set(['PETRIFY', 'SLEEP', 'CONFUSE', 'POISON', 'DEF_DOWN']);

interface StatusUnit {
  isDead?: boolean;
  isDefending?: boolean;
  isChanting?: boolean;
  statuses?: SnapshotBattleStatus[];
}

function StatusBadges({ unit }: { unit?: StatusUnit | null }) {
  if (!unit) return null;
  const hasAny =
    unit.isDead || unit.isDefending || unit.isChanting || (unit.statuses && unit.statuses.length > 0);
  if (!hasAny) return null;
  return (
    <>
      {unit.isDead && (
        <span className="status-tag debuff" data-testid="status-badge">
          倒下
        </span>
      )}
      {unit.isDefending && (
        <span className="status-tag buff" data-testid="status-badge">
          防禦中
        </span>
      )}
      {unit.isChanting && (
        <span className="status-tag" data-testid="status-badge">
          詠唱中
        </span>
      )}
      {(unit.statuses ?? []).map((st, idx) => {
        const cls = DEBUFF_SET.has(st.type) ? 'status-tag debuff' : 'status-tag buff';
        const label = STATUS_LABELS[st.type] ?? st.type;
        const stacks = st.stacks && st.stacks > 1 ? `×${st.stacks}` : '';
        return (
          <span
            key={`${st.type}-${idx}`}
            className={cls}
            data-testid="status-badge"
            data-status-type={st.type}
          >
            {`${label}${stacks}(${st.duration}T)`}
          </span>
        );
      })}
    </>
  );
}

function UnitStatusRow({
  title,
  unit,
  testid,
}: {
  title: string;
  unit: SnapshotBattleUnitSummary;
  testid: string;
}) {
  const hasBadges =
    unit.isDead || unit.isDefending || unit.isChanting || (unit.statuses && unit.statuses.length > 0);
  return (
    <div className="status-row" data-testid={testid}>
      <span className="k">{title}</span>
      <span>
        {`${unit.name} HP ${unit.hp}/${unit.maxHp}${
          unit.mp !== undefined ? ` MP ${unit.mp}/${unit.maxMp ?? unit.mp}` : ''
        }`}
      </span>
      {hasBadges ? <StatusBadges unit={unit} /> : <span className="muted">無異常/增益</span>}
    </div>
  );
}

function WorkProgress({ work, now }: { work?: SnapshotActiveWork | null; now: number }) {
  if (!work) return null;
  const total = Math.max(1, work.endsAt - work.startedAt);
  const remainMs = Math.max(0, work.endsAt - now);
  const pct = Math.min(100, Math.max(0, ((total - remainMs) / total) * 100));
  const secs = (remainMs / 1000).toFixed(1);
  return (
    <div className="work-progress" data-testid="member-work-progress">
      <div className="work-progress-head">
        <span>{work.label}</span>
        <span>{remainMs > 0 ? `${secs}s` : '完成待結算'}</span>
      </div>
      <div className="work-progress-bar">
        <div className="fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
    </div>
  );
}

function PortraitSlot({
  name,
  characterId,
  size = 'sm',
}: {
  name?: string | null;
  characterId?: string | null;
  size?: 'sm' | 'lg';
}) {
  const glyph = (name || characterId || '俠').trim().slice(0, 1);
  return (
    <div
      className={`portrait-slot portrait-${size}`}
      data-testid="portrait-slot"
      data-portrait-char={characterId ?? undefined}
      title={name ?? characterId ?? '角色立繪預留位'}
    >
      <span>{glyph}</span>
    </div>
  );
}

interface AppProps {
  modeLabel: string;
  state: FamilyState;
  conn: 'RUNNING' | 'STOPPED';
  aux: UiAux;
  perform: Perform;
  submit: SubmitText;
  strategyRef: React.RefObject<HTMLSelectElement | null>;
}

function FamilyApp({ modeLabel, state, conn, aux, perform, submit, strategyRef }: AppProps) {
  const [inputValue, setInputValue] = useState('');
  const [inputErr, setInputErr] = useState('');
  const [mobileTab, setMobileTab] = useState<'roster' | 'active' | 'feed'>('active');
  const [tagFilter, setTagFilter] = useState<LogTag | 'ALL'>('ALL');
  const [charFilter, setCharFilter] = useState<string | 'ALL'>('ALL');
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermissionState>(() => getNotificationPermission());
  const [nowTick, setNowTick] = useState(() => Date.now());

  const devMode = aux.devMode ?? isDevModeEnabled();
  const running = conn === 'RUNNING';
  const c = state.character;
  const snap = state.snapshot;

  const hasActiveCountdown = Boolean(
    (c?.activeWork && c.activeWork.endsAt > nowTick) ||
      state.members.some(m => m.activeWork && m.activeWork.endsAt > nowTick),
  );

  useEffect(() => {
    if (!hasActiveCountdown) return;
    const id = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(id);
  }, [hasActiveCountdown]);

  const handleAction = (action: UiAction) => {
    const err = perform(action);
    setInputErr(err ?? '');
  };

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const err = submit(inputValue);
    setInputErr(err ?? '');
    if (!err) setInputValue('');
  };

  const handleRequestNotify = async () => {
    const perm = await requestNotificationPermission();
    setNotifyPerm(perm);
  };

  const renderMenuRow = (label: string, items: MenuItem[], empty: string) => (
    <div key={label} className="row" data-testid={`menu-${label}`}>
      <span className="k">{label}</span>
      <div className="items">
        {items.length === 0 ? (
          <span className="muted">{empty}</span>
        ) : (
          items.map((it, idx) => (
            <button
              key={`${it.label}-${idx}`}
              className="item"
              type="button"
              data-testid="menu-item"
              disabled={!running || !it.action}
              onClick={() => it.action && handleAction(it.action)}
            >
              {it.label}
              {it.hint && <small>{it.hint}</small>}
            </button>
          ))
        )}
      </div>
    </div>
  );

  const activeMemberId = state.activeCharacterId ?? snap?.family?.activeCharacterId ?? 'char_1';
  const maxSlots = snap?.family?.maxSlots ?? 5;
  const activeQueue = aux.queue ?? NO_QUEUE;
  const qActive = ['RUNNING', 'PAUSED_BATTLE', 'WAITING_TOOL_BUY', 'WALKING_TO_POINT'].includes(activeQueue.phase);
  const navActive = ['WALKING', 'WAIT_MAP', 'PAUSED_BATTLE', 'TALKING'].includes(aux.nav.phase);

  const quests = useMemo(() => {
    const raw = snap?.quests ?? [];
    const rank = (x: string) => (x === 'READY' ? 0 : x === 'IN_PROGRESS' ? 1 : x === 'AVAILABLE' ? 2 : 3);
    return [...raw].sort((a, b) => rank(a.status) - rank(b.status) || a.questId - b.questId);
  }, [snap?.quests]);

  const menuSections = useMemo(() => {
    if (!snap) return [];
    return buildMenu(snap, aux.known).filter(
      sec => !((sec.key === 'animals' || sec.key === 'known') && sec.items.length === 0),
    );
  }, [snap, aux.known]);

  const craftItems: MenuItem[] = useMemo(() => {
    if (!snap?.recipes || snap.recipes.length === 0) return [];
    const invMap = new Map(state.inventory.map(i => [i.itemId, i.count]));
    const hasAll = (r: (typeof snap.recipes)[number]) =>
      r.ingredients.every(i => i.itemId !== null && (invMap.get(i.itemId) ?? 0) >= i.count);
    const priority = snap.recipes.filter(r => r.recipeId === 20901 || r.recipeId === 40101 || hasAll(r));
    const picked = [...priority, ...snap.recipes.filter(r => !priority.includes(r))].slice(0, 12);
    return picked.map(r => ({
      label: `製作：${r.name}`,
      hint: r.ingredients.map(i => `${i.name}×${i.count}`).join('+'),
      action: {
        kind: 'QUEUE_CRAFT',
        recipeId: r.recipeId,
        recipeName: r.name,
        count: 1,
        label: `製作：${r.name}`,
      },
    }));
  }, [snap?.recipes, state.inventory]);

  const collapsedLogs = useMemo(
    () => collapseAndFilterLogs(state.log, { devMode, tagFilter, charFilter }),
    [state.log, devMode, tagFilter, charFilter],
  );

  const charFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of state.members) map.set(m.characterId, m.name ?? m.characterId);
    if (state.characterId && !map.has(state.characterId)) {
      map.set(state.characterId, c?.name ?? state.characterId);
    }
    return [...map.entries()];
  }, [state.members, state.characterId, c?.name]);

  const statusMeta: Record<string, { text: string; cls: string }> = {
    AVAILABLE: { text: '可接取', cls: 'pill mode' },
    IN_PROGRESS: { text: '進行中', cls: 'pill warn' },
    READY: { text: '可回報', cls: 'pill ok' },
    COMPLETED: { text: '已完成', cls: 'pill' },
  };

  // DV1：僅於 ?dev=1 時準備雙向對照資訊
  const compareInfo = useMemo(() => {
    if (!devMode || !snap || !c) return null;
    const snapInv = c.inventoryCount ?? state.inventory.reduce((sum, i) => sum + i.count, 0);
    const diffs: string[] = [];
    const ev = state.eventMirror;
    if (ev.mapId && ev.mapId !== snap.mapId) diffs.push(`地圖(${snap.mapId}≠${ev.mapId})`);
    if (ev.gold !== null && ev.gold !== c.gold) diffs.push(`金錢(${c.gold}≠${ev.gold})`);
    if (ev.inventoryCount !== null && ev.inventoryCount !== snapInv) diffs.push(`背包(${snapInv}≠${ev.inventoryCount})`);
    return {
      snapInv,
      diffs,
      statusText: diffs.length === 0 ? '一致 OK' : `事件較新：${diffs.join('、')}`,
    };
  }, [devMode, snap, c, state.inventory, state.eventMirror]);

  const wh = state.warehouse;
  const staleSnap = Boolean(snap && state.location && snap.mapId !== state.location.mapId);
  const sceneTitle = state.location ? `${state.location.mapName ?? state.location.mapId}` : '（未知）';
  const invUsed = c ? c.inventoryCount ?? state.inventory.reduce((sum, i) => sum + i.count, 0) : 0;

  return (
    <div className="family-shell">
      <header>
        <h1>童話家族</h1>
        <span className={`pill ${running ? 'run' : 'stop'}`} data-testid="conn-status">
          {running ? '遊戲執行中' : '遊戲未執行'}
        </span>
        <span className="pill mode">{modeLabel}</span>
        {devMode && <span className="pill warn">開發者模式</span>}
        {devMode && (
          <span className="muted" data-testid="session">
            {state.sessionId ? `session ${state.sessionId.slice(0, 8)}` : ''}
          </span>
        )}
        <div className="header-actions">
          {notifyPerm !== 'unsupported' && (
            <button
              type="button"
              className={`item notify-btn ${notifyPerm === 'granted' ? 'granted' : ''}`}
              data-testid="notify-perm-btn"
              onClick={handleRequestNotify}
            >
              {notifyPerm === 'granted' ? '背景通知已開啟' : notifyPerm === 'denied' ? '通知已封鎖' : '開啟背景通知'}
            </button>
          )}
        </div>
      </header>

      <nav className="mobile-tabs" data-testid="mobile-tabs" aria-label="手機版分頁切換">
        <button
          type="button"
          className={`item ${mobileTab === 'roster' ? 'tab-active' : ''}`}
          onClick={() => setMobileTab('roster')}
        >
          {`名冊 (${state.members.length})`}
        </button>
        <button
          type="button"
          className={`item ${mobileTab === 'active' ? 'tab-active' : ''}`}
          onClick={() => setMobileTab('active')}
        >
          目前角色
        </button>
        <button
          type="button"
          className={`item ${mobileTab === 'feed' ? 'tab-active' : ''}`}
          onClick={() => setMobileTab('feed')}
        >
          事件流
        </button>
      </nav>

      <div className="layout-grid">
        {/* 左欄：家族成員名冊 + 共用倉庫 */}
        <div className={`col col-roster ${mobileTab !== 'roster' ? 'col-hidden-mobile' : ''}`}>
          <section data-testid="family-bar">
            <h2>{`家族成員（${state.members.length}/${maxSlots}）`}</h2>
            {state.members.length === 0 ? (
              <div className="muted">（尚未收到家族成員資料）</div>
            ) : (
              state.members.map(m => {
                const isActive = m.characterId === activeMemberId;
                const q = aux.queues?.[m.characterId] ?? (isActive ? aux.queue : undefined);
                const qText = q && (q.phase !== 'IDLE' || q.jobs.length > 0 || q.stopReason) ? q.text : '工作佇列：閒置';
                return (
                  <div key={m.characterId} className="member-card">
                    <PortraitSlot name={m.name} characterId={m.characterId} size="sm" />
                    <div className="member-card-body">
                      <div className="char" data-character-id={m.characterId}>
                        <span className={`pill ${isActive ? 'ok' : ''}`}>{isActive ? '視角中' : '待機中'}</span>
                        <span>{`${m.name ?? m.characterId} Lv.${m.level}`}</span>
                        <span>{`${m.mapName ?? m.mapId}`}</span>
                        <span>{`金 ${m.gold}`}</span>
                        <span>{`體 ${m.satiety}`}</span>
                        <span>{`袋 ${m.inventoryCount}/${m.inventoryCap}`}</span>
                        <span className="muted">{qText}</span>
                        {!isActive && (
                          <button
                            type="button"
                            className="item"
                            data-testid="switch-char-btn"
                            data-character-id={m.characterId}
                            disabled={!running}
                            onClick={() =>
                              handleAction(
                                cmdAction(
                                  { type: 'SWITCH_VIEW_CHARACTER', characterId: m.characterId },
                                  `切換視角 ${m.name ?? m.characterId}`,
                                ),
                              )
                            }
                          >
                            切換視角
                          </button>
                        )}
                      </div>
                      <WorkProgress work={m.activeWork} now={nowTick} />
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section data-testid="warehouse-panel">
            <h2>家族共用倉庫</h2>
            {!wh ? (
              <div className="muted">（尚未收到倉庫資料）</div>
            ) : (
              <>
                <div className="char">
                  <span data-testid="wh-gold">{`倉庫金錢：${wh.gold}`}</span>
                  <span data-testid="wh-cap">{`倉庫容量：${wh.items.reduce((sum, it) => sum + it.count, 0)}/${wh.cap}`}</span>
                  <button
                    type="button"
                    className="item"
                    data-testid="wh-deposit-gold"
                    disabled={!running || (c?.gold ?? 0) < 500}
                    onClick={() => handleAction(cmdAction({ type: 'WAREHOUSE_DEPOSIT', gold: 500 }, '存倉 500 金'))}
                  >
                    存 500 金
                  </button>
                  <button
                    type="button"
                    className="item"
                    data-testid="wh-withdraw-gold"
                    disabled={!running || wh.gold < 500}
                    onClick={() => handleAction(cmdAction({ type: 'WAREHOUSE_WITHDRAW', gold: 500 }, '取倉 500 金'))}
                  >
                    取 500 金
                  </button>
                </div>
                <div className="items">
                  {wh.items.length === 0 ? (
                    <span className="muted">倉庫物品：空</span>
                  ) : (
                    wh.items.map(it => (
                      <button
                        key={it.itemId}
                        type="button"
                        className="item"
                        data-testid="wh-withdraw-item"
                        data-item-id={String(it.itemId)}
                        disabled={!running}
                        onClick={() =>
                          handleAction(
                            cmdAction(
                              { type: 'WAREHOUSE_WITHDRAW', itemId: it.itemId, count: 1 },
                              `取倉 ${it.name ?? it.itemId} ×1`,
                            ),
                          )
                        }
                      >
                        {`取 ${it.name ?? `#${it.itemId}`} ×${it.count}`}
                      </button>
                    ))
                  )}
                </div>
                {state.inventory.length > 0 && (
                  <>
                    <div className="muted">目前角色背包（點一下存倉 ×1）：</div>
                    <div className="items">
                      {state.inventory.map(it => (
                        <button
                          key={it.itemId}
                          type="button"
                          className="item"
                          data-testid="wh-deposit-item"
                          data-item-id={String(it.itemId)}
                          disabled={!running}
                          onClick={() =>
                            handleAction(
                              cmdAction(
                                { type: 'WAREHOUSE_DEPOSIT', itemId: it.itemId, count: 1 },
                                `存倉 ${it.name ?? it.itemId} ×1`,
                              ),
                            )
                          }
                        >
                          {`存 ${it.name ?? `#${it.itemId}`} ×${it.count}`}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>

        {/* 中欄：目前角色（含立繪預留框） + 導航 + 任務 + 互動與策略 + 場景選單 + 文字輸入 */}
        <div className={`col col-active ${mobileTab !== 'active' ? 'col-hidden-mobile' : ''}`}>
          <section data-testid="character">
            <h2>角色</h2>
            {c ? (
              <div className="hero-card">
                <PortraitSlot name={c.name} characterId={state.characterId} size="lg" />
                <div className="hero-meta">
                  <div className="char">
                    <span>
                      <b>{c.name ?? state.characterId ?? '？'}</b>
                      {` Lv.${c.level}`}
                    </span>
                    <span>{`HP ${c.hp ?? '?'}/${c.maxHp ?? '?'}`}</span>
                    <span>{`MP ${c.mp ?? '?'}/${c.maxMp ?? '?'}`}</span>
                    <span data-testid="gold">{`金錢 ${c.gold}`}</span>
                    <span data-testid="pos">{`位置 (${c.x}, ${c.y})`}</span>
                    <span data-testid="satiety">{`飽食 ${c.satiety ?? 100}/${c.maxSatiety ?? 100}`}</span>
                    <span data-testid="bag-cap">{`背包 ${invUsed}/${c.inventoryCap ?? 40}`}</span>
                    {c.weaponFamily && (
                      <span data-testid="mastery">
                        {`武器 ${c.weaponFamily} Lv.${c.familyLevel ?? 1}｜連擊 Lv.${c.comboLevel ?? 1}`}
                      </span>
                    )}
                    <span>{c.inBattle ? '戰鬥中' : '探索中'}</span>
                  </div>
                  <WorkProgress work={c.activeWork} now={nowTick} />
                  {(c.isDefending || c.isChanting || (c.statuses && c.statuses.length > 0)) && (
                    <div className="status-row" data-testid="char-status-row">
                      <span className="muted">狀態：</span>
                      <StatusBadges unit={c} />
                    </div>
                  )}
                  {(c.activePet ?? state.battle?.pet) && (
                    <UnitStatusRow title="出戰寵" unit={(c.activePet ?? state.battle?.pet)!} testid="pet-status-row" />
                  )}
                </div>
              </div>
            ) : (
              <div className="muted">{running ? '等待快照…' : '（沒有角色資料；請先開啟 fairyland 遊戲分頁）'}</div>
            )}
            {state.battle && (
              <div>
                {`戰鬥 #${state.battle.battleId}${state.battle.round ? ` 第 ${state.battle.round} 回合` : ''}：${state.battle.enemies.join('、')}`}
              </div>
            )}
          </section>

          <section data-testid="nav-panel">
            <h2>自動導航</h2>
            <div data-testid="nav-status" data-phase={aux.nav.phase}>
              {aux.nav.text}
            </div>
            {aux.nav.route.length > 1 && (
              <div className="muted" data-testid="nav-route">
                {`路線：${aux.nav.route.join(' → ')}`}
              </div>
            )}
            {navActive && (
              <button
                type="button"
                className="item"
                data-testid="nav-cancel"
                disabled={!running}
                onClick={() => handleAction({ kind: 'NAV_CANCEL', label: '取消導航' })}
              >
                停止導航
              </button>
            )}
          </section>

          <section data-testid="quest-panel">
            <h2>任務摘要與自動推進</h2>
            {!snap ? (
              <div className="muted">（尚未收到任務快照）</div>
            ) : (
              <>
                {snap.openingStage && snap.openingStage !== 'DONE' && (
                  <div className="row" data-testid="opening-stage-badge">
                    <span className="pill warn">{`主線階段：${snap.openingStage}`}</span>
                  </div>
                )}
                {quests.length === 0 ? (
                  <div className="muted">（目前沒有可用委託清單）</div>
                ) : (
                  quests.map(q => {
                    const st = statusMeta[q.status] ?? { text: q.status, cls: 'pill' };
                    const isAutoRunning = aux.activeQuestId === q.questId;
                    return (
                      <div
                        key={q.questId}
                        className="quest-item"
                        data-testid="quest-entry"
                        data-quest-id={String(q.questId)}
                        data-quest-status={q.status}
                      >
                        <div className="row">
                          <span className={st.cls}>{st.text}</span>
                          <b>{q.title}</b>
                          <span className="muted">{`Lv.${q.minLevel}｜${q.npcName}｜獎 ${q.rewardExp}EXP / ${q.rewardCoins}金`}</span>
                          {q.status !== 'COMPLETED' && (
                            <>
                              <button
                                type="button"
                                className="item"
                                data-testid="quest-nav-btn"
                                data-quest-id={String(q.questId)}
                                disabled={!running}
                                onClick={() =>
                                  handleAction({
                                    kind: 'NAV',
                                    goal: { kind: 'NPC', query: q.npcName, talk: true },
                                    label: `前往並對話 ${q.npcName}`,
                                  })
                                }
                              >
                                {`前往 ${q.npcName}`}
                              </button>
                              <button
                                type="button"
                                className="item"
                                data-testid="quest-auto-btn"
                                data-quest-id={String(q.questId)}
                                disabled={!running}
                                onClick={() =>
                                  handleAction({
                                    kind: 'QUEST_AUTO',
                                    questId: q.questId,
                                    label: `自動處理任務 ${q.title}`,
                                  })
                                }
                              >
                                {q.status === 'READY' ? '自動回報' : q.status === 'AVAILABLE' ? '自動接取' : '自動推進'}
                              </button>
                              {isAutoRunning && (
                                <button
                                  type="button"
                                  className="item"
                                  data-testid="quest-auto-stop-btn"
                                  data-quest-id={String(q.questId)}
                                  disabled={!running}
                                  onClick={() => handleAction({ kind: 'QUEST_AUTO_STOP', label: '停止自動任務' })}
                                >
                                  停止自動
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        {q.objectives.length > 0 && (
                          <div className="muted">
                            {q.objectives
                              .map(o => {
                                const maps =
                                  o.targetMaps && o.targetMaps.length > 0
                                    ? `［前往：${o.targetMaps
                                        .slice(0, 3)
                                        .map(h => h.mapName)
                                        .join('／')}${
                                        o.targetMaps.length > 3 ? `…等 ${o.targetMaps.length} 張圖` : ''
                                      }］`
                                    : '';
                                return `${o.description} (${o.current}/${o.required}) ${o.met ? '✓' : '…'}${maps}`;
                              })
                              .join(' ｜ ')}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </>
            )}
          </section>

          <section data-testid="activity">
            {(state.battle || state.battleResult) && (
              <div data-testid="battle-panel">
                <h2>戰鬥</h2>
                {state.battle && (
                  <>
                    <div data-testid="battle-info">
                      {`#${state.battle.battleId}${state.battle.round ? ` 第 ${state.battle.round} 回合` : ''}${
                        state.battle.ready ? '（等你出手）' : '（結算中）'
                      }`}
                    </div>
                    {state.battle.player && (
                      <UnitStatusRow title="主角" unit={state.battle.player} testid="battle-player-status-row" />
                    )}
                    {state.battle.pet && (
                      <UnitStatusRow title="出戰寵" unit={state.battle.pet} testid="battle-pet-status-row" />
                    )}
                    <div className="items">
                      {state.battle.enemyStates.map(e => (
                        <button
                          key={e.slot}
                          type="button"
                          className="item"
                          data-testid="battle-attack"
                          data-slot={String(e.slot)}
                          disabled={!running || !state.battle?.ready}
                          onClick={() =>
                            handleAction(
                              cmdAction(
                                {
                                  type: 'BATTLE_ACTION',
                                  battleId: state.battle!.battleId,
                                  action: { kind: 'ATTACK', targetSlot: e.slot },
                                },
                                `攻擊 ${e.name}`,
                              ),
                            )
                          }
                        >
                          {`攻擊 ${e.name}`}
                          <small>{`${e.hp}/${e.maxHp}`}</small>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="item"
                        data-testid="battle-defend"
                        disabled={!running || !state.battle.ready}
                        onClick={() =>
                          handleAction(
                            cmdAction(
                              {
                                type: 'BATTLE_ACTION',
                                battleId: state.battle!.battleId,
                                action: { kind: 'DEFEND' },
                              },
                              '防禦',
                            ),
                          )
                        }
                      >
                        防禦
                      </button>
                      <button
                        type="button"
                        className="item"
                        data-testid="battle-flee"
                        disabled={!running || !state.battle.ready || !state.battle.canFlee}
                        onClick={() =>
                          handleAction(
                            cmdAction({ type: 'BATTLE_FLEE', battleId: state.battle!.battleId }, '戰鬥逃跑'),
                          )
                        }
                      >
                        逃跑
                      </button>
                    </div>
                    {state.battle.enemyStates.map(e => {
                      const hasBadge =
                        e.isDead || e.isDefending || e.isChanting || (e.statuses && e.statuses.length > 0);
                      if (!hasBadge) return null;
                      return (
                        <div
                          key={e.slot}
                          className="status-row"
                          data-testid="battle-enemy-status-row"
                          data-slot={String(e.slot)}
                        >
                          <span className="muted">{`${e.name}：`}</span>
                          <StatusBadges unit={e} />
                        </div>
                      );
                    })}
                    {!state.battle.canFlee && <div className="muted">這場戰鬥不能逃跑</div>}
                  </>
                )}
                {state.battleResult && (
                  <>
                    <div data-testid="battle-result">
                      {state.battleResult === 'VICTORY' ? '勝利！結算視窗開著' : '敗北，結算視窗開著'}
                    </div>
                    <button
                      type="button"
                      className="item"
                      data-testid="battle-result-option"
                      disabled={!running}
                      onClick={() =>
                        handleAction(
                          cmdAction(
                            {
                              type: 'CHOOSE_DIALOG_OPTION',
                              optionId: state.battleResult === 'VICTORY' ? 'RETURN_TO_MAP' : 'DEFEAT_RESCUE',
                            },
                            state.battleResult === 'VICTORY' ? '關閉勝利視窗' : '敗北：送回醫院',
                          ),
                        )
                      }
                    >
                      {state.battleResult === 'VICTORY' ? '返回地圖' : '送回醫院'}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* 永久保留的 <select> 節點，確保快照重繪與切換頁籤不會重置 focus 與展開選單 */}
            <div className="row">
              <span className="k">戰鬥策略</span>
              <select
                ref={strategyRef}
                data-testid="strategy"
                defaultValue={aux.strategy}
                onChange={e =>
                  handleAction({
                    kind: 'STRATEGY',
                    strategy: e.currentTarget.value as BattleStrategy,
                    label: `戰鬥策略：${e.currentTarget.value}`,
                  })
                }
              >
                {STRATEGIES.map(st => (
                  <option key={st.id} value={st.id}>
                    {st.label}
                  </option>
                ))}
              </select>
              <span className="muted">（手動＝外掛不自動出手）</span>
            </div>

            {state.dialog && (
              <div className="dialog" data-testid="dialog">
                <b>{`${state.dialog.npcName}：`}</b>
                {state.dialog.lines.slice(0, 3).map((l, idx) => (
                  <div key={idx}>{l}</div>
                ))}
                <div className="items">
                  {state.dialog.options.length === 0 ? (
                    <span className="muted">（宿主沒有提供選項）</span>
                  ) : (
                    state.dialog.options.map(o => (
                      <button
                        key={o.id}
                        type="button"
                        className="item"
                        data-testid="dialog-option"
                        data-option-id={o.id}
                        disabled={!running}
                        onClick={() =>
                          handleAction(
                            cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: o.id }, `對話選項：${o.label}`),
                          )
                        }
                      >
                        {o.label}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {state.shop && (
              <div data-testid="shop-panel">
                <h2>{`商店：${state.shop.npcName}`}</h2>
                <div className="row">
                  <span className="k">購買</span>
                  <div className="items">
                    {state.shop.goods.slice(0, 60).map(g => (
                      <button
                        key={g.itemId}
                        type="button"
                        className="item"
                        data-testid="shop-buy"
                        data-item-id={String(g.itemId)}
                        disabled={!running}
                        onClick={() =>
                          handleAction(
                            cmdAction(
                              { type: 'BUY_ITEM', itemId: g.itemId, count: 1 },
                              `買 ${g.name ?? g.itemId} ×1`,
                            ),
                          )
                        }
                      >
                        {`買 ${g.name ?? `#${g.itemId}`}`}
                        <small>{`${g.price} 金`}</small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row">
                  <span className="k">賣出</span>
                  <div className="items">
                    {state.inventory.length === 0 ? (
                      <span className="muted">（背包是空的）</span>
                    ) : (
                      state.inventory.map(it => (
                        <button
                          key={it.itemId}
                          type="button"
                          className="item"
                          data-testid="shop-sell"
                          data-item-id={String(it.itemId)}
                          disabled={!running}
                          onClick={() =>
                            handleAction(
                              cmdAction(
                                { type: 'SELL_ITEM', itemId: it.itemId, count: 1 },
                                `賣 ${it.name ?? it.itemId} ×1`,
                              ),
                            )
                          }
                        >
                          {`賣 ${it.name ?? `#${it.itemId}`} ×${it.count}`}
                        </button>
                      ))
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="item"
                  data-testid="shop-close"
                  disabled={!running}
                  onClick={() =>
                    handleAction(cmdAction({ type: 'CHOOSE_DIALOG_OPTION', optionId: 'CLOSE_SHOP' }, '離開商店'))
                  }
                >
                  離開商店
                </button>
              </div>
            )}

            <div className="muted" data-testid="inventory">
              {`背包：${
                state.inventory.length
                  ? state.inventory.map(i => `${i.name ?? `#${i.itemId}`}×${i.count}`).join('、')
                  : '（空）'
              }`}
            </div>
          </section>

          <section data-testid="scene">
            <h2>{`場景${staleSnap ? '（換圖中，選單為上一張圖的快照）' : ''}`}</h2>
            <div data-testid="scene-title">{sceneTitle}</div>
            {snap ? (
              <>
                {menuSections.map(sec => renderMenuRow(sec.label, sec.items, sec.emptyText))}
                {craftItems.length > 0 && renderMenuRow('製作', craftItems, '（無）')}
                <div className="muted" data-testid="nav-summary">
                  {`可到達地圖：${
                    snap.nav.reachableMaps
                      .slice(0, 12)
                      .map(m => `${m.name ?? m.mapId}（${m.hops}）`)
                      .join('、') || '（無）'
                  }${snap.nav.status === 'UNAVAILABLE' ? '　［僅直接出口：宿主沒有世界目錄］' : ''}`}
                </div>
              </>
            ) : (
              <div className="muted">（尚未收到場景快照）</div>
            )}
          </section>

          <section>
            <h2>文字輸入</h2>
            <form onSubmit={handleSubmit}>
              <input
                type="text"
                placeholder="例如：前往 村長、採集 青銅礦 2、小石 採集 青銅礦 2"
                data-testid="cmd-input"
                autoComplete="off"
                value={inputValue}
                onChange={e => setInputValue(e.currentTarget.value)}
              />
              <button className="item" type="submit">
                送出
              </button>
            </form>
            <div className="err" data-testid="input-error">
              {inputErr}
            </div>
            <div className="muted">{INPUT_HELP}</div>
          </section>
        </div>

        {/* 右欄：工作佇列 + (?dev=1) 除錯對照 + 事件流 */}
        <div className={`col col-feed ${mobileTab !== 'feed' ? 'col-hidden-mobile' : ''}`}>
          <section data-testid="work-queue">
            <h2>工作佇列（FX11）</h2>
            <div
              data-testid="queue-status"
              data-phase={activeQueue.phase}
              data-stop-reason={activeQueue.stopReason ?? undefined}
            >
              {activeQueue.text}
            </div>
            {activeQueue.stopReason && (
              <div className="muted" data-testid="queue-stop-reason">
                {`停止原因：${stopReasonLabel(activeQueue.stopReason)}`}
              </div>
            )}
            {activeQueue.jobs.length > 0 && (
              <div className="muted" data-testid="queue-jobs">
                {activeQueue.jobs
                  .map((j, idx) => {
                    const mark = idx < activeQueue.activeJobIndex ? '✓' : idx === activeQueue.activeJobIndex && activeQueue.phase !== 'IDLE' ? '▶' : '…';
                    const name = j.kind === 'GATHER' ? j.targetName : j.recipeName;
                    const total = j.kind === 'GATHER' && j.targetCount === 'UNTIL_FULL' ? '到滿' : String(j.targetCount);
                    return `${mark} ${name} (${j.doneCount}/${total})`;
                  })
                  .join(' ｜ ')}
              </div>
            )}
            {qActive && (
              <button
                type="button"
                className="item"
                data-testid="queue-stop"
                disabled={!running}
                onClick={() => handleAction({ kind: 'QUEUE_STOP', label: '停止工作佇列' })}
              >
                停止工作
              </button>
            )}
          </section>

          {devMode && (
            <section data-testid="compare-panel">
              <h2>雙向狀態對照（快照 vs 事件追蹤）</h2>
              {!snap || !c || !compareInfo ? (
                <div className="muted" data-testid="compare-status">
                  等待快照中
                </div>
              ) : (
                <div className="char">
                  <span data-testid="compare-snapshot">
                    {`快照：${snap.mapId} (${c.x},${c.y}) 金${c.gold} 袋${compareInfo.snapInv}/${c.inventoryCap ?? 40} 體${c.satiety ?? 100}`}
                  </span>
                  <span data-testid="compare-events">
                    {`事件：${state.eventMirror.mapId ?? '?'} (${state.eventMirror.x ?? '?'},${state.eventMirror.y ?? '?'}) 金${state.eventMirror.gold ?? '?'} 袋${state.eventMirror.inventoryCount ?? '?'}`}
                  </span>
                  <span data-testid="compare-status" data-sync={compareInfo.diffs.length === 0 ? 'OK' : 'DIFF'}>
                    {compareInfo.statusText}
                  </span>
                  <button
                    type="button"
                    className="item"
                    data-testid="compare-refresh"
                    disabled={!running}
                    onClick={() => handleAction(cmdAction({ type: 'REQUEST_SNAPSHOT' }, '重讀快照對照'))}
                  >
                    重讀快照對照
                  </button>
                </div>
              )}
            </section>
          )}

          <section>
            <div className="log-header">
              <h2>{devMode ? '事件日誌（時間／標籤／內容／commandId）' : '事件流'}</h2>
              <div className="log-filters">
                <select
                  aria-label="標籤過濾"
                  data-testid="log-filter-tag"
                  value={tagFilter}
                  onChange={e => setTagFilter(e.currentTarget.value as LogTag | 'ALL')}
                >
                  <option value="ALL">全部標籤</option>
                  {LOG_TAGS.map(t => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="角色過濾"
                  data-testid="log-filter-char"
                  value={charFilter}
                  onChange={e => setCharFilter(e.currentTarget.value)}
                >
                  <option value="ALL">全部角色</option>
                  {charFilterOptions.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div id="log" data-testid="log">
              {collapsedLogs.map(e => (
                <div key={e.id} className={e.level}>
                  {`${fmtTime(e.at)} `}
                  <span className={`tag ${TAG_CLASS[e.tag]}`}>{e.tag}</span>
                  {` ${e.displayText}`}
                  {e.count > 1 && (
                    <span className="log-repeat" data-testid="log-repeat">
                      {` ×${e.count}`}
                    </span>
                  )}
                  {devMode && e.commandId && <span className="cid">{` [${e.commandId}]`}</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 掛載 React 介面並回傳同步重繪方法（維持原本 mountUi 呼叫契約與 select focus 穩定性）。 */
export function mountUi(root: HTMLElement, modeLabel: string, perform: Perform, submit: SubmitText) {
  let reactRoot: Root | null = createRoot(root);
  const strategyRef: React.RefObject<HTMLSelectElement | null> = { current: null };

  function syncStrategySelect(aux: UiAux) {
    const sel = strategyRef.current;
    if (!sel) return;
    const activeEl = root.ownerDocument?.activeElement ?? (typeof document !== 'undefined' ? document.activeElement : null);
    if (activeEl !== sel && sel.value !== aux.strategy) {
      sel.value = aux.strategy;
    }
  }

  function render(s: FamilyState, conn: 'RUNNING' | 'STOPPED', aux: UiAux = NO_AUX) {
    if (!reactRoot) reactRoot = createRoot(root);
    flushSync(() => {
      reactRoot!.render(
        <FamilyApp
          modeLabel={modeLabel}
          state={s}
          conn={conn}
          aux={aux}
          perform={perform}
          submit={submit}
          strategyRef={strategyRef}
        />,
      );
    });
    syncStrategySelect(aux);
  }

  render(initialState(), 'STOPPED');
  return { render };
}
