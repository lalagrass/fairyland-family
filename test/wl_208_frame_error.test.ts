import { WineBridgeClient, FrameUnavailableError, frameErrorHint } from '../src/wine/wineBridgeClient';
import { assert, done, suite } from './helpers';

function clientWith(status: number, body: unknown): WineBridgeClient {
  const fetchFn = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const c = new WineBridgeClient({ fetchFn });
  (c as unknown as { snapshot: { baseUrl: string } }).snapshot.baseUrl = 'http://127.0.0.1:4182';
  return c;
}

suite('208 /frame 503 顯示螢幕錄製權限提示');
const ac = new AbortController();
{
  let err: unknown;
  try {
    await clientWith(503, { ok: false, error: 'no frame available', reason: 'screen_recording_or_window_missing', screenRecordingSuspected: true }).fetchFrame(false, ac.signal);
  } catch (e) { err = e; }
  assert(err instanceof FrameUnavailableError, '503 丟出 FrameUnavailableError');
  const hint = frameErrorHint(err) ?? '';
  assert(hint.includes('螢幕錄製') && hint.includes('系統設定') && hint.includes('screen_recording_or_window_missing'), '提示含設定路徑與橋接回報原因');
}
{
  let err: unknown;
  try { await clientWith(503, 'not json').fetchFrame(false, ac.signal); } catch (e) { err = e; }
  assert(err instanceof FrameUnavailableError && frameErrorHint(err) === null, '舊橋接（沒有診斷欄位）的 503 沿用面板原本的提示');
}
{
  let err: unknown;
  try { await clientWith(503, { ok: false, reason: 'capture_failed', screenRecordingSuspected: false }).fetchFrame(false, ac.signal); } catch (e) { err = e; }
  const hint = frameErrorHint(err) ?? '';
  assert(hint.includes('capture_failed') && !hint.includes('系統設定'), '非權限原因只顯示原因');
}
{
  let err: unknown;
  try { await clientWith(429, { ok: false }).fetchFrame(false, ac.signal); } catch (e) { err = e; }
  assert(err instanceof Error && !(err instanceof FrameUnavailableError) && frameErrorHint(err) === null, '其他錯誤維持原行為');
}
done();
