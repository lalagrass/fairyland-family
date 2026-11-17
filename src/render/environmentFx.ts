export type TimeOfDayMode = 'day' | 'dusk' | 'night' | 'auto';
export type WeatherMode = 'clear' | 'rain' | 'mist';

export interface AmbientLighting {
  period: 'day' | 'dusk' | 'night';
  tintColor: number;
  alpha: number;
  warmGlowAlpha: number;
}

export interface WeatherDrop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  alpha: number;
}

export function resolveAmbientLighting(mode: TimeOfDayMode, hourLocal: number): AmbientLighting {
  let period: 'day' | 'dusk' | 'night';
  if (mode === 'auto') {
    if (hourLocal >= 17 && hourLocal < 20) period = 'dusk';
    else if (hourLocal >= 20 || hourLocal < 6) period = 'night';
    else period = 'day';
  } else {
    period = mode;
  }

  switch (period) {
    case 'dusk':
      return { period, tintColor: 0xff8c42, alpha: 0.14, warmGlowAlpha: 0.25 };
    case 'night':
      return { period, tintColor: 0x101d3b, alpha: 0.36, warmGlowAlpha: 0.45 };
    case 'day':
    default:
      return { period, tintColor: 0xffffff, alpha: 0, warmGlowAlpha: 0 };
  }
}

/** 純函式產生指定時間點的雨絲／霧氣顯示粒子座標（僅視覺呈現，不碰規則）。 */
export function computeWeatherParticles(
  weather: WeatherMode,
  viewW: number,
  viewH: number,
  nowMs: number,
): WeatherDrop[] {
  if (weather === 'clear' || viewW <= 0 || viewH <= 0) return [];
  const t = nowMs / 1000;
  const out: WeatherDrop[] = [];

  if (weather === 'rain') {
    const count = 48;
    for (let i = 0; i < count; i += 1) {
      const seedX = ((i * 73 + 19) % 97) / 97;
      const seedY = ((i * 41 + 7) % 89) / 89;
      const vx = -140;
      const vy = 540;
      const x = ((seedX * viewW + t * vx) % viewW + viewW) % viewW;
      const y = ((seedY * viewH + t * vy) % viewH + viewH) % viewH;
      out.push({ x, y, vx, vy, length: 14, alpha: 0.45 });
    }
    return out;
  }

  // mist
  const count = 14;
  for (let i = 0; i < count; i += 1) {
    const seedX = ((i * 61 + 11) % 83) / 83;
    const seedY = ((i * 37 + 5) % 79) / 79;
    const vx = 18;
    const vy = 4;
    const x = ((seedX * viewW + t * vx) % viewW + viewW) % viewW;
    const y = ((seedY * viewH + t * vy) % viewH + viewH) % viewH;
    out.push({ x, y, vx, vy, length: 48 + (i % 4) * 16, alpha: 0.14 });
  }
  return out;
}
