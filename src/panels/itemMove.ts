import type { PluginCommand } from '../protocol/index';
import type { SnapshotItem } from '../protocol/types';

export type ItemBin = 'bag' | 'warehouse';

export interface ItemDragCommand {
  command: PluginCommand;
  label: string;
}

/** 把拖曳結束時的來源與目標轉成原子指令。落點不是背包或倉庫時不送指令。 */
export function commandFromDragData(
  data: { bin?: ItemBin; item?: SnapshotItem } | undefined,
  overId: unknown,
): ItemDragCommand | null {
  if (!data?.bin || !data.item) return null;
  if (overId !== 'bag' && overId !== 'warehouse') return null;
  return commandForItemDrag(data.bin, overId, data.item);
}

/** 拖曳只產生一筆原子指令。同一個格子裡換位置沒有對應指令，回傳 null。 */
export function commandForItemDrag(from: ItemBin, to: ItemBin, item: SnapshotItem): ItemDragCommand | null {
  if (from === to) return null;
  const count = 1;
  const labelName = item.name ?? `#${item.itemId}`;
  if (from === 'bag' && to === 'warehouse') {
    return {
      command: { type: 'WAREHOUSE_DEPOSIT', itemId: item.itemId, count },
      label: `存倉 ${labelName} ×${count}`,
    };
  }
  if (from === 'warehouse' && to === 'bag') {
    return {
      command: { type: 'WAREHOUSE_WITHDRAW', itemId: item.itemId, count },
      label: `取倉 ${labelName} ×${count}`,
    };
  }
  return null;
}
