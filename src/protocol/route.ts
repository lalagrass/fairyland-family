// [sync-protocol] 自動產生，請勿手改；改協定請到 fairyland 修改後重新執行 npm run sync-protocol
// [sync-protocol] 來源：fairyland/packages/shared/src/protocol/route.ts @ 57515633f850ee9dc36c8054addee704af3e3553
/**
 * 外掛端用的純函式：在「地圖鄰接」上規劃跨圖路線（BFS，經過最少地圖）。
 * 放在協定資料夾，fairyland-family 同步副本後可直接使用；鄰接來源是快照的 `nav.portalGraph`
 * 與外掛自己逐次看過的各圖出口（宿主沒有世界目錄時，只有目前地圖的直接出口）。
 * 本檔不得 import 本資料夾以外的檔案。
 */

/** mapId -> 可直接通往的 mapId 清單。 */
export type MapAdjacency = Record<string, string[]>;

/** 回傳 [起點, ..., 終點] 的地圖 id 序列；起點即終點回 [起點]；不可達回 null。 */
export function planMapRoute(adj: MapAdjacency, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const next of adj[cur] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let m = to; prev.has(m); ) { m = prev.get(m) as string; path.unshift(m); }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
