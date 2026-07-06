// Technical indicators used by the scanner and agents. Pure functions.

export function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i];
  return sum / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return sum / period;
}

/** Rate of change over `period` bars, as a fraction. */
export function roc(closes, period = 10) {
  if (closes.length < period + 1) return null;
  const past = closes[closes.length - 1 - period];
  if (!past) return null;
  return (closes[closes.length - 1] - past) / past;
}

export function highestHigh(candles, period) {
  const slice = candles.slice(-period);
  return slice.length ? Math.max(...slice.map((c) => c.high)) : null;
}

export function lowestLow(candles, period) {
  const slice = candles.slice(-period);
  return slice.length ? Math.min(...slice.map((c) => c.low)) : null;
}

/**
 * Liquidity sweep detection: price wicks beyond a recent extreme then closes
 * back inside the prior range — a classic stop-hunt signature.
 */
export function detectLiquiditySweep(candles, lookback = 20) {
  if (candles.length < lookback + 2) return { swept: false };
  const last = candles[candles.length - 1];
  const prior = candles.slice(-(lookback + 1), -1);
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));

  if (last.high > priorHigh && last.close < priorHigh) {
    return { swept: true, side: 'high', level: priorHigh, bias: 'SHORT' };
  }
  if (last.low < priorLow && last.close > priorLow) {
    return { swept: true, side: 'low', level: priorLow, bias: 'LONG' };
  }
  return { swept: false };
}
