import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { questCardsLayout, type QuestCardModel } from './questCardModel';

/**
 * F9 任務卡片（fairyland-family#50）：目標、地點、進度、獎勵、誰在做。
 * 版面用 CSS Grid＋container query（style.css `.quest-cards`）；寬度另外量一次寫進 data-layout／data-columns，
 * 方便測試與除錯。卡片只顯示宿主快照的內容，按鈕交給既有的跨圖移動（NAV）與任務自動推進。
 */

export interface QuestCardsMember {
  characterId: string;
  name: string | null;
}

export interface QuestCardsProps {
  cards: readonly QuestCardModel[];
  members: readonly QuestCardsMember[];
  viewCharacterId: string | null;
  running: boolean;
  /** family 自動推進中的任務。 */
  activeQuestId: number | null;
  /** 量不到容器寬度時（測試、伺服器端渲染）用這個寬度。 */
  initialWidth?: number;
  onGo: (card: QuestCardModel) => void;
  onAuto: (card: QuestCardModel) => void;
  onAutoStop: () => void;
  onAssign: (card: QuestCardModel, characterId: string) => void;
}

function useContainerWidth(initial: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    const ResizeObs = typeof window !== 'undefined' ? window.ResizeObserver : undefined;
    if (!ResizeObs) return;
    let observer: ResizeObserver;
    try {
      observer = new ResizeObs(measure);
      observer.observe(el);
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function AssignMenu({ card, members, viewCharacterId, running, onAssign }: {
  card: QuestCardModel;
  members: readonly QuestCardsMember[];
  viewCharacterId: string | null;
  running: boolean;
  onAssign: (card: QuestCardModel, characterId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="item"
          data-testid="quest-card-assign-btn"
          data-quest-id={String(card.questId)}
          disabled={!running || members.length === 0}
        >
          派給角色
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="quest-card-assign-menu" data-testid="quest-card-assign-menu" sideOffset={6} align="start">
          <div className="muted">任務需要角色在視角中；派給別人會先切換視角。</div>
          {members.map(m => (
            <button
              key={m.characterId}
              type="button"
              className="item"
              data-testid="quest-card-assign-member"
              data-character-id={m.characterId}
              onClick={() => {
                setOpen(false);
                onAssign(card, m.characterId);
              }}
            >
              {`${m.name ?? m.characterId}${m.characterId === viewCharacterId ? '（視角中）' : ''}`}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function QuestCards(props: QuestCardsProps) {
  const [ref, width] = useContainerWidth(props.initialWidth ?? 0);
  const layout = questCardsLayout(width);
  return (
    <div
      ref={ref}
      className={`quest-cards ${layout.narrow ? 'is-narrow' : 'is-wide'}`}
      data-testid="quest-cards"
      data-layout={layout.narrow ? 'narrow' : 'wide'}
      data-columns={String(layout.columns)}
    >
      <ul className="quest-card-grid">
        {props.cards.map(card => {
          const isAutoRunning = props.activeQuestId === card.questId;
          const actionable = card.status !== 'COMPLETED';
          return (
            <li
              key={card.questId}
              className={`quest-card quest-item status-${card.status.toLowerCase()}`}
              data-testid="quest-entry"
              data-quest-id={String(card.questId)}
              data-quest-status={card.status}
              data-owner-mode={card.owner.mode}
              data-has-unknown={card.hasUnknown ? '1' : '0'}
            >
              <div className="quest-card-head">
                <span className={card.statusCls}>{card.statusText}</span>
                <b className="quest-card-title" data-testid="quest-card-title">{card.title}</b>
              </div>
              <dl className="quest-card-fields">
                <dt>目標</dt>
                <dd data-testid="quest-card-goal">{card.goal}</dd>
                <dt>地點</dt>
                <dd data-testid="quest-card-location">{card.location}</dd>
                <dt>進度</dt>
                <dd data-testid="quest-card-progress">
                  <span>{card.progress}</span>
                  {card.objectives.length > 0 && (
                    <ul className="quest-card-objectives">
                      {card.objectives.map((o, i) => (
                        <li key={i} className={o.met ? 'met' : ''}>{`${o.met ? '✓' : '…'} ${o.text}（${o.progress}）`}</li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt>獎勵</dt>
                <dd data-testid="quest-card-reward">{`${card.rewardExp}／${card.rewardCoins}`}</dd>
                <dt>誰在做</dt>
                <dd data-testid="quest-card-owner">{card.owner.text}</dd>
              </dl>
              <div className="quest-card-foot muted">{`委託人 ${card.giver}｜需求 ${card.minLevel}`}</div>
              {actionable && (
                <div className="quest-card-actions">
                  <button
                    type="button"
                    className="item"
                    data-testid="quest-nav-btn"
                    data-quest-id={String(card.questId)}
                    disabled={!props.running || !card.go}
                    title={card.go ? undefined : '宿主沒有提供可前往的地點'}
                    onClick={() => props.onGo(card)}
                  >
                    {card.go ? `前往 ${card.go.name}` : '前往（地點未知）'}
                  </button>
                  <button
                    type="button"
                    className="item"
                    data-testid="quest-auto-btn"
                    data-quest-id={String(card.questId)}
                    disabled={!props.running}
                    onClick={() => props.onAuto(card)}
                  >
                    {card.status === 'READY' ? '自動回報' : card.status === 'AVAILABLE' ? '自動接取' : '自動推進'}
                  </button>
                  <AssignMenu
                    card={card}
                    members={props.members}
                    viewCharacterId={props.viewCharacterId}
                    running={props.running}
                    onAssign={props.onAssign}
                  />
                  {isAutoRunning && (
                    <button
                      type="button"
                      className="item"
                      data-testid="quest-auto-stop-btn"
                      data-quest-id={String(card.questId)}
                      disabled={!props.running}
                      onClick={props.onAutoStop}
                    >
                      停止自動
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
