import { parseWorkbenchTab } from '../src/workbenchTab';
import { assert, done, suite } from './helpers';

suite('WL-L1 網址指定工作台分頁');
{
  assert(parseWorkbenchTab('#tab=wine', '') === 'wine', '#tab=wine');
  assert(parseWorkbenchTab('', '?tab=wine') === 'wine', '?tab=wine');
  assert(parseWorkbenchTab('#tab=path', '?tab=wine') === 'path', '兩者都有時以 # 為準');
  assert(parseWorkbenchTab('#x=1&tab=gather', '') === 'gather', '與其他參數並存');
  assert(parseWorkbenchTab('#tab=bogus', '') === null, '不認得的分頁名忽略');
  assert(parseWorkbenchTab('', '') === null, '沒帶參數回傳 null');
  assert(parseWorkbenchTab('#tab=bogus', '?tab=skills') === 'skills', '# 無效時退到 ?tab');
}

done();
