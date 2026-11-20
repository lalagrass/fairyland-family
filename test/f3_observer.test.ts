import { PROTOCOL_VERSION, type PluginMessage } from '../src/protocol/index';
import { applyMessage, initialState } from '../src/state';
import { observerStatus, showBattleStage } from '../src/render/observer';
import { selectCameraTarget } from '../src/render/extrapolation';
import { createWorld } from './f2_world';
import { assert, done, suite } from './helpers';

// 全部是 f2_world 的虛構資料，沒有任何原版素材。
function stateWith(w: ReturnType<typeof createWorld>) {
  let s = initialState();
  const msg = (m: unknown, now: number) => { s = applyMessage(s, m as PluginMessage, now); };
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's1', seq: 1, mapId: '99001', phase: 'PLAYING', inBattle: false }, 1000);
  msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 2, kind: 'snapshot', seq: 2, reason: 'STARTED', snapshot: w.snapshotFor('char_1') }, 1000);
  return { get s() { return s; }, msg };
}

suite('F3 觀察窗：未連線與沒有快照有明確顯示');
{
  const w = createWorld();
  assert(observerStatus(initialState(), null, 5000).kind === 'OFFLINE', '從沒收到心跳＝宿主未連線');
  const h = stateWith(w);
  assert(observerStatus(h.s, null, 1500).kind === 'OK', '連線且看視角角色：沒有提示');
  assert(observerStatus(h.s, null, 1000 + 60_000).kind === 'OFFLINE', '心跳逾時＝宿主未連線');
  const noSnap = applyMessage(initialState(), { v: PROTOCOL_VERSION, characterId: 'char_1', ts: 1, kind: 'heartbeat', sessionId: 's', seq: 1, mapId: null, phase: 'OPENING', inBattle: false } as PluginMessage, 1000);
  assert(observerStatus(noSnap, null, 1500).kind === 'NO_SNAPSHOT', '有心跳沒快照：等待第一份快照');
}

suite('F3 觀察窗：選定背景角色只換觀察對象（唯讀），並說明看不到的部分');
{
  const w = createWorld();
  const h = stateWith(w);
  const sentBefore = w.sent.length;
  const t = selectCameraTarget(h.s, 'char_2', 1500);
  assert(t?.characterId === 'char_2' && t.name === '小石', '鏡頭對準選定的背景角色');
  assert(observerStatus(h.s, 'char_2', 1500).kind === 'OK', '同地圖的背景角色：直接看得到');
  assert(w.sent.length === sentBefore, '選定角色沒有送出任何指令（唯讀）');
  assert(h.s.characterId === 'char_1', '宿主視角不變');

  // 背景角色換到別張地圖：只剩位置與狀態
  h.msg({ v: PROTOCOL_VERSION, characterId: 'char_2', ts: 3, kind: 'event', seq: 3, event: { type: 'LOCATION_CHANGED', mapId: '99002', mapName: '虛構山丘', fromMapId: '99001', x: 10, y: 20, cause: 'MAP_CHANGE' } }, 1600);
  const other = observerStatus(h.s, 'char_2', 1700);
  assert(other.kind === 'OTHER_MAP' && other.text.includes('虛構山丘'), '背景角色在別張地圖：寫明在哪、為什麼沒有畫面');
  assert(observerStatus(h.s, 'char_none', 1700).kind === 'NO_MEMBER', '選到不存在的角色：說明並可退回');
}

suite('F3 觀察窗：戰鬥畫面只屬於視角角色');
{
  const w = createWorld();
  const h = stateWith(w);
  h.msg({ v: PROTOCOL_VERSION, characterId: 'char_1', ts: 4, kind: 'event', seq: 4, event: { type: 'BATTLE_STARTED', battleId: 5, mapId: '99001', enemies: [{ id: 'e1', name: '虛構史萊姆', level: 1, hp: 10, maxHp: 10 }] } }, 1800);
  assert(h.s.battle !== null, '視角角色進入戰鬥');
  assert(showBattleStage(h.s, null) && showBattleStage(h.s, 'char_1'), '看視角角色：畫戰鬥場景');
  assert(!showBattleStage(h.s, 'char_2'), '改看背景角色：不畫別人的戰鬥，回到地圖');
}

done();
