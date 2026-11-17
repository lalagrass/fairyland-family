import type { PluginMessage } from '../../protocol/index';
import type { AutomationHostContext, BehaviorModule } from '../types';

/**
 * 範例擴充模組：飽食度／低血警戒檢查（示範 FM-A「新增一種行為只需加一個模組」）。
 * 不更動 controller / navigator / queue 核心程式碼，只需註冊進 AutomationRegistry 即可運作。
 */
export class ExampleRestMonitorModule implements BehaviorModule {
  readonly id = 'example-rest-monitor';
  readonly label = '自動休息警戒（範例模組）';
  readonly priority = 40;
  readonly category = 'RESTING' as const;

  private lastWarnAt = 0;
  private restNeeded = false;

  isActive(): boolean {
    return this.restNeeded;
  }

  getSummary(): string {
    return this.restNeeded ? '低飽食或低血量警戒中' : '狀態健康';
  }

  onMessage(msg: PluginMessage, ctx: AutomationHostContext): void {
    if (msg.kind !== 'snapshot') return;
    const st = ctx.state();
    const c = st.character;
    if (!c) {
      this.restNeeded = false;
      return;
    }
    const cfg = ctx.getStrategyConfig(st.characterId);
    const satiety = c.satiety ?? 100;
    const lowSatiety = cfg.autoRestMinSatiety > 0 && satiety <= cfg.autoRestMinSatiety;
    const lowHp =
      cfg.lowHpRetreatPct > 0 &&
      c.hp !== null &&
      c.maxHp !== null &&
      c.maxHp > 0 &&
      (c.hp / c.maxHp) * 100 <= cfg.lowHpRetreatPct;

    this.restNeeded = Boolean(lowSatiety || lowHp);
    if (this.restNeeded) {
      const now = ctx.now();
      if (now - this.lastWarnAt > 5000) {
        this.lastWarnAt = now;
        ctx.log(
          lowSatiety
            ? `飽食度 ${satiety} ≤ 設定門檻 ${cfg.autoRestMinSatiety}，建議回城補給`
            : `血量偏低（門檻 ${cfg.lowHpRetreatPct}%），建議回城休養`,
          'warn',
        );
      }
    }
  }

  stop(): void {
    this.restNeeded = false;
  }
}
