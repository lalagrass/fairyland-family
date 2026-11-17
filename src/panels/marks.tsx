import React from 'react';

/** 自繪幾何標記。不引用 game-icons 或其他需要署名的圖庫。 */
export function PanelMark(props: { kind: 'character' | 'skill' | 'bag' | 'warehouse' }) {
  const d = {
    character: 'M8 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-5 7v-1a5 5 0 0 1 10 0v1',
    skill: 'M3 4h10v2H3zm0 4h10v2H3zm0 4h6v2H3',
    bag: 'M5 6V4h6v2h3v10H2V6h3zm2 0h2V5H7v1z',
    warehouse: 'M2 7l6-4 6 4v8H2V7zm4 8V9h4v6',
  }[props.kind];
  return (
    <svg className="fm7-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
