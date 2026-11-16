import { FamilyController } from './controller';
import { BroadcastTransport } from './transport/broadcast';
import type { Transport } from './transport/types';
import { mountUi } from './ui';
import type { ReplayFixture } from './transport/replay';

async function createTransport(): Promise<{ transport: Transport; mode: string }> {
  const q = new URLSearchParams(location.search);
  if (q.get('replay') === '1') {
    // 假 fairyland：不需要遊戲分頁，按錄好的事件序列重播（?speed=2 加速、?loop=1 循環）。
    const [{ ReplayTransport }, fixture] = await Promise.all([
      import('./transport/replay'),
      import('../fixtures/replay_village.json'),
    ]);
    const speed = Number(q.get('speed') || '1');
    return { transport: new ReplayTransport(fixture.default as unknown as ReplayFixture, { speed, loop: q.get('loop') === '1' }), mode: `回放模式 ×${speed}` };
  }
  return { transport: new BroadcastTransport(), mode: '連線 fairyland 分頁' };
}

const { transport, mode } = await createTransport();
const root = document.getElementById('app')!;
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
const ui = mountUi(root, mode, action => controller.perform(action), text => controller.parseAndSend(text));
const controller = new FamilyController(transport, {
  storage,
  onChange: s => ui.render(s, controller.status(), {
    nav: controller.navStatus(),
    strategy: controller.strategy(),
    known: controller.directory.knownElsewhere(s.location?.mapId ?? null),
    queue: controller.queueStatus(),
    queues: controller.queueStatuses(),
    activeQuestId: controller.activeQuest(),
  }),
});
controller.start();
setInterval(() => controller.tick(), 500);
window.addEventListener('pagehide', () => controller.stop());
(window as unknown as { __family: unknown }).__family = { controller };
