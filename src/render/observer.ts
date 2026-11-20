import { connectionStatus, type FamilyState } from '../state';

/**
 * F3 觀察窗：只讀快照與事件，不送任何指令。選定角色（watchCharacterId）只決定「看誰」，
 * 不會切換宿主視角、不搶控制、不動時鐘。這個函式把「現在看得到什麼、看不到什麼」說清楚。
 */
export type ObserverKind =
  | 'OFFLINE' // 宿主沒有連線
  | 'NO_SNAPSHOT' // 還沒收到任何快照
  | 'NO_MEMBER' // 選的角色不在名冊
  | 'OTHER_MAP' // 選定角色在別張地圖：宿主只送視角角色那張圖的場景，這裡沒有該地圖的畫面資料
  | 'BACKGROUND_BATTLE' // 選定角色正在戰鬥，但宿主只把戰鬥畫面資料給視角角色
  | 'OK';

export interface ObserverStatus {
  kind: ObserverKind;
  text: string;
}

export function observerStatus(state: FamilyState, watchCharacterId: string | null, now: number): ObserverStatus {
  if (connectionStatus(state, now) === 'STOPPED') {
    return { kind: 'OFFLINE', text: '宿主未連線：畫面停在最後一份快照，重新連線後會自動更新。' };
  }
  const snap = state.snapshot;
  if (!snap) return { kind: 'NO_SNAPSHOT', text: '已連線，等待第一份場景快照…' };
  const activeId = state.activeCharacterId ?? state.characterId ?? snap.family?.activeCharacterId ?? null;
  const id = watchCharacterId ?? activeId;
  if (!id || id === activeId) return { kind: 'OK', text: '' };
  const m = state.members.find(x => x.characterId === id);
  if (!m) return { kind: 'NO_MEMBER', text: '找不到這個角色，改回視角角色。' };
  if (m.mapId !== snap.mapId) {
    return {
      kind: 'OTHER_MAP',
      text: `【${m.name ?? id}】在「${m.mapName ?? m.mapId}」；宿主目前只送「${snap.mapName}」的場景，沒有那張地圖的畫面資料。這裡只顯示位置與狀態，不會替你切換視角。`,
    };
  }
  if (m.inBattle) {
    return { kind: 'BACKGROUND_BATTLE', text: `【${m.name ?? id}】戰鬥中；戰鬥畫面只有視角角色看得到，這裡顯示它的地圖位置。` };
  }
  return { kind: 'OK', text: '' };
}

/** 戰鬥畫面屬於宿主視角的角色：只有觀察對象就是視角角色時才畫戰鬥場景。 */
export function showBattleStage(state: FamilyState, watchCharacterId: string | null): boolean {
  if (!state.battle) return false;
  const activeId = state.activeCharacterId ?? state.characterId ?? state.snapshot?.family?.activeCharacterId ?? null;
  return !watchCharacterId || !activeId || watchCharacterId === activeId;
}
