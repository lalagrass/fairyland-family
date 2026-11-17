import { createMachine } from 'xstate';
import type { PluginCommand, PluginMessage } from '../protocol/index';
import type { UiAction } from '../parse';
import type { FamilyState } from '../state';
import type { CharacterStrategyConfig } from './strategyStore';

export type CoordinatorMode = 'IDLE' | 'NAVIGATING' | 'WORKING' | 'COMBAT' | 'QUESTING' | 'RESTING';

export interface AutomationHostContext {
  state: () => FamilyState;
  status: () => 'RUNNING' | 'STOPPED';
  now: () => number;
  getStrategyConfig: (characterId?: string | null) => CharacterStrategyConfig;
  send: (command: PluginCommand, label: string, expect?: string, targetCharId?: string) => string;
  log: (text: string, level?: 'info' | 'warn' | 'error') => void;
  onChange: () => void;
}

export interface BehaviorModule {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly category: CoordinatorMode;
  isActive(ctx: AutomationHostContext): boolean;
  getSummary(ctx: AutomationHostContext): string;
  handleAction?(action: UiAction, ctx: AutomationHostContext): { handled: boolean; error: string | null };
  /** 在 navigator / queue 處理訊息前先執行（例如更新冷卻與 patrol tracking，避免 navigator.onChange 回呼搶跑）。 */
  onPreMessage?(msg: PluginMessage, ctx: AutomationHostContext): void;
  onMessage?(msg: PluginMessage, ctx: AutomationHostContext): void;
  stop?(): void;
}

/**
 * XState v5（MIT）行為協調狀態機：追蹤多個可組合行為模組中當前景況的主要狀態。
 */
export const automationCoordinatorMachine = createMachine({
  id: 'familyAutomationCoordinator',
  initial: 'IDLE',
  states: {
    IDLE: {
      on: {
        START_NAV: 'NAVIGATING',
        START_WORK: 'WORKING',
        ENTER_COMBAT: 'COMBAT',
        START_QUEST: 'QUESTING',
        TRIGGER_REST: 'RESTING',
      },
    },
    NAVIGATING: {
      on: {
        ENTER_COMBAT: 'COMBAT',
        START_WORK: 'WORKING',
        STOP_ALL: 'IDLE',
      },
    },
    WORKING: {
      on: {
        ENTER_COMBAT: 'COMBAT',
        START_NAV: 'NAVIGATING',
        STOP_ALL: 'IDLE',
      },
    },
    COMBAT: {
      on: {
        LEAVE_COMBAT: 'IDLE',
        START_WORK: 'WORKING',
        START_QUEST: 'QUESTING',
      },
    },
    QUESTING: {
      on: {
        ENTER_COMBAT: 'COMBAT',
        STOP_ALL: 'IDLE',
      },
    },
    RESTING: {
      on: {
        STOP_ALL: 'IDLE',
        START_NAV: 'NAVIGATING',
      },
    },
  },
});
