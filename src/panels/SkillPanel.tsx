import React, { useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  legacyCreateColumnHelper,
  useLegacyTable,
} from '@tanstack/react-table/legacy';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { StaticSkillSummary } from '../protocol/types';
import { PanelMark } from './marks';

const helper = legacyCreateColumnHelper<StaticSkillSummary>();
const columns = [
  helper.accessor('name', { header: '名稱' }),
  helper.accessor('kind', { header: '種類' }),
  helper.accessor('mpCost', { header: 'MP' }),
  helper.accessor('reqLevel', { header: '需求等級' }),
];

export function SkillPanel(props: { skills: StaticSkillSummary[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const parentRef = React.useRef<HTMLDivElement>(null);
  const table = useLegacyTable({
    data: props.skills,
    columns: columns as never,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, value) => {
      const q = String(value).trim();
      return !q || row.original.name.includes(q);
    },
  });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 8,
  });

  return (
    <section data-testid="skill-panel">
      <h2><PanelMark kind="skill" />技能</h2>
      <div className="fm7-toolbar">
        <input
          type="search"
          value={filter}
          placeholder="篩選技能名稱"
          aria-label="篩選技能"
          data-testid="skill-filter"
          onChange={e => setFilter(e.currentTarget.value)}
        />
        <button type="button" className="item" data-testid="skill-sort-name" onClick={() => table.getColumn('name')?.toggleSorting()}>
          名稱排序
        </button>
      </div>
      {props.skills.length === 0 ? (
        <div className="muted">（還沒收到技能表）</div>
      ) : (
        <div ref={parentRef} className="fm7-scroll" data-testid="skill-list">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vrow => {
              const skill = rows[vrow.index].original;
              return (
                <div
                  key={skill.id}
                  className="fm7-skill"
                  data-testid="skill-row"
                  data-skill-id={String(skill.id)}
                  style={{ position: 'absolute', top: vrow.start, left: 0, right: 0 }}
                >
                  <b>{skill.name}</b>
                  <span className="muted">{` ${skill.kind}　MP ${skill.mpCost}　${skill.targetScope}${skill.reqLevel != null ? `　Lv.${skill.reqLevel}` : ''}　說明：快照沒有這欄`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
