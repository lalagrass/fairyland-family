import React, { useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import * as Popover from '@radix-ui/react-popover';
import type { SortingState } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  legacyCreateColumnHelper,
  useLegacyTable,
} from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SnapshotItem } from '../protocol/types';
import type { ItemBin } from './itemMove';

const helper = legacyCreateColumnHelper<SnapshotItem>();
const columns = [
  helper.accessor(row => row.name ?? `#${row.itemId}`, { id: 'name', header: '名稱' }),
  helper.accessor('count', { header: '數量' }),
];

export function ItemColumn(props: {
  bin: ItemBin;
  items: SnapshotItem[];
  running: boolean;
  rowTestId: string;
  emptyText: string;
}) {
  const { bin, items, running, rowTestId, emptyText } = props;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const parentRef = React.useRef<HTMLDivElement>(null);
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: bin });

  const table = useLegacyTable({
    data: items,
    columns: columns as never,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, value) => {
      const q = String(value).trim();
      if (!q) return true;
      const name = row.original.name ?? '';
      return name.includes(q) || String(row.original.itemId).includes(q);
    },
  });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (view === 'grid' ? 64 : 36),
    overscan: 8,
  });

  return (
    <div className="fm7-column" data-testid={`${bin}-column`}>
      <div className="fm7-toolbar">
        <input
          type="search"
          value={filter}
          placeholder="篩選名稱或編號"
          aria-label={bin === 'bag' ? '篩選背包' : '篩選倉庫'}
          data-testid={`${bin}-filter`}
          onChange={e => setFilter(e.currentTarget.value)}
        />
        <button type="button" className="item" data-testid={`${bin}-sort-name`} onClick={() => table.getColumn('name')?.toggleSorting()}>
          名稱排序
        </button>
        <button type="button" className="item" data-testid={`${bin}-view`} onClick={() => setView(v => (v === 'list' ? 'grid' : 'list'))}>
          {view === 'list' ? '格子' : '清單'}
        </button>
      </div>
      <div
        ref={node => {
          parentRef.current = node;
          setDropRef(node);
        }}
        className={`fm7-scroll ${isOver ? 'fm7-over' : ''} ${view === 'grid' ? 'fm7-grid' : ''}`}
        data-testid={`${bin}-drop`}
      >
        {rows.length === 0 ? (
          <span className="muted">{emptyText}</span>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vrow => {
              const row = rows[vrow.index];
              return (
                <ItemRow
                  key={row.original.itemId}
                  bin={bin}
                  item={row.original}
                  running={running}
                  rowTestId={rowTestId}
                  view={view}
                  top={vrow.start}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemRow(props: {
  bin: ItemBin;
  item: SnapshotItem;
  running: boolean;
  rowTestId: string;
  view: 'list' | 'grid';
  top: number;
}) {
  const { bin, item, running, rowTestId, view, top } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${bin}:${item.itemId}`,
    disabled: !running,
    data: { bin, item },
  });
  const style: React.CSSProperties = {
    position: 'absolute',
    top,
    left: 0,
    right: 0,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className={`fm7-row ${view}`} data-testid={rowTestId} data-item-id={String(item.itemId)}>
      <button type="button" className="item fm7-drag" disabled={!running} {...listeners} {...attributes}>
        {`${item.name ?? `#${item.itemId}`} ×${item.count}`}
      </button>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button type="button" className="item" data-testid={`${bin}-detail`} onPointerDown={e => e.stopPropagation()}>
            詳情
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="fm7-detail" data-testid={`${bin}-detail-panel`} sideOffset={6}>
            <div>{item.name ?? '未命名'}</div>
            <div className="muted">{`編號 ${item.itemId}　數量 ${item.count}`}</div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
