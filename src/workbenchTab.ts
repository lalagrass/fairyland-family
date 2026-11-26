/** 網址指定工作台分頁：`#tab=wine` 或 `?tab=wine`（啟動器開頁時直接進「視窗練功」）。 */
export const WORKBENCH_TABS = ['overview', 'skills', 'inventory', 'settings', 'wine', 'path', 'gather'] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

export function parseWorkbenchTab(hash: string, search: string): WorkbenchTab | null {
  const sources = [hash.replace(/^#/, ''), search.replace(/^\?/, '')];
  for (const src of sources) {
    const raw = new URLSearchParams(src).get('tab');
    if (raw && (WORKBENCH_TABS as readonly string[]).includes(raw)) return raw as WorkbenchTab;
  }
  return null;
}

export function workbenchTabFromLocation(): WorkbenchTab | null {
  const loc = (globalThis as { location?: { hash?: string; search?: string } }).location;
  if (!loc) return null;
  return parseWorkbenchTab(loc.hash ?? '', loc.search ?? '');
}
