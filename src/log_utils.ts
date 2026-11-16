import type { LogEntry, LogTag } from './state';

export const LOG_TAGS: readonly LogTag[] = ['連線', '事件', '快照', '送出', '結果', '系統'];

export const TAG_CLASS: Record<LogTag, string> = {
  連線: 'log-tag-conn',
  事件: 'log-tag-event',
  快照: 'log-tag-snap',
  送出: 'log-tag-sent',
  結果: 'log-tag-result',
  系統: 'log-tag-sys',
};

export interface CollapsedLogEntry {
  id: number;
  at: number;
  tag: LogTag;
  level: LogEntry['level'];
  characterId?: string;
  commandId?: string;
  displayText: string;
  count: number;
}

/** DV1：檢查目前是否啟用開發者除錯模式（?dev=1 或 localStorage['fl.dev'] === '1'）。 */
export function isDevModeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location?.search ?? '');
    if (q.get('dev') === '1') return true;
  } catch { /* 忽略不支援 location 的測試環境 */ }
  try {
    if (window.localStorage?.getItem('fl.dev') === '1') return true;
  } catch { /* 忽略私密模式 */ }
  return false;
}

/** DV1：將單筆日誌轉為顯示文字；一般玩家模式會移除原始指令 JSON 與預期/實際驗證除錯碼。 */
export function formatLogText(entry: LogEntry, devMode: boolean): string {
  if (devMode) return entry.text;
  if (entry.tag === '送出') {
    const noJson = entry.text.replace(/\s+\{[\s\S]*\}(?:\s+（預期：[^）]*）)?$/, '');
    return noJson.replace(/\s+（預期：[^）]*）$/, '');
  }
  if (entry.tag === '結果') {
    if (entry.text === '結果：已接受') return '指令已送達';
    if (entry.text.startsWith('結果：被拒絕')) {
      const m = entry.text.match(/（([^）]+)）/);
      return m ? `操作未完成（${m[1]}）` : '操作未完成';
    }
    const expectMatch = entry.text.match(/^(.*?)\s+預期\s+\S+／實際\s+\S+（(DONE|FAILED|PARTIAL)）(?:\s*(✓|✗\s*與預期不同))?(?:\s+(.*))?$/);
    if (expectMatch) {
      const [, label, outcome, , extraMsg] = expectMatch;
      const status = outcome === 'DONE' ? '完成' : outcome === 'PARTIAL' ? '部分完成' : '未完成';
      return extraMsg ? `${label}：${status}（${extraMsg}）` : `${label}：${status}`;
    }
  }
  return entry.text;
}

/** DV4：由新到舊過濾並折疊連續相同（同標籤、角色、文字）的日誌項目為 ×N。 */
export function collapseAndFilterLogs(
  logs: LogEntry[],
  opts: { devMode: boolean; tagFilter?: LogTag | 'ALL'; charFilter?: string | 'ALL' },
): CollapsedLogEntry[] {
  const tagFilter = opts.tagFilter ?? 'ALL';
  const charFilter = opts.charFilter ?? 'ALL';
  const out: CollapsedLogEntry[] = [];

  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    if (tagFilter !== 'ALL' && e.tag !== tagFilter) continue;
    if (charFilter !== 'ALL' && e.characterId !== charFilter) continue;
    const displayText = formatLogText(e, opts.devMode);
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.tag === e.tag &&
      prev.level === e.level &&
      prev.characterId === e.characterId &&
      prev.displayText === displayText
    ) {
      prev.count += 1;
    } else {
      out.push({
        id: e.id,
        at: e.at,
        tag: e.tag,
        level: e.level,
        characterId: e.characterId,
        commandId: opts.devMode ? e.commandId : undefined,
        displayText,
        count: 1,
      });
    }
  }
  return out;
}
