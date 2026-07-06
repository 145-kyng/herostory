// Voice command layer. The dashboard captures speech with the Web Speech API
// and POSTs the transcript to /api/command/voice; this module parses "Doris"
// commands into system actions. Also usable as plain text commands.

const WAKE_WORD = 'doris';

export function parseCommand(transcript) {
  if (!transcript || typeof transcript !== 'string') return { action: 'unknown', args: {} };
  const text = transcript.toLowerCase().replace(/[^a-z0-9\s_/.-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text.includes(WAKE_WORD)) return { action: 'ignored', args: { reason: 'no wake word' } };
  const cmd = text.slice(text.indexOf(WAKE_WORD) + WAKE_WORD.length).trim();

  if (/\b(emergency stop|kill switch|kill everything|shut it down)\b/.test(cmd)) {
    return { action: 'kill_switch', args: {} };
  }
  if (/\b(stop trading|pause trading|pause|stand down)\b/.test(cmd)) {
    return { action: 'pause', args: {} };
  }
  if (/\b(resume trading|resume|start trading|carry on)\b/.test(cmd)) {
    return { action: 'resume', args: {} };
  }
  if (/\bscan (the )?markets?\b/.test(cmd) || /\brun a scan\b/.test(cmd)) {
    return { action: 'scan', args: {} };
  }
  if (/\bclose (all|everything|all positions)\b/.test(cmd)) {
    return { action: 'close_all', args: {} };
  }
  if (/\bstatus\b|\breport\b|\bhow are we doing\b/.test(cmd)) {
    return { action: 'status', args: {} };
  }

  // "execute gold setup", "execute eur usd setup", "execute the euro dollar setup"
  const exec = cmd.match(/\bexecute (?:the )?(.+?)(?: setup| trade)?$/);
  if (exec) {
    const symbol = resolveSymbol(exec[1]);
    if (symbol) return { action: 'execute_setup', args: { symbol } };
    return { action: 'unknown', args: { reason: `could not resolve symbol from "${exec[1]}"` } };
  }

  const close = cmd.match(/\bclose (?:the )?(.+?)(?: position| trade)?$/);
  if (close) {
    const symbol = resolveSymbol(close[1]);
    if (symbol) return { action: 'close_symbol', args: { symbol } };
  }

  return { action: 'unknown', args: { transcript: cmd } };
}

const ALIASES = {
  gold: 'XAU_USD',
  silver: 'XAG_USD',
  platinum: 'XPT_USD',
  copper: 'XCU_USD',
  bitcoin: 'BTC_USD',
  btc: 'BTC_USD',
  ethereum: 'ETH_USD',
  eth: 'ETH_USD',
  'euro dollar': 'EUR_USD',
  eurodollar: 'EUR_USD',
  euro: 'EUR_USD',
  cable: 'GBP_USD',
  pound: 'GBP_USD',
  yen: 'USD_JPY',
  'dollar yen': 'USD_JPY',
  aussie: 'AUD_USD',
  kiwi: 'NZD_USD',
  loonie: 'USD_CAD',
  swissy: 'USD_CHF',
  nasdaq: 'NAS100_USD',
  'nas 100': 'NAS100_USD',
  spx: 'SPX500_USD',
  'sp 500': 'SPX500_USD',
  's and p': 'SPX500_USD',
  dow: 'US30_USD',
  dax: 'DE30_EUR',
  footsie: 'UK100_GBP',
  nikkei: 'JP225_USD',
};

export function resolveSymbol(phrase) {
  const p = phrase.toLowerCase().trim();
  if (ALIASES[p]) return ALIASES[p];
  for (const [alias, symbol] of Object.entries(ALIASES)) {
    if (p.includes(alias)) return symbol;
  }
  // "eur usd", "eur/usd", "eur_usd"
  const pair = p.replace(/[/\s.-]+/g, '_').toUpperCase();
  if (/^[A-Z0-9]{2,6}_[A-Z]{3}$/.test(pair)) return pair;
  return null;
}
