// Market regime classification from candles: trending / ranging / volatile.
import { ema, atr, sma } from './indicators.js';

export const REGIMES = Object.freeze({
  TRENDING_UP: 'trending_up',
  TRENDING_DOWN: 'trending_down',
  RANGING: 'ranging',
  VOLATILE: 'volatile',
  UNKNOWN: 'unknown',
});

export function classifyRegime(candles) {
  if (!candles || candles.length < 60) return { regime: REGIMES.UNKNOWN, strength: 0 };
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const currentAtr = atr(candles, 14);
  const price = closes[closes.length - 1];

  // Volatility expansion: current ATR vs its own recent average.
  const atrSeries = [];
  for (let i = 20; i <= candles.length; i += 1) {
    const a = atr(candles.slice(0, i), 14);
    if (a) atrSeries.push(a);
  }
  const avgAtr = sma(atrSeries, Math.min(30, atrSeries.length)) || currentAtr;
  const volRatio = avgAtr ? currentAtr / avgAtr : 1;

  const separation = Math.abs(fast - slow) / (currentAtr || 1e-9);

  if (volRatio > 1.8) {
    return { regime: REGIMES.VOLATILE, strength: Math.min(100, Math.round(volRatio * 40)), volRatio };
  }
  if (separation > 0.8) {
    const up = fast > slow && price > fast;
    const down = fast < slow && price < fast;
    if (up) return { regime: REGIMES.TRENDING_UP, strength: Math.min(100, Math.round(separation * 40)), volRatio };
    if (down) return { regime: REGIMES.TRENDING_DOWN, strength: Math.min(100, Math.round(separation * 40)), volRatio };
  }
  return { regime: REGIMES.RANGING, strength: Math.max(0, Math.round(60 - separation * 30)), volRatio };
}
