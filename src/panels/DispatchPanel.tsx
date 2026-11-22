import React, { useState } from 'react';
import type { SnapshotFamilyMember, SnapshotGatherPoint } from '../protocol/index';
import {
  DISPATCH_KIND_LABEL,
  DISPATCH_PHASE_LABEL,
  type DispatchKind,
  type DispatchRecap,
  type DispatchRecord,
  type DispatchSpec,
  type GatherSpec,
} from '../dispatch';
import type { LaneSummary } from '../lanes';

export interface GatherOption {
  key: string;
  label: string;
  spec: GatherSpec;
}

/** 從目前視角地圖的採集點整理出可選的採集目標（材料）。 */
export function gatherOptionsFromPoints(points: SnapshotGatherPoint[] | undefined): GatherOption[] {
  const out: GatherOption[] = [];
  const seen = new Set<string>();
  for (const p of points ?? []) {
    if (p.skillId === null) continue;
    for (const m of p.materials ?? []) {
      const key = `${p.skillId}:${m.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        label: `${p.skillName ?? `技能#${p.skillId}`}：${m.name}`,
        spec: {
          skillId: p.skillId,
          skillName: p.skillName ?? `技能#${p.skillId}`,
          targetItemId: m.itemId,
          targetName: m.name,
          count: 'UNTIL_FULL',
          ...(p.requiredToolItemId !== null ? { requiredToolItemId: p.requiredToolItemId } : {}),
          ...(p.requiredToolName ? { requiredToolName: p.requiredToolName } : {}),
        },
      });
    }
  }
  return out;
}

const KINDS: DispatchKind[] = ['IDLE', 'GATHER', 'QUEST_CHAIN', 'NOVICE_LOOP'];

/** 宿主沒給、family 也不自己推算的欄位。 */
export const OVERVIEW_UNKNOWN = '未知';

export interface DispatchOverview {
  quest: string;
  progress: string;
  eta: string;
}

/**
 * F8 家族總覽：每人目前任務、進度、預計完成時間。只讀派工紀錄與通道快照；
 * 宿主不提供完成時間的預估，所以只有設了時間上限時寫「時限 HH:MM」，其他寫「未知」。
 */
export function dispatchOverview(record: DispatchRecord | undefined, lane: LaneSummary | undefined, fmtTime: (ms: number) => string = defaultTime): DispatchOverview {
  const live = record && (record.phase === 'RUNNING' || record.phase === 'PAUSED');
  const chain = record && (record.kind === 'QUEST_CHAIN' || record.kind === 'NOVICE_LOOP');
  const quest = !live
    ? '—'
    : record.kind === 'GATHER'
      ? `採集 ${record.gather?.targetName || OVERVIEW_UNKNOWN}`
      : chain && lane?.questId != null
        ? lane.questTitle || OVERVIEW_UNKNOWN
        : chain ? '（還沒接到任務）' : '—';
  const progress = !live ? '—' : chain && lane?.questId != null ? lane.progress ?? OVERVIEW_UNKNOWN : record.kind === 'GATHER' ? record.text || OVERVIEW_UNKNOWN : '—';
  const eta = !live ? '—' : record.deadlineAt !== null ? `時限 ${fmtTime(record.deadlineAt)}` : OVERVIEW_UNKNOWN;
  return { quest, progress, eta };
}

function defaultTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function numOrNull(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : null;
}

function DispatchRow(props: {
  member: SnapshotFamilyMember;
  viewed: boolean;
  record?: DispatchRecord;
  recap?: DispatchRecap;
  lane?: LaneSummary;
  gatherOptions: GatherOption[];
  running: boolean;
  onAssign: (spec: DispatchSpec) => void;
  onStop: () => void;
  onView: () => void;
}) {
  const { member: m, record, recap } = props;
  const [kind, setKind] = useState<DispatchKind>('GATHER');
  const [gatherKey, setGatherKey] = useState('');
  const [count, setCount] = useState('');
  const [minutes, setMinutes] = useState('');
  const [bagFull, setBagFull] = useState(true);
  const [satiety, setSatiety] = useState('');
  const name = m.name ?? m.characterId;
  const opt = props.gatherOptions.find(o => o.key === gatherKey) ?? props.gatherOptions[0];
  const busy = record?.phase === 'RUNNING' || record?.phase === 'PAUSED' || record?.phase === 'WAITING_VIEW';
  const overview = dispatchOverview(record, props.lane);
  const needsTarget = kind === 'GATHER';
  const canAssign = props.running && (!needsTarget || Boolean(opt));
  const phase = record?.phase ?? 'IDLE';

  const submit = () => {
    const stop = {
      maxMinutes: numOrNull(minutes),
      stopOnBagFull: bagFull,
      minSatiety: numOrNull(satiety),
    };
    if (kind === 'GATHER' && opt) {
      const n = numOrNull(count);
      props.onAssign({ kind, gather: { ...opt.spec, count: n === null ? 'UNTIL_FULL' : Math.round(n) }, stop });
    } else {
      props.onAssign({ kind, stop });
    }
  };

  return (
    <div className="dispatch-card" data-testid="dispatch-row" data-character-id={m.characterId} data-phase={phase}>
      <div className="dispatch-head">
        <strong>{name}</strong>
        <span className={`pill ${phase === 'RUNNING' ? 'ok' : phase === 'IDLE' ? '' : 'warn'}`} data-testid="dispatch-phase">
          {record && record.kind !== 'IDLE' ? `${DISPATCH_KIND_LABEL[record.kind]}・${DISPATCH_PHASE_LABEL[phase]}` : '待機'}
        </span>
        {props.viewed && <span className="muted">視角中</span>}
        <button
          type="button"
          className="item"
          data-testid="dispatch-view"
          disabled={props.viewed || !props.running}
          onClick={props.onView}
        >
          切換觀看
        </button>
      </div>
      <dl className="dispatch-overview" data-testid="dispatch-overview">
        <div><dt>目前</dt><dd data-testid="dispatch-overview-quest">{overview.quest}</dd></div>
        <div><dt>進度</dt><dd data-testid="dispatch-overview-progress">{overview.progress}</dd></div>
        <div><dt>預計完成</dt><dd data-testid="dispatch-overview-eta">{overview.eta}</dd></div>
      </dl>
      <div className="dispatch-status" data-testid="dispatch-status" data-stop-code={record?.stopped?.code ?? ''}>
        {recap ? recap.line : '尚未派工'}
      </div>
      <div className="dispatch-form">
        <label>
          工作
          <select
            aria-label={`${name} 工作`}
            data-testid="dispatch-kind"
            value={kind}
            onChange={e => setKind(e.currentTarget.value as DispatchKind)}
          >
            {KINDS.map(k => (
              <option key={k} value={k}>{DISPATCH_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        {needsTarget && (
          <>
            <label>
              目標
              <select
                aria-label={`${name} 採集目標`}
                data-testid="dispatch-gather"
                value={opt?.key ?? ''}
                disabled={props.gatherOptions.length === 0}
                onChange={e => setGatherKey(e.currentTarget.value)}
              >
                {props.gatherOptions.length === 0 && <option value="">（此地圖沒有採集點）</option>}
                {props.gatherOptions.map(o => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            </label>
            <label>
              數量
              <input
                type="number"
                min={1}
                placeholder="到滿"
                aria-label={`${name} 採集數量`}
                data-testid="dispatch-count"
                value={count}
                onChange={e => setCount(e.currentTarget.value)}
              />
            </label>
          </>
        )}
        {kind !== 'IDLE' && (
          <>
            <label>
              時間(分)
              <input
                type="number"
                min={1}
                aria-label={`${name} 時間上限（分鐘）`}
                data-testid="dispatch-minutes"
                value={minutes}
                onChange={e => setMinutes(e.currentTarget.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                data-testid="dispatch-bagfull"
                checked={bagFull}
                onChange={e => setBagFull(e.currentTarget.checked)}
              />
              背包滿即停
            </label>
            {needsTarget && (
              <label>
                飽食≤
                <input
                  type="number"
                  min={0}
                  max={99}
                  aria-label={`${name} 飽食度下限`}
                  data-testid="dispatch-satiety"
                  value={satiety}
                  onChange={e => setSatiety(e.currentTarget.value)}
                />
              </label>
            )}
          </>
        )}
        <div className="dispatch-actions">
          <button type="button" className="item" data-testid="dispatch-assign" disabled={!canAssign} onClick={submit}>
            {busy ? '改派' : '派工'}
          </button>
          <button type="button" className="item" data-testid="dispatch-stop" disabled={!busy} onClick={props.onStop}>
            停止
          </button>
        </div>
      </div>
    </div>
  );
}

export function DispatchPanel(props: {
  members: SnapshotFamilyMember[];
  viewedId: string | null;
  records: DispatchRecord[];
  recaps: DispatchRecap[];
  lanes?: LaneSummary[];
  gatherPoints?: SnapshotGatherPoint[];
  running: boolean;
  error: string;
  onAssign: (characterId: string, spec: DispatchSpec, name: string) => void;
  onStop: (characterId: string, name: string) => void;
  onView?: (characterId: string, name: string) => void;
}) {
  const options = gatherOptionsFromPoints(props.gatherPoints);
  return (
    <section data-testid="dispatch-panel" className="dispatch-panel">
      <h2>派工與家族總覽（採集、任務鏈都可同時派給多位，在背景跑；同一件任務不重複派）</h2>
      {props.members.length === 0 ? (
        <div className="muted">（尚未收到家族成員資料）</div>
      ) : (
        props.members.map(m => (
          <DispatchRow
            key={m.characterId}
            member={m}
            viewed={m.characterId === props.viewedId}
            record={props.records.find(r => r.characterId === m.characterId)}
            recap={props.recaps.find(r => r.characterId === m.characterId)}
            lane={props.lanes?.find(l => l.characterId === m.characterId)}
            gatherOptions={options}
            running={props.running}
            onAssign={spec => props.onAssign(m.characterId, spec, m.name ?? m.characterId)}
            onStop={() => props.onStop(m.characterId, m.name ?? m.characterId)}
            onView={() => props.onView?.(m.characterId, m.name ?? m.characterId)}
          />
        ))
      )}
      {props.error && <div className="err" data-testid="dispatch-error">{props.error}</div>}
    </section>
  );
}
