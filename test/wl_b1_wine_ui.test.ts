import { formatWineStopReason } from '../src/wine/wineBridgeClient';
import { startBlockedReason } from '../src/panels/WineTrainingPanel';
import { assert, done, suite } from './helpers';

suite('WL-B1 一鍵開始按不了時要說明原因');
{
  assert(startBlockedReason(false, false, false)?.includes('橋接') === true, '未連線時說明要開官方視窗或連線橋接');
  assert(startBlockedReason(false, true, false)?.includes('連線') === true, '連線中提示');
  assert(startBlockedReason(true, false, true)?.includes('停止') === true, '練功中提示先停止');
  assert(startBlockedReason(true, false, false) === null, '可以開始時沒有提示');
}

suite('WL-B1 新停機原因有中文說明');
{
  for (const r of ['unrecognized_scene', 'unknown_target', 'missing_result', 'defeat', 'no_available_action']) {
    assert(formatWineStopReason(r) !== r, `${r} 有中文標籤`);
  }
}

done();
