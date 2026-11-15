import ex from '../src/protocol/examples.json';
import { isSceneSnapshot, type SceneSnapshot } from '../src/protocol/index';
import fx from '../fixtures/replay_village.json';
import { buildMenu } from '../src/menu';
import { parseInput } from '../src/parse';
import { assert, done, suite } from './helpers';

const snaps = (fx.steps as any[]).filter(s => s.message.kind === 'snapshot').map(s => s.message.snapshot as SceneSnapshot);
const village = snaps[0], town = snaps[1];
assert(isSceneSnapshot(village) && isSceneSnapshot(town), 'fixture snapshots are valid');

suite('scene menu from a real snapshot');
const menu = buildMenu(village);
const sec = (k: string) => menu.find(m => m.key === k)!;
assert(sec('talk').items.length > 10 && sec('talk').items.every(i => i.command?.type === 'TALK_TO_NPC'), '對話：NPC 清單 → TALK_TO_NPC');
assert(sec('talk').items.some(i => i.label === '阿爾') && !sec('talk').items.some(i => i.label.includes('貓')), 'animals are not in the 對話 row');
assert(sec('animals').items.length > 0, 'animals listed separately');
assert(sec('goto').items.length > 3 && sec('goto').items.every(i => i.command?.type === 'WALK_TO'), '前往：出口 → WALK_TO');
const grocery = sec('goto').items.find(i => i.label === '雜貨店')!;
assert((grocery.command as any).mapId === '10001' && typeof (grocery.command as any).x === 'number', 'exit command uses the current map and exit coordinates');
assert(sec('gather').items.length === 0 && sec('gather').emptyText.includes('尚未提供'), '採集：資料不可得時明說，不當成「本區無」');
assert(sec('nearby').items.length === 0 && sec('nearby').emptyText.includes('尚未提供'), '附近可採：同上');
assert(sec('shop').items.length > 0 && sec('shop').items.every(i => i.command?.type === 'BUY_ITEM' && (i.hint ?? '').includes('重建示範資料')), '商店：商品標示重建示範資料');
assert(buildMenu(ex.snapshot.snapshot as SceneSnapshot).length === 6, 'example snapshot builds a menu too');
const townMenu = buildMenu(town);
assert(townMenu.find(m => m.key === 'talk')!.items.some(i => i.label === '村長傑夫'), 'town center menu lists 村長傑夫');

suite('free text -> the same command objects as the menu');
const ok = (t: string, snap = town) => { const r = parseInput(t, snap); return r.ok ? r.command : null; };
const chiefItem = townMenu.find(m => m.key === 'talk')!.items.find(i => i.label === '村長傑夫')!;
assert(JSON.stringify(ok('前往 村長')) === JSON.stringify(chiefItem.command), '前往 村長 == clicking 村長傑夫');
assert(JSON.stringify(ok('對話　村長傑夫')) === JSON.stringify(chiefItem.command), '全形空白也可');
assert(ok('去 村長')?.type === 'TALK_TO_NPC', '去 村長');
const g = parseInput('前往 雜貨店', village);
assert(g.ok && g.command.type === 'WALK_TO' && JSON.stringify(g.command) === JSON.stringify(sec('goto').items.find(i => i.label === '雜貨店')!.command), '前往 <出口名> == clicking the exit');
assert(JSON.stringify(ok('走到 1000 700')) === JSON.stringify({ type: 'WALK_TO', mapId: '20010', x: 1000, y: 700 }), '走到 x y');
assert(JSON.stringify(ok('接任務 1')) === JSON.stringify({ type: 'ACCEPT_QUEST', questId: 1 }), '接任務');
assert(JSON.stringify(ok('買 50001 3')) === JSON.stringify({ type: 'BUY_ITEM', itemId: 50001, count: 3 }), '買 id 數量');
assert(JSON.stringify(ok('賣 100000')) === JSON.stringify({ type: 'SELL_ITEM', itemId: 100000, count: 1 }), '賣 id');
const shopName = village.shops[0].goods.find(x => x.name)!;
assert(parseInput(`買 ${shopName.name}`, village).ok, '買 <商品名稱> resolves through the shop list');
assert(JSON.stringify(ok('工作 4')) === JSON.stringify({ type: 'WORK_ONCE', skillId: 4 }), '工作');
assert(ok('逃跑')?.type === 'BATTLE_FLEE' && ok('快照')?.type === 'REQUEST_SNAPSHOT', '逃跑／快照');
for (const bad of ['', '飛 天上', '走到 abc', '接任務', '前往', '前往 不存在的人', '對話 不存在的人']) {
  assert(!parseInput(bad, town).ok, `rejects "${bad}" with an explanation`);
}
assert(!parseInput('前往 村長', null).ok, 'name lookups need a snapshot');
const ambiguous = parseInput('對話 阿', village);
assert(!ambiguous.ok && ambiguous.error.includes('多個'), 'ambiguous names list candidates');
done();
