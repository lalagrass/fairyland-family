import raw from './data/work_data.json';

/**
 * 工作資料（材料、配方、採集點、工具、站點、販售處）：由 fairyland 單一來源複製（npm run sync-protocol），不可手改。
 * 每個欄位的來源標記（ORIGINAL_EXTRACTED／RECONSTRUCTED_DEMO／CUSTOM）見 work_data.json 的 fieldSources；
 * 「客戶端找不到」的清單見 fairyland 的 docs/data/WORK_DATA_MISSING.md。外掛用這份資料規劃佇列，實際能不能做仍以宿主的檢核為準。
 */
export type WorkTypeName = 'GATHER' | 'SMELT' | 'FORGE' | 'CRAFT';
export interface WdMaterial { id: number; name: string; gatherSkillId?: number | null }
export interface WdIngredient { itemId: number; count: number }
export interface WdRecipe {
  productId: number; name: string; skillId: number | null; workType: WorkTypeName | null; reqLevel: number | null;
  ingredients: WdIngredient[]; toolItemId: number | null; stationKind: string | null; durationMs: number; successRate: number; craftable: boolean;
}
export interface WdGatherPoint {
  id: string; mapId: string; name: string; x: number; y: number; itemId: number; itemName: string | null; skillId: number; toolItemId: number | null;
  durationMs: number; successRate: number; countMin: number; countMax: number;
}
export interface WdTool { itemId: number; name: string; skillId: number; price: number; maxDurability: number }
export interface WdStation { id: string; mapId: string; name: string; kind: string; x: number; y: number; workTypes: WorkTypeName[] }
export interface WdVendor { mapId: string; npcName: string; itemId: number; price: number }
export interface WorkDataFile {
  schema: string; dataVersion: number; origin: string;
  rules: { inventory: { slotLimit: number; stackMax: number }; stamina: { max: number; gatherCost: number; craftCost: number }; gatherReach: number; stationReach: number };
  materials: WdMaterial[]; recipes: WdRecipe[]; gatherPoints: WdGatherPoint[]; tools: WdTool[]; stations: WdStation[]; vendors: WdVendor[];
  missing: Array<{ key: string; what: string }>;
}

export const WORK_DATA = raw as unknown as WorkDataFile;
export const WORK_DATA_VERSION = WORK_DATA.dataVersion;

const matName = new Map(WORK_DATA.materials.map(m => [m.id, m.name]));
const recipeName = new Map(WORK_DATA.recipes.map(r => [r.productId, r.name]));
const toolName = new Map(WORK_DATA.tools.map(t => [t.itemId, t.name]));
export const itemNameOf = (id: number): string => matName.get(id) ?? toolName.get(id) ?? recipeName.get(id) ?? `#${id}`;

/** 名稱完全相同優先，否則包含；回傳全部候選（呼叫端判斷有沒有歧義）。 */
function byName<T>(items: T[], name: (t: T) => string, q: string): T[] {
  const exact = items.filter(i => name(i) === q);
  return exact.length ? exact : items.filter(i => name(i).includes(q) || (q.length > 1 && q.includes(name(i))));
}

export const gatherPointsFor = (itemId: number): WdGatherPoint[] => WORK_DATA.gatherPoints.filter(g => g.itemId === itemId);
export const findGatherItems = (q: string) => {
  const ids = [...new Set(WORK_DATA.gatherPoints.map(g => g.itemId))];
  return byName(ids, itemNameOf, q).map(id => ({ itemId: id, name: itemNameOf(id) }));
};
export const gatherableNames = (): string[] => [...new Set(WORK_DATA.gatherPoints.map(g => g.itemName ?? itemNameOf(g.itemId)))];
export const toolForSkill = (skillId: number): WdTool | null => WORK_DATA.tools.find(t => t.skillId === skillId) ?? null;
export const vendorsFor = (itemId: number): WdVendor[] => WORK_DATA.vendors.filter(v => v.itemId === itemId);
export const recipeOf = (productId: number): WdRecipe | null => WORK_DATA.recipes.find(r => r.productId === productId && r.craftable) ?? null;
export const findRecipes = (q: string, workType?: WorkTypeName): WdRecipe[] =>
  byName(WORK_DATA.recipes.filter(r => r.craftable && (!workType || r.workType === workType)), r => r.name, q);
export const stationFor = (workType: WorkTypeName): WdStation | null => WORK_DATA.stations.find(s => s.workTypes.includes(workType)) ?? null;
