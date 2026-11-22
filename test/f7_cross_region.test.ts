/**
 * F7（#48）：跨區任務鏈與循環。假宿主見 f7_world.ts（虛構的兩個區域、四張地圖）。
 * 涵蓋：跨區路徑規劃、途中遇敵後接續、落敗後重新跨區、停工原因碼、續跑，以及總覽顯示區域。
 */
import { assert, done, suite } from './helpers';
import {
  CHAIN_STOP_REASON_LABEL,
  chainStopForQueue,
  isResumable,
  planRegionTravel,
  questsInRegion,
  regionLabel,
  regionOfMapId,
  type ChainStopReason,
} from '../src/automation/regionPlan';
import type { StaticRegion } from '../src/protocol/index';
import { createF7World } from './f7_world';

const RA: StaticRegion = { regionId: 'r-x', name: '甲區', villageMapId: 'x1', mapIds: ['x1', 'x2'] };
const RB: StaticRegion = { regionId: 'r-y', name: '乙區', villageMapId: 'y1', mapIds: ['y1'] };

suite('F7: 區域純函式（全部從宿主資料來，不猜）');
{
  assert(regionOfMapId([RA, RB], 'x2')?.regionId === 'r-x', '地圖對到所屬區域');
  assert(regionOfMapId([RA, RB], 'zz') === null && regionOfMapId([RA, RB], null) === null, '清單裡沒有的地圖是 null');
  assert(regionLabel(null) === '未知' && regionLabel(undefined) === '未知' && regionLabel({ regionId: 'r-x', name: '甲區' }) === '甲區', '沒有區域顯示「未知」');
  const qs = [{ questId: 1, regionId: 'r-x' }, { questId: 2, regionId: 'r-y' }, { questId: 3 }];
  assert(questsInRegion(qs, 'r-y').map(q => q.questId).join() === '2', '只留這一區的任務；沒標區域的不算');
  const here = planRegionTravel([RA, RB], 'r-x', 'r-x');
  const go = planRegionTravel([RA, RB], 'r-x', 'r-y');
  const unknownHere = planRegionTravel([RA, RB], null, 'r-y');
  const gone = planRegionTravel([RA, RB], 'r-x', 'r-gone');
  assert(here.kind === 'HERE', '已在目標區域不跨區');
  assert(go.kind === 'TRAVEL' && go.region.villageMapId === 'y1', '不在目標區域：目的地是宿主給的村莊地圖');
  assert(unknownHere.kind === 'TRAVEL', '目前地圖不在任何區域（null）也會跨區');
  assert(gone.kind === 'UNKNOWN_REGION', '目標區域不在宿主清單裡');
  assert(chainStopForQueue('MISSING_TOOL') === 'MISSING_TOOL' && chainStopForQueue('SHOP_FAILED') === 'MISSING_TOOL', '缺工具／買不到工具 → MISSING_TOOL');
  assert(chainStopForQueue('BAG_FULL') === 'BAG_FULL' && chainStopForQueue('NO_STAMINA') === 'NO_STAMINA' && chainStopForQueue('INSUFFICIENT_GOLD') === 'INSUFFICIENT_GOLD', '背包滿、體力、金錢各有原因碼');
  assert(chainStopForQueue('NAV_FAILED') === 'NAV_FAILED' && chainStopForQueue('UNKNOWN_SKILL') === 'STUCK', '路線走不通 → NAV_FAILED；其他歸 STUCK');
  assert(isResumable('BAG_FULL') && isResumable('MISSING_TOOL') && isResumable('NAV_FAILED') && isResumable('DEATHS'), '背包滿、缺工具、路線、死亡可續跑');
  assert(!isResumable('LEVEL') && !isResumable('QUESTS_DONE') && !isResumable(null), '目標達成或還在跑時不續跑');
  const codes: ChainStopReason[] = ['USER', 'STUCK', 'QUESTS_DONE', 'TIME', 'LEVEL', 'GOLD', 'BAG_FULL', 'DEATHS', 'MISSING_TOOL', 'NO_STAMINA', 'INSUFFICIENT_GOLD', 'NAV_FAILED', 'REGION_UNKNOWN'];
  assert(codes.every(c => CHAIN_STOP_REASON_LABEL[c].length > 0), '每個原因碼都有中文說明');
}

suite('F7: 以區域選任務鏈，跨區走傳送點圖，途中遇敵打完接續，完成第二區任務');
{
  const w = createF7World({ firstRegionDistraction: true });
  w.boot();
  assert(w.state?.snapshot?.region?.regionId === 'r-a' && (w.state?.staticData?.regions.length ?? 0) === 2, '宿主快照帶目前區域，靜態資料帶區域清單');
  assert(w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '選區域', patch: { regionId: 'r-b', newbieLoop: false } }) === null, '可以設定任務鏈區域');
  assert(w.ctrl.chainStatus().config.regionId === 'r-b', '設定寫進任務鏈');
  w.armEncounter('m-a2');
  assert(w.ctrl.perform({ kind: 'QUEST_CHAIN_START', label: '開始' }) === null, '開始無人任務');
  w.advance(500);
  assert(w.ctrl.navStatus().goal?.kind === 'MAP' && (w.ctrl.navStatus().goal as { mapId: string }).mapId === 'm-b1', '人在第一區：先導航到第二區的村莊地圖');
  assert(w.ctrl.navStatus().route.join() === 'm-a2,m-b1', '路線沿傳送點圖跨區（林道 → 第二村）');
  assert(w.until(() => w.log.includes('battle:1'), 10_000), '在林道被暗雷遇敵');
  assert(w.ctrl.chainStatus().text.includes('跨區途中遇敵'), '狀態寫明跨區途中遇敵、戰鬥後接續');
  assert(w.until(() => w.log.includes('battle-end:WIN'), 10_000), '自動戰鬥打贏');
  assert(w.until(() => w.me.mapId === 'm-b1', 20_000), '戰鬥結束後從目前位置接續，抵達第二區');
  assert(w.until(() => w.quests.find(q => q.questId === 8803)?.status === 'COMPLETED', 30_000), '第二區的任務接下並回報完成');
  assert(!w.log.includes('accept:8802'), '第一區的任務沒有被選到');
  assert(w.until(() => w.ctrl.chainStatus().phase === 'STOPPED', 10_000), '區域任務做完後停下（未開循環）');
  assert(w.ctrl.chainStatus().stopReason === 'QUESTS_DONE' && !w.ctrl.chainStatus().resumable, '原因碼 QUESTS_DONE，不提供續跑');
  assert(w.state?.log.some(l => l.text.includes('已抵達 虛構第二區')) ?? false, '日誌寫明抵達第二區');
  assert(w.state?.snapshot?.region?.regionId === 'r-b', '快照區域改成第二區');
}

suite('F7: 跨區途中落敗，送回起點後重新跨區，不把鏈停住');
{
  const w = createF7World();
  w.boot();
  w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '選區域', patch: { regionId: 'r-b', newbieLoop: false } });
  w.armEncounter('m-a2', true);
  w.ctrl.perform({ kind: 'QUEST_CHAIN_START', label: '開始' });
  assert(w.until(() => w.log.includes('battle-end:LOSE'), 15_000), '途中遇敵落敗');
  assert(w.until(() => w.log.filter(l => l === 'map:m-a1').length >= 1, 10_000), '宿主把人送回起始村');
  assert(w.ctrl.chainStatus().phase === 'QUESTS' && w.ctrl.chainStatus().stopReason === null, '一次落敗不停鏈');
  assert(w.until(() => w.me.mapId === 'm-b1', 30_000), '從起始村重新跨區抵達第二區');
  assert(w.until(() => w.quests.find(q => q.questId === 8803)?.status === 'COMPLETED', 30_000), '接著完成第二區任務');
}

suite('F7: 跨區路線走不通 → NAV_FAILED，修好傳送點圖後續跑');
{
  const w = createF7World({ brokenBridge: true });
  w.boot();
  w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '選區域', patch: { regionId: 'r-b', newbieLoop: false } });
  w.ctrl.perform({ kind: 'QUEST_CHAIN_START', label: '開始' });
  assert(w.until(() => w.ctrl.chainStatus().phase === 'STOPPED', 15_000), '走不通時停下，不空轉');
  const st = w.ctrl.chainStatus();
  assert(st.stopReason === 'NAV_FAILED' && st.resumable, '原因碼 NAV_FAILED，可續跑');
  assert(st.text.includes('虛構第二區'), '停工文字寫明要去的區域');
  w.fixBridge();
  w.advance(500);
  assert(w.ctrl.perform({ kind: 'QUEST_CHAIN_RESUME', label: '續跑' }) === null, '傳送點圖修好後可以續跑');
  assert(w.until(() => w.quests.find(q => q.questId === 8803)?.status === 'COMPLETED', 40_000), '續跑後跨區完成任務');
  assert(w.ctrl.perform({ kind: 'QUEST_CHAIN_RESUME', label: '再續跑' }) !== null, '執行中或目標達成時不能續跑');
}

suite('F7: 設定的區域不在宿主清單 → REGION_UNKNOWN');
{
  const w = createF7World();
  w.boot();
  w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '選區域', patch: { regionId: 'r-gone' } });
  w.ctrl.perform({ kind: 'QUEST_CHAIN_START', label: '開始' });
  w.advance(500);
  assert(w.ctrl.chainStatus().stopReason === 'REGION_UNKNOWN', '原因碼 REGION_UNKNOWN');
  assert(w.sent.every(m => m.command.type !== 'WALK_TO'), '不亂走');
  w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '不限區域', patch: { regionId: null } });
  assert(w.ctrl.chainStatus().config.regionId === null, '可以改回不限區域');
}

suite('F7: 任務做完後在第二區採集循環；缺工具停工（MISSING_TOOL），補了工具續跑；背包滿停工（BAG_FULL）');
{
  const w = createF7World({ secondRegionQuest: false, requireTool: true, bagCap: 3 });
  w.boot();
  w.ctrl.perform({ kind: 'QUEST_CHAIN_CONFIG', label: '設定', patch: { regionId: 'r-b', newbieLoop: true, loopActivity: 'GATHER', stop: { stopOnBagFull: true } } });
  w.ctrl.perform({ kind: 'QUEST_CHAIN_START', label: '開始' });
  assert(w.until(() => w.me.mapId === 'm-b1', 20_000), '循環區域不在這裡：先跨區到第二區');
  assert(w.until(() => w.ctrl.chainStatus().phase === 'STOPPED', 40_000), '採集遇到缺工具就停下');
  const miss = w.ctrl.chainStatus();
  assert(miss.stopReason === 'MISSING_TOOL' && miss.resumable, `原因碼 MISSING_TOOL，可續跑（實際 ${miss.stopReason}：${miss.text}）`);
  assert(w.state?.snapshot?.region?.regionId === 'r-b', '停在第二區，不跑回第一區');
  w.giveTool();
  w.advance(300);
  assert(w.ctrl.perform({ kind: 'QUEST_CHAIN_RESUME', label: '續跑' }) === null, '補了工具可以續跑');
  assert(w.until(() => w.log.includes('gather'), 20_000), '續跑後真的開始採集（舊的停止原因不再擋住）');
  assert(w.until(() => w.ctrl.chainStatus().phase === 'STOPPED', 40_000), '背包滿後停下');
  assert(w.ctrl.chainStatus().stopReason === 'BAG_FULL' && w.ctrl.chainStatus().resumable, '原因碼 BAG_FULL，可續跑');
}

suite('F7: 總覽顯示每個角色目前所在區域（宿主沒給就是未知）');
{
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'http://localhost:5173/family/' });
  Object.assign(globalThis, {
    window: win,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    localStorage: win.localStorage,
  });
  const { mountUi } = await import('../src/ui');
  const { applyMessage, initialState } = await import('../src/state');
  const { PROTOCOL_VERSION } = await import('../src/protocol/index');
  const ex = (await import('../src/protocol/examples.json')).default;
  const root = win.document.createElement('div');
  win.document.body.appendChild(root);
  const ui = mountUi(root as unknown as HTMLElement, 'TEST', () => null, () => null);
  let s = applyMessage(initialState(), { v: PROTOCOL_VERSION, characterId: 'c1', ts: 1, kind: 'heartbeat', sessionId: 's', seq: 1, mapId: 'm-b1', phase: 'PLAYING', inBattle: false }, 10);
  const sd = JSON.parse(JSON.stringify(ex.staticData));
  sd.staticData.regions = [RA, RB];
  s = applyMessage(s, sd, 11);
  const snap = JSON.parse(JSON.stringify(ex.snapshot));
  snap.characterId = 'c1';
  snap.snapshot.region = { regionId: 'r-y', name: '乙區' };
  const member = (id: string, region: unknown) => ({
    characterId: id, name: id, level: 1, mapId: 'm', mapName: '某圖', region, x: 0, y: 0, gold: 0, satiety: 100,
    inventoryCount: 0, inventoryCap: 40, inBattle: false, inventory: [], workSkills: {},
  });
  snap.snapshot.family = { activeCharacterId: 'c1', maxSlots: 5, warehouse: { gold: 0, cap: 200, items: [] }, members: [member('c1', { regionId: 'r-y', name: '乙區' }), member('c2', null)] };
  s = applyMessage(s, snap, 20);
  ui.render(s, 'RUNNING', { nav: { phase: 'IDLE', goal: null, route: [], text: '閒置' }, strategy: 'MANUAL', known: [], devMode: false });
  await new Promise(r => setTimeout(r, 20));
  const cells = [...root.querySelectorAll('[data-testid="member-region"]')].map(e => e.textContent);
  assert(cells.length === 2 && cells[0] === '區域 乙區' && cells[1] === '區域 未知', '名冊每人顯示區域，宿主給 null 的顯示未知');
  assert(root.querySelector('[data-testid="region"]')?.textContent === '區域 乙區', '角色總覽顯示目前區域');
  const opts = [...root.querySelectorAll('[data-testid="chain-region"] option')].map(o => o.textContent);
  assert(opts.join('|') === '不限區域|甲區|乙區', '任務鏈的區域選單來自宿主的區域清單');
  assert((root.querySelector('[data-testid="quest-chain-resume"]') as HTMLButtonElement | null)?.disabled === true, '沒有可續跑的停工時續跑鍵停用');
}

done();
