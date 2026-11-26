/** F16：把 `WineBridgeClient` 接到採集循環的 ports。 */
import type { WineBridgeClient } from './wineBridgeClient';
import { buildWalkToBody } from './pathfinding';
import type { GatherPorts, WorkObservation } from './gatherLoop';

export function observeClient(client: WineBridgeClient, now: () => number = Date.now): WorkObservation {
  const snap = client.getSnapshot();
  const st = snap.connState === 'CONNECTED' ? snap.status : null;
  return {
    nowMs: now(),
    connected: snap.connState === 'CONNECTED',
    scene: st?.scene ?? null,
    nav: st?.nav ?? null,
    gather: st?.gather ?? null,
    supply: st?.supply ?? null,
    here: st?.nav?.mapId && st.nav.currentPos
      ? { mapId: st.nav.mapId, x: st.nav.currentPos[0], y: st.nav.currentPos[1] }
      : null,
    trainingStopReason: st?.stopReason ?? null,
    trainingRunning: Boolean(st?.running),
  };
}

export function clientGatherPorts(client: WineBridgeClient, now: () => number = Date.now): GatherPorts {
  return {
    observe: () => observeClient(client, now),
    walkTo: target => client.walkTo(buildWalkToBody({ mapId: target.mapId, targetX: target.x, targetY: target.y })),
    walkStop: () => client.walkStop('user_stopped'),
    gatherStart: spot => client.gatherStart(spot),
    gatherStop: () => client.gatherStop('user_stopped'),
    huntStart: () => client.start(),
    huntStop: () => client.stop('resupply'),
    resupply: plan => client.resupplyStart(plan),
  };
}
