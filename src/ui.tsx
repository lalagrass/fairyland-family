import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type {
  PluginCommand,
  SnapshotActiveWork,
  SnapshotBattleStatus,
  SnapshotBattleUnitSummary,
} from './protocol/index';
import { APPEARANCE_PROVIDERS } from './render/appearance';
import { MultiGameViewport } from './render/MultiGameViewport';
import type { ViewMode } from './render/viewMode';
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
  notificationsEnabled,
  setNotificationsEnabled,
  requestNotificationPermission,
  type NotificationPermissionState,
} from './notify';
import { INPUT_HELP, type UiAction } from './parse';
import { stopReasonLabel, type QueueStatus } from './queue';
import {
  DEFAULT_CHARACTER_STRATEGY,
  type BagFullPolicy,
  type CharacterStrategyConfig,
} from './automation/strategyStore';
import type { CoordinatorMode } from './automation/types';
import { buildPaletteSuggestions } from './dv6_palette';
import type { QuestChainStatus } from './automation/modules/questChainModule';
import { DEFAULT_CHAIN_CONFIG } from './automation/questPlan';
import { CHAIN_STOP_REASON_LABEL, regionLabel, type ChainStopReason } from './automation/regionPlan';
import type { WelcomeRecapSummary } from './dv7_recap';
import { initialState, type FamilyState, type LogTag } from './state';
import { CharacterStats } from './panels/CharacterStats';
import { ItemColumn } from './panels/ItemColumn';
import { ItemMoveRoot } from './panels/ItemMoveRoot';
import { PanelMark } from './panels/marks';
import { InventoryRules, SkillPriorities } from './panels/TrainingPolicies';
import { SkillPanel } from './panels/SkillPanel';
import { DispatchPanel } from './panels/DispatchPanel';
import type { LaneSummary } from './lanes';
import { WorldMapPanel } from './panels/WorldMapPanel';
import { WineTrainingPanel } from './panels/WineTrainingPanel';
import { WinePathPanel } from './panels/WinePathPanel';
import { WineGatherPanel, createGatherRunner } from './panels/WineGatherPanel';
import { WineBridgeClient } from './wine/wineBridgeClient';
import { pathMapFromSnapshot } from './wine/pathfinding';
import { QuestCards } from './panels/QuestCards';
import { ShopBuyList } from './panels/ShopBuyList';
import { questCardModels } from './panels/questCardModel';
import type { DispatchRecap, DispatchRecord } from './dispatch';
import { worldMapCharacters } from './render/worldMap';

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
  /** F9c：已派給非視角角色、等背景快照的任務。 */
  pendingQuestAssign?: { questId: number; characterId: string } | null;
  pendingQuestAssigns?: Array<{ questId: number; characterId: string }>;
  charStrategies?: Record<string, CharacterStrategyConfig>;
  appearances?: Record<string, string>;
  viewModes?: Record<string, ViewMode>;
  welcomeRecap?: WelcomeRecapSummary | null;
  chain?: QuestChainStatus;
  coordinatorMode?: CoordinatorMode;
  modules?: Array<{ id: string; label: string }>;
  dispatches?: DispatchRecord[];
  dispatchRecaps?: DispatchRecap[];
  /** F8：每位角色的派工通道摘要（目前任務、進度）。 */
  lanes?: LaneSummary[];
  /** W-FamilyUI：供測試注入或外層共享的本機 Wine 橋接客戶端。 */
  wineClient?: WineBridgeClient;
  /** F14：每個角色（含背景 FX17 快照）的獨立狀態池。 */
  characterStates?: Record<string, FamilyState>;
  /** F14：通知控制器目前並排畫面觀看的角色與焦點。 */
  setMultiViewWatch?: (charIds: string[], focusId: string | null) => void;
}

const NO_QUEUE: QueueStatus = { phase: 'IDLE', jobs: [], activeJobIndex: 0, stopReason: null, text: '工作佇列：閒置' };
const NO_AUX: UiAux = {
  nav: { phase: 'IDLE', goal: null, route: [], text: '導航：閒置', skipped: [] },
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

type MobileTab = 'stage' | 'roster' | 'active' | 'feed';

function QuestChainControls({
  running,
  chain,
  regions,
  onAction,
}: {
  running: boolean;
  chain?: QuestChainStatus;
  /** F7：宿主 STATIC_DATA 的區域清單（協定 v7）；沒有就只有「不限區域」。 */
  regions?: ReadonlyArray<{ regionId: string; name: string }>;
  onAction: (action: UiAction) => void;
}) {
  const cfg = chain?.config ?? DEFAULT_CHAIN_CONFIG;
  const stop = cfg.stop;
  const setStop = (patch: QuestChainStatus['config']['stop'], label: string) => {
    onAction({ kind: 'QUEST_CHAIN_CONFIG', patch: { stop: patch }, label });
  };
  const numOrNull = (raw: string): number | null => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return null;
    return n;
  };
  return (
    <div className="chain-form" data-testid="quest-chain-panel">
      <div data-testid="quest-chain-status" data-phase={chain?.phase ?? 'IDLE'} data-stop-reason={chain?.stopReason ?? ''}>
        {chain?.text ?? '無人任務：閒置'}
      </div>
      <button
        type="button"
        className="item"
        data-testid="quest-chain-start"
        disabled={!running || chain?.phase === 'OPENING' || chain?.phase === 'QUESTS' || chain?.phase === 'LOOP'}
        onClick={() => onAction({ kind: 'QUEST_CHAIN_START', label: '開始無人任務鏈' })}
      >
        開始無人任務
      </button>
      <button
        type="button"
        className="item"
        data-testid="quest-chain-stop"
        disabled={!running}
        onClick={() => onAction({ kind: 'QUEST_CHAIN_STOP', label: '停止無人任務' })}
      >
        停止
      </button>
      <button
        type="button"
        className="item"
        data-testid="quest-chain-resume"
        disabled={!running || !chain?.resumable}
        title={chain?.stopReason ? `停工原因：${CHAIN_STOP_REASON_LABEL[chain.stopReason as ChainStopReason] ?? chain.stopReason}` : undefined}
        onClick={() => onAction({ kind: 'QUEST_CHAIN_RESUME', label: '續跑無人任務' })}
      >
        續跑
      </button>
      <label>
        區域
        <select
          data-testid="chain-region"
          value={cfg.regionId ?? ''}
          onChange={e =>
            onAction({
              kind: 'QUEST_CHAIN_CONFIG',
              patch: { regionId: e.currentTarget.value || null },
              label: e.currentTarget.value ? `任務鏈區域：${e.currentTarget.selectedOptions[0]?.textContent ?? e.currentTarget.value}` : '任務鏈區域：不限',
            })
          }
        >
          <option value="">不限區域</option>
          {(regions ?? []).map(r => (
            <option key={r.regionId} value={r.regionId}>{r.name}</option>
          ))}
          {cfg.regionId && !(regions ?? []).some(r => r.regionId === cfg.regionId) && (
            <option value={cfg.regionId}>{`（宿主沒有這個區域：${cfg.regionId}）`}</option>
          )}
        </select>
      </label>
      <label>
        時間(分)
        <input
          type="number"
          min={0}
          data-testid="chain-max-minutes"
          value={stop.maxDurationMs == null ? '' : String(stop.maxDurationMs / 60000)}
          onChange={e => {
            const minutes = numOrNull(e.currentTarget.value);
            setStop({ ...stop, maxDurationMs: minutes == null ? null : Math.round(minutes * 60000) }, '設定停止時間');
          }}
        />
      </label>
      <label>
        等級
        <input
          type="number"
          min={0}
          data-testid="chain-target-level"
          value={stop.targetLevel ?? ''}
          onChange={e => setStop({ ...stop, targetLevel: numOrNull(e.currentTarget.value) }, '設定停止等級')}
        />
      </label>
      <label>
        金錢
        <input
          type="number"
          min={0}
          data-testid="chain-target-gold"
          value={stop.targetGold ?? ''}
          onChange={e => setStop({ ...stop, targetGold: numOrNull(e.currentTarget.value) }, '設定停止金錢')}
        />
      </label>
      <label>
        死亡
        <input
          type="number"
          min={0}
          data-testid="chain-max-deaths"
          value={stop.maxDeaths ?? ''}
          onChange={e => setStop({ ...stop, maxDeaths: numOrNull(e.currentTarget.value) }, '設定死亡上限')}
        />
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="chain-stop-bag"
          checked={stop.stopOnBagFull}
          onChange={e => setStop({ ...stop, stopOnBagFull: e.currentTarget.checked }, '設定背包滿即停')}
        />
        背包滿即停
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="chain-newbie-loop"
          checked={cfg.newbieLoop}
          onChange={e =>
            onAction({
              kind: 'QUEST_CHAIN_CONFIG',
              patch: { newbieLoop: e.currentTarget.checked },
              label: '設定新手循環',
            })
          }
        />
        任務後新手循環
      </label>
      <label>
        循環
        <select
          data-testid="chain-loop-activity"
          value={cfg.loopActivity}
          onChange={e =>
            onAction({
              kind: 'QUEST_CHAIN_CONFIG',
              patch: { loopActivity: e.currentTarget.value as 'HUNT' | 'GATHER' | 'CRAFT' },
              label: '設定循環內容',
            })
          }
        >
          <option value="HUNT">打怪補給</option>
          <option value="GATHER">採集</option>
          <option value="CRAFT">配方</option>
        </select>
      </label>
    </div>
  );
}

function FamilyApp({ modeLabel, state, conn, aux, perform, submit, strategyRef }: AppProps) {
  const [inputValue, setInputValue] = useState('');
  const [inputErr, setInputErr] = useState('');
  const [mobileTab, setMobileTab] = useState<MobileTab>('active');
  const [workbenchTab, setWorkbenchTab] = useState<'overview' | 'skills' | 'inventory' | 'settings' | 'wine' | 'path' | 'gather'>('overview');
  const defaultWineClient = useMemo(() => new WineBridgeClient(), []);
  const wineClient = aux.wineClient ?? defaultWineClient;
  const gatherRunner = useMemo(() => {
    let storage: Storage | null = null;
    try { storage = typeof localStorage === 'undefined' ? null : localStorage; } catch { storage = null; }
    return createGatherRunner(wineClient, storage);
  }, [wineClient]);
  const [watchCharacterId, setWatchCharacterId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [dragJobIdx, setDragJobIdx] = useState<number | null>(null);
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});
  const [tagFilter, changeTagFilter] = useState<LogTag | 'ALL'>(() => {
    try {
      const saved = window.localStorage.getItem('family.log.tag') as LogTag;
      return LOG_TAGS.includes(saved) ? saved : 'ALL';
    } catch { return 'ALL'; }
  });
  const setTagFilter = (value: LogTag | 'ALL') => {
    changeTagFilter(value);
    try { window.localStorage.setItem('family.log.tag', value); } catch { /* memory only */ }
  };
  const [notifyEnabled, setNotifyEnabled] = useState(notificationsEnabled);
  const [charFilter, changeCharFilter] = useState(() => {
    try { return window.localStorage.getItem('family.log.character') ?? 'ALL'; } catch { return 'ALL'; }
  });
  const setCharFilter = (value: string) => {
    changeCharFilter(value);
    try { window.localStorage.setItem('family.log.character', value); } catch { /* memory only */ }
  };
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermissionState>(() => getNotificationPermission());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [dispatchErr, setDispatchErr] = useState('');

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

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setPaletteOpen(prev => !prev);
        setPaletteIdx(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const paletteItems = useMemo(
    () => buildPaletteSuggestions(state, paletteQuery),
    [state, paletteQuery],
  );

  const togglePanel = (key: string) =>
    setExpandedPanels(prev => ({ ...prev, [key]: !prev[key] }));

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
    if (perm === 'granted') { setNotificationsEnabled(true); setNotifyEnabled(true); }
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

  const quests = snap?.quests ?? [];
  const questMembers = useMemo(() => {
    const list = state.members.map(m => ({ characterId: m.characterId, name: m.name }));
    if (state.characterId && !list.some(m => m.characterId === state.characterId)) {
      list.push({ characterId: state.characterId, name: c?.name ?? null });
    }
    return list;
  }, [state.members, state.characterId, c?.name]);
  const questCards = useMemo(() => {
    const names = new Map(questMembers.map(m => [m.characterId, m.name]));
    return questCardModels(snap?.quests, {
      snapshot: snap ?? null,
      viewCharacterId: state.characterId,
      nameOf: id => names.get(id) ?? null,
      activeQuestId: aux.activeQuestId ?? null,
      pendingAssign: aux.pendingQuestAssign ?? null,
      pendingAssigns: aux.pendingQuestAssigns,
      lanes: aux.lanes,
    });
  }, [snap, questMembers, state.characterId, aux.activeQuestId, aux.pendingQuestAssign, aux.pendingQuestAssigns, aux.lanes]);

  const menuSections = useMemo(() => {
    if (!snap) return [];
    return buildMenu(snap, aux.known).filter(
      sec => !((sec.key === 'animals' || sec.key === 'known') && sec.items.length === 0),
    );
  }, [snap, aux.known]);

  const craftItems: MenuItem[] = useMemo(() => {
    const recipes = snap?.recipes ?? state.staticData?.recipes ?? [];
    if (recipes.length === 0) return [];
    const invMap = new Map(state.inventory.map(i => [i.itemId, i.count]));
    const hasAll = (r: (typeof recipes)[number]) =>
      r.ingredients.every(i => i.itemId !== null && (invMap.get(i.itemId) ?? 0) >= i.count);
    const priority = recipes.filter(r => r.recipeId === 20901 || r.recipeId === 40101 || hasAll(r));
    const picked = [...priority, ...recipes.filter(r => !priority.includes(r))].slice(0, 12);
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
  }, [snap?.recipes, state.staticData?.recipes, state.inventory]);

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

  const effectiveWatchId = useMemo(() => {
    if (watchCharacterId && state.members.some(m => m.characterId === watchCharacterId)) {
      return watchCharacterId;
    }
    return state.activeCharacterId ?? snap?.family?.activeCharacterId ?? null;
  }, [watchCharacterId, state.members, state.activeCharacterId, snap?.family?.activeCharacterId]);

  const viewedId = state.characterId;
  const charConfig = (viewedId && aux.charStrategies?.[viewedId]) || DEFAULT_CHARACTER_STRATEGY;
  const saveCharacterPolicy = (patch: Partial<CharacterStrategyConfig>) => {
    if (viewedId) handleAction({ kind: 'CHAR_STRATEGY_UPDATE', characterId: viewedId, patch, label: '更新角色自動化設定' });
  };
  const viewedDispatch = aux.dispatches?.find(record => record.characterId === viewedId);
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
        {state.clockOnly && <span className="pill ok" data-testid="clock-only-pill">時鐘運作中</span>}
        {devMode && <span className="pill warn">開發者模式</span>}
        {devMode && (
          <span className="muted" data-testid="session">
            {state.sessionId ? `session ${state.sessionId.slice(0, 8)}` : ''}
          </span>
        )}
        <div className="header-actions">
          <Dialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="item"
                data-testid="palette-open-btn"
                onClick={() => setPaletteOpen(true)}
              >
                指令面板 (Ctrl+K)
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="radix-dialog-overlay" />
              <Dialog.Content className="radix-dialog-content palette-dialog" data-testid="command-palette">
                <div className="radix-dialog-head">
                  <Dialog.Title>快速指令面板 (Ctrl+K)</Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="item">關閉 (Esc)</button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="muted">
                  方向鍵選取、Tab 自動完成、Enter 直接執行（全程免滑鼠）
                </Dialog.Description>
                <input
                  type="text"
                  autoFocus
                  data-testid="palette-input"
                  placeholder="搜尋：前往 村長、採集 青銅礦、快照、停止工作…"
                  value={paletteQuery}
                  onChange={e => {
                    setPaletteQuery(e.currentTarget.value);
                    setPaletteIdx(0);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPaletteIdx(i => (paletteItems.length ? (i + 1) % paletteItems.length : 0));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPaletteIdx(i =>
                        paletteItems.length ? (i - 1 + paletteItems.length) % paletteItems.length : 0,
                      );
                    } else if (e.key === 'Tab' && paletteItems[paletteIdx]) {
                      e.preventDefault();
                      setPaletteQuery(paletteItems[paletteIdx].commandText);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const chosen = paletteItems[paletteIdx];
                      if (chosen?.action) {
                        handleAction(chosen.action);
                        setPaletteOpen(false);
                        setPaletteQuery('');
                      } else if (paletteQuery.trim()) {
                        const err = submit(paletteQuery.trim());
                        if (!err) {
                          setPaletteOpen(false);
                          setPaletteQuery('');
                        }
                      }
                    }
                  }}
                />
                <div className="palette-list" data-testid="palette-list">
                  {paletteItems.map((it, idx) => (
                    <button
                      key={it.id}
                      type="button"
                      className={`palette-item ${idx === paletteIdx ? 'palette-active' : ''}`}
                      data-testid="palette-item"
                      onClick={() => {
                        if (it.action) handleAction(it.action);
                        else submit(it.commandText);
                        setPaletteOpen(false);
                        setPaletteQuery('');
                      }}
                    >
                      <span className="pill">{it.category}</span>
                      <span>{it.label}</span>
                      <small className="muted">{it.hint}</small>
                    </button>
                  ))}
                  {paletteItems.length === 0 && <div className="muted">找不到符合的指令，按 Enter 直接送出文字指令</div>}
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="item" data-testid="help-dialog-btn">
                說明
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="radix-dialog-overlay" />
              <Dialog.Content className="radix-dialog-content" data-testid="help-dialog-content">
                <div className="radix-dialog-head">
                  <Dialog.Title>童話家族操作說明</Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="item">關閉</button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="muted">
                  指令與多角色觀察說明
                </Dialog.Description>
                <p>{INPUT_HELP}</p>
                <p className="muted">
                  名冊中的「看鏡頭」可單獨移動右側 PixiJS 畫面鏡頭，「切換視角」則會切換宿主端操作中的家族成員。
                </p>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <button
            type="button"
            className={`item ${workbenchTab === 'wine' ? 'tab-active' : ''}`}
            data-testid="header-wine-btn"
            onClick={() => {
              setWorkbenchTab('wine');
              setMobileTab('active');
            }}
          >
            視窗練功
          </button>
          <button
            type="button"
            className={`item ${workbenchTab === 'path' ? 'tab-active' : ''}`}
            data-testid="header-wine-path-btn"
            onClick={() => {
              setWorkbenchTab('path');
              setMobileTab('active');
            }}
          >
            視窗尋路
          </button>
          <button
            type="button"
            className={`item ${workbenchTab === 'gather' ? 'tab-active' : ''}`}
            data-testid="header-wine-gather-btn"
            onClick={() => {
              setWorkbenchTab('gather');
              setMobileTab('active');
            }}
          >
            採集補給
          </button>
          {notifyPerm !== 'unsupported' && (
            <button
              type="button"
              className={`item notify-btn ${notifyPerm === 'granted' ? 'granted' : ''}`}
              data-testid="notify-perm-btn"
              onClick={handleRequestNotify}
            >
              {notifyPerm === 'granted' && notifyEnabled ? '背景通知已開啟' : notifyPerm === 'denied' ? '通知已封鎖' : '開啟背景通知'}
            </button>
          )}
        </div>
      </header>

      {state.members.length > 0 && <nav className="f10-members" aria-label="切換家族角色">
        {state.members.map(member => <button type="button" className="item" key={member.characterId}
          data-testid={`f10-member-${member.characterId}`} aria-pressed={viewedId === member.characterId}
          disabled={!running}
          onClick={() => {
            setWatchCharacterId(null);
            if (member.characterId !== viewedId) handleAction(cmdAction(
              { type: 'SWITCH_VIEW_CHARACTER', characterId: member.characterId }, `切換視角 ${member.name ?? member.characterId}`,
            ));
          }}>{member.name ?? member.characterId}</button>)}
      </nav>}
      <Tabs.Root value={mobileTab} onValueChange={v => setMobileTab(v as MobileTab)}>
        <Tabs.List className="mobile-tabs" data-testid="mobile-tabs" aria-label="手機版分頁切換">
          <Tabs.Trigger
            value="stage"
            className={`item ${mobileTab === 'stage' ? 'tab-active' : ''}`}
            onClick={() => setMobileTab('stage')}
          >
            畫面
          </Tabs.Trigger>
          <Tabs.Trigger
            value="roster"
            className={`item ${mobileTab === 'roster' ? 'tab-active' : ''}`}
            onClick={() => setMobileTab('roster')}
          >
            {`名冊 (${state.members.length})`}
          </Tabs.Trigger>
          <Tabs.Trigger
            value="active"
            className={`item ${mobileTab === 'active' ? 'tab-active' : ''}`}
            onClick={() => setMobileTab('active')}
          >
            目前角色
          </Tabs.Trigger>
          <Tabs.Trigger
            value="feed"
            className={`item ${mobileTab === 'feed' ? 'tab-active' : ''}`}
            onClick={() => setMobileTab('feed')}
          >
            事件流
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      {aux.welcomeRecap && (
        <section className="recap-card" data-testid="welcome-recap-card">
          <div className="recap-head">
            <strong>{`歡迎回來，${aux.welcomeRecap.characterName}（離開 ${aux.welcomeRecap.awayText}）`}</strong>
            <button
              type="button"
              className="item"
              data-testid="welcome-recap-dismiss"
              onClick={() => handleAction({ kind: 'DISMISS_RECAP', label: '收起回來摘要' })}
            >
              收起摘要
            </button>
          </div>
          <div className="char">
            {aux.welcomeRecap.mapTransition && <span>{`位置變化：${aux.welcomeRecap.mapTransition}`}</span>}
            {aux.welcomeRecap.levelDelta !== 0 && (
              <span>{`等級 ${aux.welcomeRecap.levelDelta > 0 ? `+${aux.welcomeRecap.levelDelta}` : aux.welcomeRecap.levelDelta}`}</span>
            )}
            {aux.welcomeRecap.goldDelta !== 0 && (
              <span>{`金錢 ${aux.welcomeRecap.goldDelta > 0 ? `+${aux.welcomeRecap.goldDelta}` : aux.welcomeRecap.goldDelta}`}</span>
            )}
            {aux.welcomeRecap.itemDeltas.map(d => (
              <span key={d.name}>{`${d.name} ${d.delta > 0 ? `+${d.delta}` : d.delta}`}</span>
            ))}
          </div>
          {aux.welcomeRecap.highlights.length > 0 && (
            <div className="muted">{`離線動態：${aux.welcomeRecap.highlights.join(' ｜ ')}`}</div>
          )}
          {aux.welcomeRecap.automation && (
            <div data-testid="automation-recap">
              <div>{`停止原因：${aux.welcomeRecap.automation.stopReason}`}</div>
              <div>{`完成任務：${aux.welcomeRecap.automation.completedQuests.join('、') || '無'}`}</div>
              <div>{`任務獎勵經驗 +${aux.welcomeRecap.automation.questExp}`}</div>
            </div>
          )}
        </section>
      )}

      <div className="layout-grid">
        {/* 中上欄（手機分頁：畫面）：PixiJS 原版＋新外觀畫面（支援 F14 單一／並排切換） */}
        <div className={`col col-stage ${mobileTab !== 'stage' ? 'col-hidden-mobile' : ''}`}>
          <MultiGameViewport
            state={state}
            characterStates={aux.characterStates}
            watchCharacterId={effectiveWatchId}
            onSelectWatchCharacter={id => setWatchCharacterId(id)}
            onSwitchHostCharacter={id => {
              const name = state.members.find(m => m.characterId === id)?.name ?? id;
              setWatchCharacterId(id);
              handleAction(cmdAction({ type: 'SWITCH_VIEW_CHARACTER', characterId: id }, `並排畫面：設為主視角 ${name}`));
            }}
            onWatchChange={aux.setMultiViewWatch}
            appearances={aux.appearances}
            viewModes={aux.viewModes}
            onSetViewMode={(characterId, viewMode) =>
              handleAction({ kind: 'CHAR_VIEWMODE_UPDATE', characterId, viewMode, label: `${characterId} 地圖顯示改為${viewMode === 'modern' ? '現代' : '原版'}` })
            }
            running={running}
          />
          <WorldMapPanel
            graph={state.staticData?.portalGraph ?? null}
            characters={worldMapCharacters(
              state.members,
              state.characterId,
              state.characterId && state.location
                ? { characterId: state.characterId, name: c?.name ?? null, mapId: state.location.mapId }
                : null,
            )}
            route={aux.nav.route}
            running={running}
            onSelectCharacter={id => {
              const name = state.members.find(m => m.characterId === id)?.name ?? id;
              handleAction(cmdAction({ type: 'SWITCH_VIEW_CHARACTER', characterId: id }, `世界地圖：切換視角 ${name}`));
            }}
            onMoveTo={(mapId, name) =>
              handleAction({ kind: 'NAV', goal: { kind: 'MAP', mapId, name }, label: `世界地圖：移動到 ${name}` })
            }
          />
        </div>

        {/* 左欄：家族成員名冊 */}
        <div className={`col col-roster ${mobileTab !== 'roster' ? 'col-hidden-mobile' : ''}`}>
          <section data-testid="family-bar">
            <h2>{`家族成員（${state.members.length}/${maxSlots}）`}</h2>
            {state.members.length === 0 ? (
              <div className="muted">（尚未收到家族成員資料）</div>
            ) : (
              state.members.map(m => {
                const isActive = m.characterId === activeMemberId;
                const isWatched = m.characterId === effectiveWatchId;
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
                        <span data-testid="member-region" data-region-id={m.region?.regionId ?? ''}>{`區域 ${regionLabel(m.region)}`}</span>
                        <span>{`金 ${m.gold}`}</span>
                        <span>{`體 ${m.satiety}`}</span>
                        <span>{`袋 ${m.inventoryCount}/${m.inventoryCap}`}</span>
                        <span className="muted">{qText}</span>
                        <select
                          aria-label={`${m.name ?? m.characterId} 外觀選擇`}
                          data-testid="member-appearance-select"
                          data-character-id={m.characterId}
                          value={aux.appearances?.[m.characterId] ?? 'original'}
                          onChange={e =>
                            handleAction({
                              kind: 'CHAR_APPEARANCE_UPDATE',
                              characterId: m.characterId,
                              appearanceId: e.currentTarget.value,
                              label: `${m.name ?? m.characterId} 外觀改為 ${e.currentTarget.value}`,
                            })
                          }
                        >
                          {APPEARANCE_PROVIDERS.map(p => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={`item ${isWatched ? 'tab-active' : ''}`}
                          data-testid="watch-char-btn"
                          data-character-id={m.characterId}
                          onClick={() => setWatchCharacterId(m.characterId)}
                        >
                          {isWatched ? '鏡頭跟隨中' : '看鏡頭'}
                        </button>
                        {!isActive && (
                          <button
                            type="button"
                            className="item"
                            data-testid="switch-char-btn"
                            data-character-id={m.characterId}
                            disabled={!running}
                            onClick={() => {
                              setWatchCharacterId(m.characterId);
                              handleAction(
                                cmdAction(
                                  { type: 'SWITCH_VIEW_CHARACTER', characterId: m.characterId },
                                  `切換視角 ${m.name ?? m.characterId}`,
                                ),
                              );
                            }}
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
          <DispatchPanel
            members={state.members}
            viewedId={activeMemberId ?? null}
            records={aux.dispatches ?? []}
            recaps={aux.dispatchRecaps ?? []}
            lanes={aux.lanes ?? []}
            gatherPoints={snap?.gatherPoints?.points}
            regions={state.staticData?.regions}
            running={running}
            error={dispatchErr}
            onAssign={(characterId, spec, name) => {
              const err = perform({
                kind: 'DISPATCH_ASSIGN',
                characterId,
                spec,
                label: `派工 ${name}：${spec.kind === 'GATHER' ? `採集 ${spec.gather?.targetName ?? ''}` : spec.kind === 'QUEST_CHAIN' ? '任務鏈' : spec.kind === 'NOVICE_LOOP' ? '新手循環' : '待機'}`,
              });
              setDispatchErr(err ?? '');
            }}
            onView={(characterId, name) => {
              perform({ kind: 'COMMAND', command: { type: 'SWITCH_VIEW_CHARACTER', characterId }, targetCharacterId: characterId, label: `切換觀看 ${name}` });
            }}
            onStop={(characterId, name) => {
              perform({ kind: 'DISPATCH_STOP', characterId, label: `停止派工 ${name}` });
              setDispatchErr('');
            }}
          />
        </div>

        {/* 中欄：目前角色工作台 + 導航 + 任務 + 互動與策略 + 場景選單 + 文字輸入 */}
        <div className={`col col-active ${mobileTab !== 'active' ? 'col-hidden-mobile' : ''}`}>
          <Tabs.Root
            className="character-workbench"
            data-testid="character-workbench"
            value={workbenchTab}
            onValueChange={v => setWorkbenchTab(v as typeof workbenchTab)}
          >
            <div className="workbench-heading">
              <h2>目前角色工作台</h2>
              {c && <span className="muted">{c.name ?? state.characterId}</span>}
            </div>
            <Tabs.List className="workbench-tabs" aria-label="目前角色工作台">
              <Tabs.Trigger value="overview" className="item">總覽</Tabs.Trigger>
              <Tabs.Trigger value="skills" className="item">技能</Tabs.Trigger>
              <Tabs.Trigger value="inventory" className="item">物品欄</Tabs.Trigger>
              <Tabs.Trigger value="settings" className="item">設定</Tabs.Trigger>
              <Tabs.Trigger value="wine" className="item" data-testid="tab-wine">視窗練功</Tabs.Trigger>
              <Tabs.Trigger value="path" className="item" data-testid="tab-wine-path">視窗尋路</Tabs.Trigger>
            </Tabs.List>
            {/* 保留篩選與捲動狀態；未選頁面用 CSS 從視覺和鍵盤動線一起移除。 */}
            <Tabs.Content value="overview" forceMount className="workbench-pane">
              <section data-testid="character">
                <h2><PanelMark kind="character" />角色</h2>
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
                        <span data-testid="region" data-region-id={snap?.region?.regionId ?? ''}>{`區域 ${regionLabel(snap?.region)}`}</span>
                        <span data-testid="f10-map">地圖 {sceneTitle}</span>
                        <span data-testid="f10-dispatch">派工 {viewedDispatch?.text || '閒置'}</span>
                        <span data-testid="pos">{`位置 (${c.x}, ${c.y})`}</span>
                        <span data-testid="satiety">{`飽食 ${c.satiety ?? 100}/${c.maxSatiety ?? 100}`}</span>
                        <span data-testid="bag-cap">{`背包 ${invUsed}/${c.inventoryCap ?? 40}`}</span>
                        {c.ruleset === 'revamp' && c.weaponFamily ? (
                          <span data-testid="mastery">
                            {`武器 ${c.weaponFamily} Lv.${c.familyLevel ?? 1}｜連擊 Lv.${c.comboLevel ?? 1}`}
                          </span>
                        ) : c.className ? (
                          <span data-testid="class-name">{`職業 ${c.className}`}</span>
                        ) : c.weaponFamily ? (
                          <span data-testid="mastery">
                            {`武器 ${c.weaponFamily} Lv.${c.familyLevel ?? 1}｜連擊 Lv.${c.comboLevel ?? 1}`}
                          </span>
                        ) : null}
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
                    <CharacterStats character={c} />
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
            </Tabs.Content>
            <Tabs.Content value="skills" forceMount className="workbench-pane">
              {viewedId && <SkillPriorities skills={state.staticData?.skills ?? []} policy={charConfig.skillPolicy}
                save={skillPolicy => saveCharacterPolicy({ skillPolicy })} />}
              <SkillPanel skills={state.staticData?.skills ?? []} workSkills={c?.workSkills}
                points={snap?.gatherPoints.points} characterName={c?.name ?? viewedId} />
            </Tabs.Content>
            <Tabs.Content value="inventory" forceMount className="workbench-pane">
              <ItemMoveRoot onCommand={(command, label) => handleAction(cmdAction(command, label))}>
                <div className="workbench-inventory">
                  <section data-testid="inventory-panel">
                    <h2><PanelMark kind="bag" />物品欄</h2>
                    <ItemColumn
                      bin="bag"
                      items={state.inventory}
                      running={running}
                      rowTestId="wh-deposit-item"
                      emptyText="背包是空的"
                    />
                  </section>
                  <section data-testid="warehouse-panel">
                    <div className="panel-head-row">
                      <h2><PanelMark kind="warehouse" />家族共用倉庫</h2>
                      {(!wh || (wh.gold === 0 && wh.items.length === 0)) && (
                        <button
                          type="button"
                          className="item panel-toggle-btn"
                          data-testid="toggle-warehouse-panel"
                          onClick={() => togglePanel('warehouse')}
                        >
                          {expandedPanels['warehouse'] ? '收起' : '展開（目前為空）'}
                        </button>
                      )}
                    </div>
                    {(!wh || (wh.gold === 0 && wh.items.length === 0)) && !expandedPanels['warehouse'] ? (
                      <div className="muted panel-collapsed-note" data-testid="collapsed-warehouse-note">
                        倉庫目前為空（已漸進收起）
                      </div>
                    ) : !wh ? (
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
                        <ItemColumn
                          bin="warehouse"
                          items={wh.items}
                          running={running}
                          rowTestId="wh-withdraw-item"
                          emptyText="倉庫物品：空"
                        />
                      </>
                    )}
                  </section>
                </div>
              </ItemMoveRoot>
              {viewedId && <InventoryRules items={state.inventory} policy={charConfig.inventoryPolicy}
                save={inventoryPolicy => saveCharacterPolicy({ inventoryPolicy })} />}
            </Tabs.Content>
            <Tabs.Content value="settings" forceMount className="workbench-pane">
              <section data-testid="f10-system"><h2>系統設定</h2>
                <div className="f10-controls">
                  <label>角色檢視模式<select data-testid="f10-view-mode" disabled={!viewedId}
                    value={(viewedId && aux.viewModes?.[viewedId]) || 'original'}
                    onChange={e => viewedId && handleAction({ kind: 'CHAR_VIEWMODE_UPDATE', characterId: viewedId,
                      viewMode: e.target.value as ViewMode, label: '變更角色檢視模式' })}>
                    <option value="original">原版</option><option value="modern">現代</option>
                  </select></label>
                  <label>事件日誌<select data-testid="f10-log-tag" value={tagFilter}
                    onChange={e => setTagFilter(e.target.value as LogTag | 'ALL')}>
                    <option value="ALL">全部標籤</option>
                    {LOG_TAGS.map(tag => <option key={tag}>{tag}</option>)}
                  </select></label>
                  <label>背景通知<select data-testid="f10-notify" value={notifyEnabled && notifyPerm === 'granted' ? 'on' : 'off'}
                    disabled={notifyPerm === 'unsupported' || notifyPerm === 'denied'} onChange={e => {
                      if (e.currentTarget.value === 'on') void handleRequestNotify();
                      else { setNotificationsEnabled(false); setNotifyEnabled(false); }
                    }}>
                    <option value="off">{notifyPerm === 'unsupported' ? '瀏覽器不支援' : notifyPerm === 'denied' ? '瀏覽器已封鎖' : '關閉'}</option>
                    <option value="on">開啟</option>
                  </select></label>
                </div>
                <div className="f10-queue"><span data-testid="f10-queue-state">角色佇列 · {activeQueue.jobs.length} 件工作 · {
                  activeQueue.persistence === 'saved' ? '已儲存' : activeQueue.persistence === 'error' ? '儲存失敗'
                  : activeQueue.persistence === 'ready' ? '等待儲存' : '記憶體模式'
                }</span><button type="button" className="item" disabled={!viewedId || activeQueue.persistence === 'memory'}
                    onClick={() => handleAction({ kind: 'QUEUE_SAVE', label: '儲存角色佇列' })}>立即儲存</button></div>
              </section>
              {(() => {
                const targetCid = state.characterId;
                if (!targetCid || !c) {
                  return (
                    <section data-testid="char-strategy-panel">
                      <h2>角色策略設定</h2>
                      <p className="muted">收到角色快照後才可調整設定。</p>
                    </section>
                  );
                }
                const charCfg = aux.charStrategies?.[targetCid] ?? DEFAULT_CHARACTER_STRATEGY;
                return (
                  <section data-testid="char-strategy-panel">
                    <h2>{`角色策略設定（${c?.name ?? targetCid}${aux.coordinatorMode ? `｜協調器：${aux.coordinatorMode}` : ''}）`}</h2>
                    <div className="row">
                      <span className="k">低血撤退</span>
                      <select
                        aria-label="低血撤退門檻"
                        data-testid="char-lowhp-select"
                        value={String(charCfg.lowHpRetreatPct)}
                        onChange={e =>
                          handleAction({
                            kind: 'CHAR_STRATEGY_UPDATE',
                            characterId: targetCid,
                            patch: { lowHpRetreatPct: Number(e.currentTarget.value) },
                            label: `${c?.name ?? targetCid} 低血撤退設為 ${e.currentTarget.value}%`,
                          })
                        }
                      >
                        <option value="0">關閉</option>
                        <option value="15">15%</option>
                        <option value="25">25% (預設)</option>
                        <option value="40">40%</option>
                        <option value="60">60%</option>
                      </select>
                      <span className="k">滿包策略</span>
                      <select
                        aria-label="滿包處理方式"
                        data-testid="char-bagfull-select"
                        value={charCfg.bagFullPolicy}
                        onChange={e =>
                          handleAction({
                            kind: 'CHAR_STRATEGY_UPDATE',
                            characterId: targetCid,
                            patch: { bagFullPolicy: e.currentTarget.value as BagFullPolicy },
                            label: `${c?.name ?? targetCid} 滿包策略設為 ${e.currentTarget.value}`,
                          })
                        }
                      >
                        <option value="STOP">停下來</option>
                        <option value="NOTIFY">背景提醒</option>
                        <option value="SELL">提示回店整理</option>
                      </select>
                    </div>
                    <div className="row">
                      <span className="k">低飽食提醒</span>
                      <select
                        aria-label="低飽食休息提醒"
                        data-testid="char-satiety-select"
                        value={String(charCfg.autoRestMinSatiety)}
                        onChange={e =>
                          handleAction({
                            kind: 'CHAR_STRATEGY_UPDATE',
                            characterId: targetCid,
                            patch: { autoRestMinSatiety: Number(e.currentTarget.value) },
                            label: `${c?.name ?? targetCid} 低飽食門檻設為 ${e.currentTarget.value}`,
                          })
                        }
                      >
                        <option value="0">關閉</option>
                        <option value="20">20 以下提醒</option>
                        <option value="40">40 以下提醒</option>
                      </select>
                      {aux.modules && aux.modules.length > 0 && (
                        <span className="muted" data-testid="automation-modules-list">
                          {`模組 ${aux.modules.length} 個`}
                        </span>
                      )}
                    </div>
                  </section>
                );
              })()}
            </Tabs.Content>
            <Tabs.Content value="wine" forceMount className="workbench-pane">
              <WineTrainingPanel client={wineClient} active={workbenchTab === 'wine'} />
            </Tabs.Content>
            <Tabs.Content value="path" forceMount className="workbench-pane">
              <WinePathPanel client={wineClient} active={workbenchTab === 'path'} map={pathMapFromSnapshot(snap)} />
            </Tabs.Content>
            <Tabs.Content value="gather" forceMount className="workbench-pane">
              <WineGatherPanel
                client={wineClient}
                active={workbenchTab === 'gather'}
                runner={gatherRunner}
                strategy={state.characterId && aux.charStrategies?.[state.characterId]
                  ? { inventoryPolicy: aux.charStrategies[state.characterId]!.inventoryPolicy, bagFullPolicy: aux.charStrategies[state.characterId]!.bagFullPolicy }
                  : null}
                current={snap && snap.mapId && Number.isFinite(snap.character?.x) && Number.isFinite(snap.character?.y)
                  ? { mapId: snap.mapId, x: snap.character.x, y: snap.character.y } : null}
              />
            </Tabs.Content>
          </Tabs.Root>

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
            {(aux.nav.skipped?.length ?? 0) > 0 && (
              <ul className="muted" data-testid="nav-skipped">
                {aux.nav.skipped?.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
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
            <QuestChainControls
              running={running}
              chain={aux.chain}
              regions={state.staticData?.regions}
              onAction={handleAction}
            />
            <div className="panel-head-row">
              <h2>任務摘要與自動推進</h2>
              {(!snap || quests.length === 0) && (
                <button
                  type="button"
                  className="item panel-toggle-btn"
                  data-testid="toggle-quest-panel"
                  onClick={() => togglePanel('quest')}
                >
                  {expandedPanels['quest'] ? '收起' : '展開（目前為空）'}
                </button>
              )}
            </div>
            {(!snap || quests.length === 0) && !expandedPanels['quest'] && (!snap?.openingStage || snap.openingStage === 'DONE') ? (
              <div className="muted panel-collapsed-note" data-testid="collapsed-quest-note">
                尚無可顯示的委託（已漸進收起）
              </div>
            ) : !snap ? (
              <div className="muted">（尚未收到任務快照）</div>
            ) : (
              <>
                {snap.openingStage && snap.openingStage !== 'DONE' && (
                  <div className="row" data-testid="opening-stage-badge">
                    <span className="pill warn">{`主線階段：${snap.openingStage}`}</span>
                  </div>
                )}
                {questCards.length === 0 ? (
                  <div className="muted">（目前沒有可用委託清單）</div>
                ) : (
                  <QuestCards
                    cards={questCards}
                    members={questMembers}
                    viewCharacterId={state.characterId}
                    running={running}
                    activeQuestId={aux.activeQuestId ?? null}
                    onGo={card => {
                      if (!card.go) return;
                      handleAction(
                        card.go.kind === 'NPC'
                          ? { kind: 'NAV', goal: { kind: 'NPC', query: card.go.target, talk: true }, label: `前往並對話 ${card.go.name}` }
                          : { kind: 'NAV', goal: { kind: 'MAP', mapId: card.go.target, name: card.go.name }, label: `任務卡片：移動到 ${card.go.name}` },
                      );
                    }}
                    onAuto={card => handleAction({ kind: 'QUEST_AUTO', questId: card.questId, label: `自動處理任務 ${card.title}` })}
                    onAutoStop={card => handleAction({
                      kind: 'QUEST_AUTO_STOP',
                      label: card.owner.characterId ? `停止自動任務（${card.owner.characterId}）` : '停止自動任務',
                      ...(card.owner.characterId ? { targetCharacterId: card.owner.characterId } : {}),
                    })}
                    onAssign={(card, characterId) => {
                      const name = questMembers.find(m => m.characterId === characterId)?.name ?? characterId;
                      handleAction({ kind: 'QUEST_ASSIGN', questId: card.questId, characterId, label: `派任務「${card.title}」給 ${name}` });
                    }}
                  />
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
                  <ShopBuyList
                    goods={state.shop.goods}
                    running={running}
                    onBuy={g => handleAction(cmdAction(
                      { type: 'BUY_ITEM', itemId: g.itemId, count: 1 }, `買 ${g.name ?? g.itemId} ×1`,
                    ))}
                  />
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
            <h2>工作佇列（FX11 / DV8）</h2>
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
            <div className="queue-stop-conds" data-testid="queue-stop-conditions">
              <label className="stage-control">
                <input
                  type="checkbox"
                  data-testid="cond-bag-full"
                  checked={Boolean(activeQueue.stopConditions?.stopOnBagFull)}
                  onChange={e =>
                    handleAction({
                      kind: 'QUEUE_STOP_CONDITIONS',
                      patch: { stopOnBagFull: e.currentTarget.checked },
                      label: `停止條件「背包滿即停」設為 ${e.currentTarget.checked ? '開啟' : '關閉'}`,
                    })
                  }
                />
                <span>滿包即停</span>
              </label>
              <label className="stage-control">
                <span>低飽食停</span>
                <select
                  aria-label="工作佇列低飽食停止條件"
                  data-testid="cond-min-satiety"
                  value={activeQueue.stopConditions?.minSatiety === null || activeQueue.stopConditions?.minSatiety === undefined ? 'off' : String(activeQueue.stopConditions.minSatiety)}
                  onChange={e => {
                    const v = e.currentTarget.value;
                    handleAction({
                      kind: 'QUEUE_STOP_CONDITIONS',
                      patch: { minSatiety: v === 'off' ? null : Number(v) },
                      label: `工作佇列低飽食停止設為 ${v}`,
                    });
                  }}
                >
                  <option value="off">關閉</option>
                  <option value="10">≤ 10</option>
                  <option value="20">≤ 20</option>
                  <option value="35">≤ 35</option>
                </select>
              </label>
            </div>
            {activeQueue.jobs.length > 0 && (
              <div className="queue-cards-list" data-testid="queue-jobs">
                {activeQueue.jobs.map((j, idx) => {
                  const mark =
                    idx < activeQueue.activeJobIndex
                      ? '✓'
                      : idx === activeQueue.activeJobIndex && activeQueue.phase !== 'IDLE'
                        ? '▶'
                        : '…';
                  const name = j.kind === 'GATHER' ? j.targetName : j.recipeName;
                  const total = j.kind === 'GATHER' && j.targetCount === 'UNTIL_FULL' ? '到滿' : String(j.targetCount);
                  return (
                    <div
                      key={j.id}
                      className={`queue-job-card ${idx === activeQueue.activeJobIndex ? 'queue-job-active' : ''}`}
                      data-testid="queue-job-card"
                      draggable
                      onDragStart={() => setDragJobIdx(idx)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => {
                        e.preventDefault();
                        if (dragJobIdx !== null && dragJobIdx !== idx) {
                          handleAction({
                            kind: 'QUEUE_REORDER',
                            fromIndex: dragJobIdx,
                            toIndex: idx,
                            label: `拖曳重排工作 #${dragJobIdx + 1} -> #${idx + 1}`,
                          });
                        }
                        setDragJobIdx(null);
                      }}
                    >
                      <span className="queue-job-title">{`${mark} ${name} (${j.doneCount}/${total})`}</span>
                      <div className="queue-job-actions">
                        <button
                          type="button"
                          className="item"
                          data-testid="queue-job-up"
                          disabled={idx === 0}
                          onClick={() =>
                            handleAction({
                              kind: 'QUEUE_REORDER',
                              fromIndex: idx,
                              toIndex: idx - 1,
                              label: `上移工作 ${name}`,
                            })
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="item"
                          data-testid="queue-job-down"
                          disabled={idx === activeQueue.jobs.length - 1}
                          onClick={() =>
                            handleAction({
                              kind: 'QUEUE_REORDER',
                              fromIndex: idx,
                              toIndex: idx + 1,
                              label: `下移工作 ${name}`,
                            })
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="item"
                          data-testid="queue-job-remove"
                          onClick={() =>
                            handleAction({
                              kind: 'QUEUE_REMOVE',
                              index: idx,
                              label: `移除工作 ${name}`,
                            })
                          }
                        >
                          刪
                        </button>
                      </div>
                    </div>
                  );
                })}
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
