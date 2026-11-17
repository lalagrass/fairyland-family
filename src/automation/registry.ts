import { createActor } from 'xstate';
import type { PluginMessage } from '../protocol/index';
import type { UiAction } from '../parse';
import {
  automationCoordinatorMachine,
  type AutomationHostContext,
  type BehaviorModule,
  type CoordinatorMode,
} from './types';

/**
 * 可組合的行為模組註冊中心＋XState v5 協調器。
 * 之後新增任何自動行為只需 `registry.register(module)`，無需更動核心控制器流程。
 */
export class AutomationRegistry {
  private modules: BehaviorModule[] = [];
  private actor = createActor(automationCoordinatorMachine);

  constructor() {
    this.actor.start();
  }

  register(mod: BehaviorModule): void {
    this.modules = [...this.modules.filter(m => m.id !== mod.id), mod].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  list(): readonly BehaviorModule[] {
    return this.modules;
  }

  getCoordinatorMode(): CoordinatorMode {
    return this.actor.getSnapshot().value as CoordinatorMode;
  }

  syncCoordinator(ctx: AutomationHostContext): CoordinatorMode {
    const active = this.modules.find(m => m.isActive(ctx));
    const eventMap: Record<CoordinatorMode, string> = {
      IDLE: 'STOP_ALL',
      NAVIGATING: 'START_NAV',
      WORKING: 'START_WORK',
      COMBAT: 'ENTER_COMBAT',
      QUESTING: 'START_QUEST',
      RESTING: 'TRIGGER_REST',
    };
    if (!active) {
      if (this.getCoordinatorMode() === 'COMBAT') {
        this.actor.send({ type: 'LEAVE_COMBAT' });
      }
      this.actor.send({ type: 'STOP_ALL' });
    } else {
      const targetEv = eventMap[active.category];
      if (targetEv) this.actor.send({ type: targetEv });
    }
    return this.getCoordinatorMode();
  }

  dispatchAction(action: UiAction, ctx: AutomationHostContext): { handled: boolean; error: string | null } {
    for (const m of this.modules) {
      if (!m.handleAction) continue;
      const res = m.handleAction(action, ctx);
      if (res.handled) {
        this.syncCoordinator(ctx);
        return res;
      }
    }
    return { handled: false, error: null };
  }

  notifyPreMessage(msg: PluginMessage, ctx: AutomationHostContext): void {
    for (const m of this.modules) {
      m.onPreMessage?.(msg, ctx);
    }
  }

  notifyMessage(msg: PluginMessage, ctx: AutomationHostContext): void {
    for (const m of this.modules) {
      m.onMessage?.(msg, ctx);
    }
    this.syncCoordinator(ctx);
  }

  stopAll(): void {
    for (const m of this.modules) m.stop?.();
    this.actor.send({ type: 'LEAVE_COMBAT' });
    this.actor.send({ type: 'STOP_ALL' });
  }
}
