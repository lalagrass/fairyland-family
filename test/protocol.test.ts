import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, isCommandMessage, isEventMessage, isHeartbeatMessage, isCommandResultMessage, isSnapshotMessage, isStaticDataMessage, isPluginMessage } from '../src/protocol/index';
import ex from '../src/protocol/examples.json';
import { assert, done, suite } from './helpers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

suite('vendored protocol examples pass the vendored guards');
assert(PROTOCOL_VERSION === 7, 'protocol version 7');
assert(isHeartbeatMessage(ex.heartbeat), 'heartbeat');
assert(isSnapshotMessage(ex.snapshot), 'snapshot');
assert(isStaticDataMessage(ex.staticData), 'staticData');
assert(ex.events.every(isEventMessage), 'events');
assert(ex.commands.every(isCommandMessage), 'commands');
assert(ex.commandResults.every(isCommandResultMessage), 'command results');
assert(!isPluginMessage({ kind: 'event', v: PROTOCOL_VERSION }), 'garbage rejected');

suite('replay fixture only contains valid messages');
const fx = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/replay_village.json'), 'utf8'));
assert(fx.format === 'fairyland-replay/1' && fx.protocolVersion === PROTOCOL_VERSION && fx.steps.length > 5, 'fixture shape');
assert(fx.steps.every((s: any) => isPluginMessage(s.message)), 'every replay step passes the guards');
assert(fx.steps.every((s: any, i: number, a: any[]) => i === 0 || a[i - 1].at <= s.at), 'steps are time ordered');
assert(fx.steps.every((s: any) => s.message.characterId === fx.characterId), 'single characterId');

suite('protocol copy headers');
for (const f of ['types.ts', 'guards.ts', 'idempotency.ts', 'index.ts']) {
  const head = fs.readFileSync(path.join(root, 'src/protocol', f), 'utf8').split('\n').slice(0, 2);
  assert(head.every(l => l.startsWith('// [sync-protocol]')) && /@ [0-9a-f]{7,}/.test(head[1]), `${f} records source path and commit`);
}

suite('check-protocol (skips without sibling fairyland, fails when out of sync)');
const run = (env: Record<string, string>) => spawnSync('node', ['scripts/sync-protocol.mjs', '--check'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
assert(run({ FL_FAIRYLAND_DIR: '/nonexistent-fairyland' }).status === 0, 'no sibling repo -> skipped, exit 0');
const sib = path.resolve(root, '..', 'fairyland');
if (fs.existsSync(path.join(sib, 'packages/shared/src/protocol'))) {
  assert(run({}).status === 0, 'in sync with the sibling fairyland');
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'fl-proto-'));
  fs.mkdirSync(path.join(tmp, 'packages/shared/src'), { recursive: true });
  fs.cpSync(path.join(sib, 'packages/shared/src/protocol'), path.join(tmp, 'packages/shared/src/protocol'), { recursive: true });
  fs.appendFileSync(path.join(tmp, 'packages/shared/src/protocol/types.ts'), '\nexport const DRIFT = 1;\n');
  const r = run({ FL_FAIRYLAND_DIR: tmp });
  assert(r.status === 1 && /types\.ts/.test(r.stderr), 'a drifted source makes check-protocol fail');
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('  (沒有並排的 fairyland，略過同步檢查的正向案例)');
}
done();
