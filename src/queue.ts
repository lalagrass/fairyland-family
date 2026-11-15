import type { SceneSnapshot } from './protocol/index';
import {
  WORK_DATA, findGatherItems, findRecipes, gatherPointsFor, itemNameOf, recipeOf, stationFor, vendorsFor,
  type WdGatherPoint, type WorkTypeName,
} from './workdata';

/**
 * 每個角色一份的行動佇列（存在 localStorage，關掉頁籤再開還在）。
 * 佇列只是「要做什麼」的清單；實際的走路、買東西、WORK_ONCE 都由 QueueRunner 轉成與滑鼠相同的協定指令。
 */

/** 工作步驟的停止條件。BAG_FULL＝背包滿；COUNT＝成功 n 次；HAVE＝背包裡該道具達 n；MATERIAL＝做到缺料為止；TOOL＝做到工具壞為止；MANUAL＝手動停止。 */
export type StopCond =
  | { kind: 'BAG_FULL' }
  | { kind: 'COUNT'; n: number }
  | { kind: 'HAVE'; itemId: number; n: number }
  | { kind: 'MATERIAL' }
  | { kind: 'TOOL' }
  | { kind: 'MANUAL' };

export type QStep =
  | { id: string; kind: 'GOTO_NPC'; query: string; mapId: string | null; label: string }
  | { id: string; kind: 'GOTO_MAP'; mapId: string; name: string; label: string }
  | { id: string; kind: 'GOTO_POINT'; mapId: string; x: number; y: number; reach: number; name: string; label: string }
  /** 到 NPC 那裡開商店買東西；target＝買完後背包該有的數量（重送也不會多買）。 */
  | { id: string; kind: 'BUY'; npcName: string; mapId: string | null; itemId: number; itemName: string; count: number; price: number; target: number; label: string }
  | { id: string; kind: 'WORK'; workType: WorkTypeName; targetId: string; name: string; until: StopCond; done: number; attempts: number; label: string };

/** 規劃出來、還沒有 id 的步驟。 */
export type NewStep =
  | Omit<Extract<QStep, { kind: 'GOTO_NPC' }>, 'id'> | Omit<Extract<QStep, { kind: 'GOTO_MAP' }>, 'id'> | Omit<Extract<QStep, { kind: 'GOTO_POINT' }>, 'id'>
  | Omit<Extract<QStep, { kind: 'BUY' }>, 'id'> | Omit<Extract<QStep, { kind: 'WORK' }>, 'id'>;

export type RunStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'DONE';

export interface WorkLogEntry { at: number; stepId: string | null; kind: 'RESULT' | 'STOP' | 'INFO'; text: string }

export interface QueueState {
  v: 1;
  characterId: string;
  /** 指令 id 前綴（每份佇列固定；重送同一個工作用同一個 id 才不會重複結算）。 */
  qid: string;
  seq: number;
  steps: QStep[];
  cursor: number;
  run: RunStatus;
  /** 暫停或停止的原因（顯示在畫面上）。 */
  reason: string | null;
  /** 已送出、還沒收到結果的 WORK_ONCE（重開頁面後用它對照宿主快照，避免重複送）。 */
  pendingWork: { commandId: string; stepId: string; sentAt: number } | null;
  log: WorkLogEntry[];
}

export const LOG_LIMIT = 80;
const KEY = (characterId: string) => `family.queue.v1.${characterId}`;

interface KvStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function emptyQueue(characterId: string, qid?: string): QueueState {
  return { v: 1, characterId, qid: qid ?? `q${Math.random().toString(36).slice(2, 7)}`, seq: 0, steps: [], cursor: 0, run: 'IDLE', reason: null, pendingWork: null, log: [] };
}

export function loadQueue(storage: KvStorage | null, characterId: string): QueueState {
  try {
    const raw = storage?.getItem(KEY(characterId));
    if (raw) {
      const q = JSON.parse(raw) as QueueState;
      if (q && q.v === 1 && q.characterId === characterId && Array.isArray(q.steps)) return q;
    }
  } catch { /* 壞掉的存檔視為沒有 */ }
  return emptyQueue(characterId);
}

export function saveQueue(storage: KvStorage | null, q: QueueState): void {
  try { storage?.setItem(KEY(q.characterId), JSON.stringify(q)); } catch { /* 無法儲存不影響功能 */ }
}

export function appendSteps(q: QueueState, steps: NewStep[]): QueueState {
  let seq = q.seq;
  const added = steps.map(s => ({ ...s, id: `s${++seq}` }) as QStep);
  // 佇列已跑完就從頭算起：把已完成的舊步驟收掉，畫面不會越堆越長。
  const base = q.run === 'DONE' || q.cursor >= q.steps.length ? { ...q, steps: [], cursor: 0, run: 'IDLE' as RunStatus, reason: null } : q;
  return { ...base, seq, steps: [...base.steps, ...added] };
}

/** 刪除／移動的限制：正在執行的那一步不能動（要先暫停）。回傳新佇列或錯誤文字。 */
export function removeStep(q: QueueState, index: number): QueueState | string {
  if (index < 0 || index >= q.steps.length) return `沒有第 ${index + 1} 步`;
  if (q.run === 'RUNNING' && index === q.cursor) return '這一步正在執行，請先暫停再刪除';
  return { ...q, steps: q.steps.filter((_, i) => i !== index), cursor: index < q.cursor ? q.cursor - 1 : q.cursor };
}

export function moveStep(q: QueueState, index: number, delta: -1 | 1): QueueState | string {
  const to = index + delta;
  if (index < 0 || index >= q.steps.length) return `沒有第 ${index + 1} 步`;
  if (to < 0 || to >= q.steps.length) return '已經在最' + (delta < 0 ? '前' : '後') + '面';
  if (index < q.cursor || to < q.cursor) return '已完成的步驟不能移動';
  if (q.run === 'RUNNING' && (index === q.cursor || to === q.cursor)) return '這一步正在執行，請先暫停再移動';
  const steps = [...q.steps];
  [steps[index], steps[to]] = [steps[to], steps[index]];
  return { ...q, steps };
}

export function stopText(c: StopCond): string {
  switch (c.kind) {
    case 'BAG_FULL': return '直到背包滿';
    case 'COUNT': return `${c.n} 次`;
    case 'HAVE': return `直到有 ${c.n} 個 ${itemNameOf(c.itemId)}`;
    case 'MATERIAL': return '直到缺料';
    case 'TOOL': return '直到工具壞';
    case 'MANUAL': return '直到手動停止';
  }
}

export function stepText(s: QStep): string {
  return s.kind === 'WORK' ? `${s.label}${s.done ? `（已 ${s.done} 次）` : ''}` : s.label;
}

// ---------------------------------------------------------------- 規劃

export type PlanRequest =
  | { workType: 'GATHER'; itemId: number; until: StopCond }
  | { workType: 'SMELT' | 'FORGE' | 'CRAFT'; productId: number; count: number };

export interface PlanContext {
  snapshot: SceneSnapshot | null;
  gold: number | null;
  inventory: Array<{ itemId: number; count: number }>;
  /** 現在所在地圖（事件追蹤的位置，比快照新）。 */
  mapId: string | null;
  mapName: (mapId: string) => string | null;
}

export type PlanResult =
  | { ok: true; steps: NewStep[]; summary: string; /** 需要使用者確認的問句（含花錢）；null＝可直接排入。 */ confirm: string | null; notes: string[] }
  | { ok: false; error: string };

const fail = (error: string): PlanResult => ({ ok: false, error });

function workLabel(workType: WorkTypeName, name: string, until: StopCond): string {
  const verb = workType === 'GATHER' ? '採集' : workType === 'SMELT' ? '冶煉' : workType === 'FORGE' ? '鍛造' : '製作';
  return `${verb} ${name}（${stopText(until)}）`;
}

/** 同一張圖優先，其次依座標由近到遠。 */
function nearestPoint(points: WdGatherPoint[], ctx: PlanContext): WdGatherPoint {
  const here = ctx.mapId ?? ctx.snapshot?.mapId ?? null;
  const c = ctx.snapshot?.character;
  return [...points].sort((a, b) => {
    const am = a.mapId === here ? 0 : 1, bm = b.mapId === here ? 0 : 1;
    if (am !== bm) return am - bm;
    return c ? Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y) : 0;
  })[0];
}

const have = (ctx: PlanContext, itemId: number) => ctx.inventory.filter(i => i.itemId === itemId).reduce((n, i) => n + i.count, 0);

/**
 * 組合規劃：缺工具就先排「去買」，缺原料就先排「去採」，最後到站點冶煉／鍛造。
 * 錢不夠、商店沒有、等級不夠、查不到資料都明確說明（回 ok:false），不會偷偷排出做不到的佇列。
 */
export function planWork(req: PlanRequest, ctx: PlanContext): PlanResult {
  const buys: NewStep[] = [];
  const body: NewStep[] = [];
  const notes: string[] = [];
  let spend = 0;
  const toolPlanned = new Set<number>();
  const stock = new Map<number, number>();
  const stockOf = (id: number) => stock.get(id) ?? have(ctx, id);
  const snap = ctx.snapshot;

  /** 需要的工具：持有就算了；不然排一次購買（先檢查有販售處、本圖商店有貨、錢夠）。 */
  const needTool = (toolItemId: number | null): string | null => {
    if (toolItemId === null || toolPlanned.has(toolItemId)) return null;
    if (have(ctx, toolItemId) > 0 || snap?.work.tools.some(t => t.itemId === toolItemId && t.count > 0)) return null;
    const name = itemNameOf(toolItemId);
    const vendors = vendorsFor(toolItemId);
    if (!vendors.length) return `缺少工具「${name}」，而且資料裡沒有任何地方販售（要自己想辦法取得）`;
    const here = ctx.mapId ?? snap?.mapId ?? null;
    const v = vendors.find(x => x.mapId === here) ?? vendors[0];
    if (snap && v.mapId === snap.mapId) {
      const goods = snap.shops.flatMap(s => s.goods);
      if (goods.length && !goods.some(g => g.itemId === toolItemId)) return `「${v.npcName}」目前的商品清單裡沒有「${name}」（無庫存／不賣）`;
    }
    spend += v.price;
    if (ctx.gold !== null && ctx.gold < spend) return `金錢不夠：買「${name}」要 ${v.price} 金${spend > v.price ? `（累計 ${spend} 金）` : ''}，目前只有 ${ctx.gold} 金`;
    toolPlanned.add(toolItemId);
    buys.push({
      kind: 'BUY', npcName: v.npcName, mapId: v.mapId, itemId: toolItemId, itemName: name, count: 1, price: v.price, target: have(ctx, toolItemId) + 1,
      label: `去 ${v.npcName}（${ctx.mapName(v.mapId) ?? v.mapId}）買 ${name}（${v.price} 金）`,
    });
    notes.push(`要去 ${v.npcName} 買「${name}」${v.price} 金（現有 ${ctx.gold ?? '?'} 金）`);
    return null;
  };

  const gatherSteps = (itemId: number, until: StopCond): string | null => {
    const points = gatherPointsFor(itemId);
    if (!points.length) return `沒有「${itemNameOf(itemId)}」的採集點資料（見客戶端找不到清單）`;
    const p = nearestPoint(points, ctx);
    const err = needTool(p.toolItemId);
    if (err) return err;
    const mapLabel = ctx.mapName(p.mapId) ?? p.mapId;
    body.push({ kind: 'GOTO_POINT', mapId: p.mapId, x: p.x, y: p.y, reach: WORK_DATA.rules.gatherReach - 40, name: p.name, label: `前往 ${p.name}（${mapLabel}）` });
    body.push({ kind: 'WORK', workType: 'GATHER', targetId: p.id, name: itemNameOf(itemId), until, done: 0, attempts: 0, label: workLabel('GATHER', itemNameOf(itemId), until) });
    return null;
  };

  if (req.workType === 'GATHER') {
    const err = gatherSteps(req.itemId, req.until);
    if (err) return fail(err);
  } else {
    const rec = recipeOf(req.productId);
    if (!rec || !rec.workType) return fail(`「${itemNameOf(req.productId)}」沒有可執行的配方資料`);
    const level = snap?.work.skillLevels?.[String(rec.skillId)] ?? 1;
    if (rec.reqLevel !== null && level < rec.reqLevel) return fail(`技能等級不夠：做「${rec.name}」需要等級 ${rec.reqLevel}，目前 ${level}`);
    const rawNeed = new Map<number, number>();
    const crafts: Array<{ productId: number; runs: number }> = [];
    let problem: string | null = null;
    const expand = (itemId: number, qty: number, depth: number): void => {
      if (problem) return;
      const h = stockOf(itemId);
      const use = Math.min(h, qty);
      stock.set(itemId, h - use);
      qty -= use;
      if (qty <= 0) return;
      if (gatherPointsFor(itemId).length) { rawNeed.set(itemId, (rawNeed.get(itemId) ?? 0) + qty); return; }
      const sub = recipeOf(itemId);
      if (!sub || depth >= 3) { problem = `缺少「${itemNameOf(itemId)}」×${qty}：沒有採集點資料，也沒有可製作的配方`; return; }
      for (const ing of sub.ingredients) expand(ing.itemId, ing.count * qty, depth + 1);
      const ex = crafts.find(c => c.productId === itemId);
      if (ex) ex.runs += qty; else crafts.push({ productId: itemId, runs: qty });
    };
    for (const ing of rec.ingredients) expand(ing.itemId, ing.count * req.count, 0);
    if (problem) return fail(problem);
    for (const [itemId, need] of rawNeed) {
      const err = gatherSteps(itemId, { kind: 'HAVE', itemId, n: have(ctx, itemId) + need });
      if (err) return fail(err);
    }
    crafts.push({ productId: rec.productId, runs: req.count });
    let lastStation: string | null = null;
    for (const c of crafts) {
      const r = recipeOf(c.productId)!;
      const wt = (r.workType ?? 'CRAFT') as WorkTypeName;
      const err = needTool(r.toolItemId);
      if (err) return fail(err);
      const st = stationFor(wt);
      if (r.stationKind && !st) return fail(`「${r.name}」要在「${r.stationKind}」站點製作，但資料裡沒有這種站點`);
      if (st && st.id !== lastStation) {
        body.push({ kind: 'GOTO_POINT', mapId: st.mapId, x: st.x, y: st.y, reach: WORK_DATA.rules.stationReach - 40, name: st.name, label: `前往 ${st.name}（${ctx.mapName(st.mapId) ?? st.mapId}）` });
        lastStation = st.id;
      }
      const until: StopCond = { kind: 'COUNT', n: c.runs };
      body.push({ kind: 'WORK', workType: wt, targetId: String(c.productId), name: r.name, until, done: 0, attempts: 0, label: workLabel(wt, r.name, until) });
    }
  }

  const steps = [...buys, ...body];
  const summary = steps.map(s => s.label).join(' → ');
  const confirm = buys.length
    ? `${notes.join('；')}。${req.workType === 'GATHER' ? `先去買工具再過去${workLabel('GATHER', itemNameOf(req.itemId), req.until)}` : `先買好工具再開始製作 ${itemNameOf(req.productId)}`}？`
    : null;
  return { ok: true, steps, summary, confirm, notes };
}

// ---------------------------------------------------------------- 文字解析（自由輸入 → 規劃請求）

const GATHER_VERBS = new Set(['採礦', '挖礦', '採集', '採', '伐木', '砍樹', 'gather']);
const CRAFT_VERBS: Record<string, 'SMELT' | 'FORGE' | 'CRAFT'> = { '冶煉': 'SMELT', '煉': 'SMELT', smelt: 'SMELT', '鍛造': 'FORGE', '打造': 'FORGE', forge: 'FORGE', '製作': 'CRAFT', '製造': 'CRAFT', craft: 'CRAFT' };

export const isWorkVerb = (v: string) => GATHER_VERBS.has(v) || v in CRAFT_VERBS;

/** 「銅礦石 直到 背包滿」「煤 10 次」「青銅塊 3」→ 名稱＋停止條件原文。 */
function splitTail(rest: string): { name: string; cond: string | null; n: number | null } {
  const m = /^(.*?)\s+(?:直到|到|until)\s*(.+)$/.exec(rest);
  if (m) return { name: m[1].trim(), cond: m[2].trim(), n: null };
  const k = /^(.*?)\s*[x×*]?\s*(\d+)\s*(?:次|個|个|份)?$/.exec(rest);
  if (k && k[1].trim()) return { name: k[1].trim(), cond: null, n: Number(k[2]) };
  return { name: rest.trim(), cond: null, n: null };
}

export function parseStopCond(cond: string | null, n: number | null, fallback: StopCond): { ok: true; until: StopCond } | { ok: false; error: string } {
  if (cond) {
    const c = cond.replace(/\s+/g, '');
    if (/背包(滿|满)|滿了|裝滿|bagfull|full/i.test(c)) return { ok: true, until: { kind: 'BAG_FULL' } };
    if (/缺料|沒料|沒材料|缺材料|材料(用完|不足)/.test(c)) return { ok: true, until: { kind: 'MATERIAL' } };
    if (/工具(壞|損|毀)|壞掉|斷/.test(c)) return { ok: true, until: { kind: 'TOOL' } };
    if (/手動|停止|stop|一直/.test(c)) return { ok: true, until: { kind: 'MANUAL' } };
    const k = /^(\d+)(?:次|個|个)?$/.exec(c);
    if (k && Number(k[1]) > 0) return { ok: true, until: { kind: 'COUNT', n: Number(k[1]) } };
    return { ok: false, error: `看不懂停止條件「${cond}」（可用：背包滿｜缺料｜工具壞｜手動停止｜N 次）` };
  }
  if (n !== null) return n > 0 ? { ok: true, until: { kind: 'COUNT', n } } : { ok: false, error: '次數要大於 0' };
  return { ok: true, until: fallback };
}

/** 解析採集／冶煉／鍛造／製作；回傳規劃請求或錯誤文字。 */
export function parseWorkText(verb: string, rest: string): { ok: true; req: PlanRequest } | { ok: false; error: string } {
  if (!rest.trim()) return { ok: false, error: `用法：${verb} <名稱> [直到 背包滿｜缺料｜工具壞｜手動停止｜N 次]` };
  const { name, cond, n } = splitTail(rest);
  if (GATHER_VERBS.has(verb)) {
    const hits = findGatherItems(name);
    if (!hits.length) return { ok: false, error: `沒有「${name}」的採集點資料（可採：${Object.values(Object.fromEntries(findGatherItems('').map(h => [h.itemId, h.name]))).join('、') || '無'}）` };
    if (hits.length > 1) return { ok: false, error: `有多個符合「${name}」：${hits.map(h => h.name).join('、')}，請輸入更完整的名稱` };
    const u = parseStopCond(cond, n, { kind: 'COUNT', n: 1 });
    if (!u.ok) return u;
    const until = u.until.kind === 'MATERIAL' ? { kind: 'MANUAL' as const } : u.until;
    return { ok: true, req: { workType: 'GATHER', itemId: hits[0].itemId, until } };
  }
  const workType = CRAFT_VERBS[verb];
  const hits = findRecipes(name, workType === 'CRAFT' ? undefined : workType);
  if (!hits.length) return { ok: false, error: `沒有可${verb}「${name}」的配方資料` };
  if (hits.length > 1) return { ok: false, error: `有多個符合「${name}」：${hits.slice(0, 6).map(h => h.name).join('、')}${hits.length > 6 ? '…' : ''}，請輸入更完整的名稱` };
  const u = parseStopCond(cond, n, { kind: 'COUNT', n: 1 });
  if (!u.ok) return u;
  if (u.until.kind !== 'COUNT') return { ok: false, error: `${verb}只支援次數（例如：${verb} ${hits[0].name} 3 次）；原料不夠時會自動排入採集` };
  return { ok: true, req: { workType: hits[0].workType ?? workType, productId: hits[0].productId, count: u.until.n } as PlanRequest };
}
