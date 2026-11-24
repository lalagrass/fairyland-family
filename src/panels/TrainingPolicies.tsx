import type { SnapshotItem, StaticSkillSummary } from '../protocol';
import { isAllySkill, skillKey } from '../battler';
import { DEFAULT_INVENTORY_POLICY, DEFAULT_SKILL_POLICY, type InventoryPolicy, type SkillPolicy } from '../automation/strategyStore';

function Threshold({ testId, value, change }: { testId: string; value: number; change: (v: number) => void }) {
  return <input type="number" min={0} max={100} value={value} data-testid={testId}
    onChange={e => change(Math.max(0, Math.min(100, Math.round(Number(e.currentTarget.value) || 0))))} />;
}

export function InventoryRules({ items, policy = DEFAULT_INVENTORY_POLICY, save }: {
  items: SnapshotItem[]; policy?: InventoryPolicy; save: (v: InventoryPolicy) => void;
}) {
  const ids = [...new Set([...items.map(it => it.itemId), ...policy.keep, ...policy.deposit,
    ...[policy.hpItem, policy.staminaItem].filter((id): id is number => id != null)])];
  const name = (id: number) => items.find(it => it.itemId === id)?.name ?? `#${id}`;
  const toggle = (key: 'keep' | 'deposit', id: number, checked: boolean) => {
    const other = key === 'keep' ? 'deposit' : 'keep';
    save({ ...policy, [key]: checked ? [...policy[key], id] : policy[key].filter(x => x !== id),
      [other]: checked ? policy[other].filter(x => x !== id) : policy[other] });
  };
  return <section data-testid="f10-inventory-rules">
    <h2>背包補給與存倉</h2>
    <p className="muted">依角色設定。低於門檻時使用指定道具，0% 關閉。補給用道具保留在背包。</p>
    <div className="f10-controls">
      {(['hp', 'stamina'] as const).map(stat => {
        const label = stat === 'hp' ? '生命' : '體力（飽食度）';
        const item = stat === 'hp' ? 'hpItem' : 'staminaItem';
        const threshold = stat === 'hp' ? 'hpThreshold' : 'staminaThreshold';
        return <div className="f10-rule" key={stat}>
          <label>{label}恢復道具<select data-testid={`f10-${stat}-item`} value={policy[item] ?? ''}
            onChange={e => save({ ...policy, [item]: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">未指定</option>{ids.map(id => <option key={id} value={id}>{name(id)}</option>)}
          </select></label>
          <label>{label}低於 (%)<Threshold testId={`f10-${stat}-threshold`} value={policy[threshold]}
            change={v => save({ ...policy, [threshold]: v })} /></label>
        </div>;
      })}
    </div>
    {ids.map(id => <div key={id} className="f10-policy-row">
      <span>{name(id)}</span>
      {(['keep', 'deposit'] as const).map(key => <label key={key}>
        <input type="checkbox" data-testid={`f10-${key}-${id}`} checked={policy[key].includes(id)}
          disabled={key === 'deposit' && (policy.hpItem === id || policy.staminaItem === id)}
          onChange={e => toggle(key, id, e.currentTarget.checked)} />{key === 'keep' ? '留在背包' : '自動存倉'}
      </label>)}
    </div>)}
  </section>;
}

export function SkillPriorities({ skills, policy = DEFAULT_SKILL_POLICY, save }: {
  skills: StaticSkillSummary[]; policy?: SkillPolicy; save: (v: SkillPolicy) => void;
}) {
  return <section data-testid="f10-skill-policy"><h2>自動戰鬥優先序</h2>
    <p className="muted">攻擊策略下，低血時優先使用指定的輔助技能，再用主攻技能。等級或 MP 不足時改用可用動作。</p>
    <div className="f10-controls">
      {(['attack', 'heal'] as const).map(role => <label key={role}>{role === 'attack' ? '主攻' : '低血量優先使用的輔助'}技能
        <select data-testid={`f10-${role}-skill`} value={policy[role] ?? ''}
          onChange={e => save({ ...policy, [role]: e.target.value || null })}>
          <option value="">{role === 'attack' ? '普通攻擊' : '關閉'}</option>
          {skills.filter(s => isAllySkill(s) === (role === 'heal')).map(s =>
            <option key={skillKey(s)} value={skillKey(s)}>{s.name} · MP {s.mpCost}</option>)}
        </select>
      </label>)}
      <label>輔助技能生命門檻 (%)<Threshold testId="f10-heal-threshold" value={policy.healThreshold}
        change={v => save({ ...policy, healThreshold: v })} /></label>
    </div>
  </section>;
}
