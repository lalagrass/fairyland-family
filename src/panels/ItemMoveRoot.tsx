import React from 'react';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import type { PluginCommand } from '../protocol/index';
import type { SnapshotItem } from '../protocol/types';
import { commandFromDragData, type ItemBin } from './itemMove';

export function ItemMoveRoot(props: {
  children: React.ReactNode;
  onCommand: (command: PluginCommand, label: string) => void;
}) {
  function onDragEnd(event: DragEndEvent) {
    const data = event.active.data.current as { bin?: ItemBin; item?: SnapshotItem } | undefined;
    const built = commandFromDragData(data, event.over?.id);
    if (built) props.onCommand(built.command, built.label);
  }
  return <DndContext onDragEnd={onDragEnd}>{props.children}</DndContext>;
}
