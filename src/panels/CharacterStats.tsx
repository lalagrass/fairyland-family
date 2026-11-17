import React, { useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getSortedRowModel, legacyCreateColumnHelper, useLegacyTable } from '@tanstack/react-table/legacy';
import type { SnapshotCharacter } from '../protocol/types';

interface StatRow {
  label: string;
  value: string;
}

const helper = legacyCreateColumnHelper<StatRow>();
const columns = [
  helper.accessor('label', { header: '項目' }),
  helper.accessor('value', { header: '內容' }),
];

function rowsFor(c: SnapshotCharacter): StatRow[] {
  const job = c.ruleset === 'revamp' || (!c.className && c.weaponFamily)
    ? `武器 ${c.weaponFamily ?? '—'} Lv.${c.familyLevel ?? 1}｜連擊 Lv.${c.comboLevel ?? 1}`
    : (c.className ?? '—');
  return [
    { label: '等級', value: String(c.level) },
    { label: 'HP', value: `${c.hp ?? '—'}/${c.maxHp ?? '—'}` },
    { label: 'MP', value: `${c.mp ?? '—'}/${c.maxMp ?? '—'}` },
    { label: '職業', value: job },
    { label: '屬性', value: '快照沒有這欄' },
    { label: '經驗', value: '快照沒有這欄' },
    { label: '裝備', value: '快照沒有裝備欄' },
  ];
}

/** 只顯示宿主快照已有的欄位。沒有的欄位不補數字。 */
export function CharacterStats(props: { character: SnapshotCharacter }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const data = rowsFor(props.character);
  const table = useLegacyTable({
    data,
    // v9 欄位值型別是反變的，字串欄位陣列不能直接當成 unknown。
    columns: columns as never,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <table className="fm7-stats" data-testid="character-stats">
      <tbody>
        {table.getRowModel().rows.map(row => (
          <tr key={row.original.label}>
            <th>{row.original.label}</th>
            <td>{row.original.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
