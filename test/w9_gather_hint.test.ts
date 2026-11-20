import { pickGatherPointFromHints, pickQuestGatherForObjective } from '../src/automation/questPlan';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

// 虛構資料：暫代目標描述沒有指名材料，宿主 targetMaps 同時列出三張圖。
const points = [
  { id: 'p-axe', mapId: 'M1', x: 40, y: 35, skillId: 1, skillName: '伐木', materials: [{ itemId: 1, name: '竹子' }] },
  { id: 'p-herb', mapId: 'M1', x: 39, y: 36, skillId: 2, skillName: '採集', materials: [{ itemId: 2, name: '生薑' }] },
];
const obj = {
  description: '替某人跑腿（暫以完成 1 次村內生產採集代替）',
  targetMaps: [
    { mapId: 'M1', x: 40, y: 35 },
    { mapId: 'M2', x: 41, y: 19 },
  ],
};
check('描述沒指名材料時，原本的挑法挑不出來', pickQuestGatherForObjective(obj, points) === null);
const here = pickGatherPointFromHints(obj, points, 'M1');
check('人在提示的地圖上：用提示座標的採集點，不跑去別張圖', here?.point.id === 'p-axe' && here.materialName === '竹子');
check('不在任何提示的地圖上：不挑（由導航前往提示地圖）', pickGatherPointFromHints(obj, points, 'M9') === null);
check('目標有指名材料時不使用提示挑點', pickGatherPointFromHints({ ...obj, itemName: '不存在' }, points, 'M1') === null);
check('來回走不起來：M2 沒有採集點才會轉去別圖', pickGatherPointFromHints(obj, [], 'M2') === null);

if (failed) { console.error(`${failed} 項失敗`); process.exit(1); }
console.log('w9_gather_hint OK');
