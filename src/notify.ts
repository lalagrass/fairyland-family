import { stopReasonLabel, type QueueStatus } from './queue';
import type { FamilyState } from './state';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotificationAdapter {
  isHidden(): boolean;
  permission(): NotificationPermissionState;
  send(title: string, body: string): void;
}

function browserAdapter(): NotificationAdapter {
  return {
    isHidden: () => (typeof document !== 'undefined' ? Boolean(document.hidden) : false),
    permission: () => {
      if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
      return Notification.permission;
    },
    send: (title, body) => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    },
  };
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission ?? 'denied';
  }
}

export function getNotificationPermission(): NotificationPermissionState {
  return browserAdapter().permission();
}

/**
 * DV5：當分頁不在前景（document.hidden === true）且玩家已授權瀏覽器通知時，
 * 於「工作意外中止」、「戰鬥落敗」或「工作目標達成」時各發送一次瀏覽器通知。
 */
export class WorkNotifier {
  private lastQueueState = new Map<string, string>();
  private lastBattleResult: FamilyState['battleResult'] = null;

  constructor(private adapter: NotificationAdapter = browserAdapter()) {}

  check(state: FamilyState, queues: Record<string, QueueStatus>, fallbackQueue?: QueueStatus): void {
    const hidden = this.adapter.isHidden();
    const granted = this.adapter.permission() === 'granted';

    if (state.battleResult === 'DEFEAT' && this.lastBattleResult !== 'DEFEAT') {
      if (hidden && granted) {
        const who = state.character?.name ?? state.characterId ?? '角色';
        this.adapter.send('童話家族：戰鬥落敗', `${who} 在戰鬥中落敗，請回遊戲查看或送醫治療。`);
      }
    }
    this.lastBattleResult = state.battleResult;

    const entries: Array<[string, QueueStatus]> = Object.entries(queues);
    if (entries.length === 0 && fallbackQueue) {
      entries.push([state.characterId ?? 'default', fallbackQueue]);
    }
    for (const [cid, q] of entries) {
      const sig = `${q.phase}:${q.stopReason ?? ''}`;
      const prevSig = this.lastQueueState.get(cid);
      this.lastQueueState.set(cid, sig);
      if (prevSig === undefined || sig === prevSig) continue;

      if (!hidden || !granted) continue;
      const memberName = state.members.find(m => m.characterId === cid)?.name ?? cid;
      if (q.phase === 'DONE' || q.stopReason === 'DONE_TARGET') {
        this.adapter.send('童話家族：工作目標達成', `${memberName} 的工作佇列已達成全部目標。`);
      } else if (q.phase === 'STOPPED' && q.stopReason && q.stopReason !== 'USER_STOPPED') {
        this.adapter.send('童話家族：工作意外中止', `${memberName} 的工作已停止：${stopReasonLabel(q.stopReason)}`);
      }
    }
  }
}
