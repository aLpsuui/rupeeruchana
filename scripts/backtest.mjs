// ============================================================================
// Rupeeruchana — geçmiş veri backtest'i
// Canlı motorun KENDİ fonksiyonlarını kullanır: sinyal kararı update.mjs →
// analyzeCoin, işlem takibi executor.mjs → scanBars / sizeTrade / tradeCosts.
// Kuralların kopyası yok; motor değişirse backtest de onunla değişir.
//
// Geçmişi 4 saatlik kapanış kapanış yeniden oynatır ve her kapanışta motorun o
// anda göreceği pencereyi kurar: son 119 kapanmış gün + son 259 kapanmış 4s mum
// (canlı tur 1d limit=120 / 4h limit=260 çeker, oluşmakta olan mumu atar).
//
// İki amaç:
//   1) strategy/rupeeruchana-v3.pine ile aynı işlem listesini ürettiğini doğrulamak.
//      Sitedeki KPI'lar TradingView Strateji Testçisi'nden geliyor; o sayıların bu
//      motoru anlattığı ancak iki işlem listesi örtüşürse söylenebilir.
//   2) Kural değişikliklerini canlıya almadan önce çok coinde, uzun dönemde ölçmek
//      (varyant taraması: scripts/research.mjs — bu dosyanın fonksiyonlarını kullanır).
//
//   node scripts/backtest.mjs                                   # çekirdek 5 coin, 2022 → bugün
//   node scripts/backtest.mjs --coins all                       # çekirdek + radar (25 coin)
//   node scripts/backtest.mjs --coins BTC,ETH --from 2025-01-01 --to 2026-01-01
//   node scripts/backtest.mjs --target 1.5 --atr 2 --be 1 --timestop 14   # tek varyant
//
// Çıktı: research/backtest-<etiket>.json ve -trades.csv. Mum verisi research/cache/
// altında saklanır (git dışı); sonraki koşular yalnızca eksik mumları çeker.
// data/ klasörüne ve bildirim kanallarına DOKUNMAZ.
//
// Canlı motordan bilinen farklar (küçük, ama sayıları okurken akılda tut):
//   - Canlı tur kapanıştan ~17 dk sonra çalışır; backtest tam kapanış anında karar verir.
//   - Canlı tarama o an oluşmakta olan 1s mumu da görür; backtest yalnızca kapanmışları.
//   - Cüzdan aynası (executor.adoptSignals) sinyalleri en yeniden eskiye dener;
//     backtest eskiden yeniye dener. Yalnızca 4 pozisyon kontenjanı dolduğunda fark eder.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCoin, COINS, ALTS, RULES } from './update.mjs';
import * as executor from './executor.mjs';
import { fetchJson } from './http.mjs';

const API = 'https://data-api.binance.vision/api/v3';
export const HOUR = 3_600_000, H4 = 4 * HOUR, DAY = 24 * HOUR;
const STEP = { '1h': HOUR, '4h': H4, '1d': DAY };
const DAILY_WIN = 119;
const H4_WIN = 259;
const START_BALANCE = 1000;
const CACHE_DIR = new URL('../research/cache/', import.meta.url);
const OUT_DIR = new URL('../research/', import.meta.url);
const STATE_PATH = new URL('../data/state.json', import.meta.url);

// ---------------------------- argümanlar ------------------------------------
export const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const coinsArg = arg('coins', 'core');
export const COIN_LIST = coinsArg === 'core' ? COINS
  : coinsArg === 'all' ? [...COINS, ...ALTS]
  : coinsArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const FROM = arg('from', '2022-01-01');
const TO = arg('to', null);
export const fromMs = Date.parse(FROM);
export const toMs = TO ? Date.parse(TO) : Date.now();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
  console.error(`geçersiz tarih aralığı: --from ${FROM} --to ${TO ?? 'bugün'}`);
  process.exit(1);
}
const LABEL = arg('label', `${coinsArg}_${FROM}_${TO ?? 'bugun'}`).replace(/[^\w.-]/g, '-');

// ---------------------------- mum verisi (önbellekli) -----------------------
async function fetchRange(symbol, interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const page = await fetchJson(
      `${API}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs - 1}&limit=1000`,
      `${symbol} ${interval} geçmiş`
    );
    if (!page.length) break;
    // yalnızca executor.scanBars'ın okuduğu alanlar: [openTime, open, high, low, close]
    for (const k of page) out.push([+k[0], +k[1], +k[2], +k[3], +k[4]]);
    if (page.length < 1000) break;
    cursor = +page.at(-1)[0] + STEP[interval];
  }
  return out;
}

// Yalnızca KAPANMIŞ mumlar döner: canlı motor da oluşmakta olan mumu kararlara katmaz.
export async function history(coin, interval, startMs, endMs) {
  const symbol = `${coin}USDT`;
  const step = STEP[interval];
  const formingOpen = Math.floor(Date.now() / step) * step;
  const limit = Math.min(endMs, formingOpen);
  const file = new URL(`${symbol}-${interval}.json`, CACHE_DIR);

  mkdirSync(CACHE_DIR, { recursive: true });
  let cached = [];
  if (existsSync(file)) {
    try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = []; }
  }
  const head = cached.length && startMs < cached[0][0]
    ? await fetchRange(symbol, interval, startMs, cached[0][0]) : [];
  const tailFrom = cached.length ? cached.at(-1)[0] + step : startMs;
  const tail = tailFrom < limit ? await fetchRange(symbol, interval, tailFrom, limit) : [];

  const byTime = new Map();
  for (const k of [...head, ...cached, ...tail]) if (k[0] < formingOpen) byTime.set(k[0], k);
  const all = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  if (head.length || tail.length) writeFileSync(file, JSON.stringify(all));
  return all.filter(k => k[0] >= startMs && k[0] < limit);
}

// Bir coinin tüm mum verisi (ısınma payıyla). Varyant taraması bunu bir kez çeker.
export async function coinData(coin, start = fromMs, end = toMs) {
  const dataEnd = Math.min(Date.now(), end + 8 * DAY);
  const [d1, h4, h1] = await Promise.all([
    history(coin, '1d', start - (DAILY_WIN + 5) * DAY, dataEnd),
    history(coin, '4h', start - (H4_WIN + 5) * H4, dataEnd),
    history(coin, '1h', start, dataEnd),
  ]);
  return { d1, h4, h1 };
}

// ---------------------------- simülasyon ------------------------------------
const lowerBound = (arr, x) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
};
export const iso = ms => new Date(ms).toISOString();

// Motorun T anında göreceği pencereler. Canlı tur oluşmakta olan mumu da çeker ve
// analyzeCoin son elemanı atar; o yüzden sona "oluşmakta olan mum" eklenir.
function windowsAt(cols, di, j, price) {
  const { dC, dH, dL, hC, hH, hL } = cols;
  return [
    {
      closes: [...dC.slice(di - DAILY_WIN, di), price],
      highs:  [...dH.slice(di - DAILY_WIN, di), price],
      lows:   [...dL.slice(di - DAILY_WIN, di), price],
    },
    {
      closes: [...hC.slice(j - H4_WIN + 1, j + 1), price],
      highs:  [...hH.slice(j - H4_WIN + 1, j + 1), price],
      lows:   [...hL.slice(j - H4_WIN + 1, j + 1), price],
    },
  ];
}

const columns = (d1, h4) => ({
  dT: d1.map(k => k[0]), dH: d1.map(k => k[2]), dL: d1.map(k => k[3]), dC: d1.map(k => k[4]),
  hT: h4.map(k => k[0]), hH: h4.map(k => k[2]), hL: h4.map(k => k[3]), hC: h4.map(k => k[4]),
});

// Tek coinin sinyal sicili — update.mjs'teki `signals` akışının aynısı: her turda
// önce aktif sinyal mum taramasıyla kapatılır, sonra (aktif sinyal yoksa) yeni
// sinyal açılır. Aynı coinde aynı anda tek aktif sinyal olur.
//
// opts.rules   → analyzeCoin kural varyantı (bkz. update.mjs RULES)
// opts.exit    → executor.scanBars seçenekleri ({ timeStopMs, beAtR })
// opts.filter  → (analiz, T) => boolean; false dönerse sinyal alınmaz (ör. rejim filtresi)
export function simulateCoin(coin, d1, h4, h1, opts = {}) {
  const { rules = RULES, exit = {}, filter = null, from = fromMs, to = toMs } = opts;
  const cols = columns(d1, h4);
  const { dT, hT, hC } = cols;
  const t1 = h1.map(k => k[0]);

  const trades = [];
  let active = null, di = 0;

  for (let j = H4_WIN - 1; j < h4.length; j++) {
    const T = hT[j] + H4;                                // karar anı: bu 4s mumunun kapanışı
    if (T < from) continue;
    if (T > to && !active) break;                        // dönem bitti, açık işlem de kalmadı
    while (di < d1.length && dT[di] + DAY <= T) di++;     // di = T anında kapanmış gün sayısı
    if (di < DAILY_WIN) continue;

    if (active) {
      // girişten karar anına kadar kapanmış 1s mumlar (openTime + 1s <= T)
      const bars = h1.slice(lowerBound(t1, active.ts), lowerBound(t1, T - HOUR + 1));
      const r = executor.scanBars(bars, {
        dir: active.dir, stop: active.stop, target: active.target, entry: active.entry,
        startMs: active.ts, nowMs: T, ...exit,
      });
      if (r.outcome) {
        const R = Math.abs(active.entry - active.stop);
        const sign = active.dir === 'LONG' ? 1 : -1;
        trades.push({
          coin, ...active,
          outcome: r.outcome, exit: r.exit, exitBarMs: r.exitMs, closedMs: T,
          bars: r.bars, mfeR: r.mfeR, maeR: r.maeR,
          r: +(sign * (r.exit - active.entry) / R).toFixed(3),
        });
        active = null;
      }
    }
    if (T > to) continue;

    const price = hC[j]; // canlı tur: oluşmakta olan günlük mumun son fiyatı ≈ bu 4s kapanışı
    const [daily, h4w] = windowsAt(cols, di, j, price);
    const a = analyzeCoin(coin, daily, h4w, rules);
    if (a.signal && !active && (!filter || filter(a, T))) {
      active = { dir: a.signal.dir, entry: a.signal.entry, stop: a.signal.stop, target: a.signal.target, ts: T };
    }
  }
  return { trades, open: active };
}

// Her 4s kapanışında piyasa rejimi: fiyat günlük EMA50'nin üstünde mi?
// (dip radarının bulgusu: koşulun kazanıp kazanmadığını belirleyen tek değişken bu.)
export function regimeSeries(coin, d1, h4, rules = RULES) {
  const cols = columns(d1, h4);
  const { dT, hT, hC } = cols;
  const map = new Map();
  let di = 0;
  for (let j = H4_WIN - 1; j < h4.length; j++) {
    const T = hT[j] + H4;
    while (di < d1.length && dT[di] + DAY <= T) di++;
    if (di < DAILY_WIN) continue;
    const [daily, h4w] = windowsAt(cols, di, j, hC[j]);
    const a = analyzeCoin(coin, daily, h4w, rules);
    map.set(T, a.price > a.dailyEma ? 'boga' : 'ayi');
  }
  return map;
}

// Sabit risk boyutlamasında maliyet, R cinsinden ölçekten bağımsızdır:
// 100$ risk için nominal = 100 × giriş / |giriş − stop|. Kapanış zamanı olarak
// canlı cüzdan gibi (executor.reconcile) çıkış mumunun açılış zamanı kullanılır.
export function netR(t) {
  const notional = 100 * t.entry / Math.abs(t.entry - t.stop);
  return t.r - executor.tradeCosts({ notional, openMs: t.ts, closeMs: t.exitBarMs }).costUsd / 100;
}

export function statsR(trades) {
  if (!trades.length) return { trades: 0 };
  const sorted = [...trades].sort((a, b) => a.closedMs - b.closedMs);
  const gross = sorted.map(t => t.r);
  const net = sorted.map(netR);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const pf = a => {
    const w = sum(a.filter(x => x > 0)), l = -sum(a.filter(x => x < 0));
    return l > 0 ? +(w / l).toFixed(2) : null;
  };
  let eq = 0, peak = 0, dd = 0;
  for (const x of net) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const diag = executor.summarize(sorted.map((t, i) => ({
    outcome: t.outcome, mfeR: t.mfeR, maeR: t.maeR, bars: t.bars, pnl: net[i],
  })));
  return {
    trades: sorted.length, hedef: diag.hedef, stop: diag.stop, sure: diag.sure, winRate: diag.winRate,
    sumR: +sum(gross).toFixed(2), sumRNet: +sum(net).toFixed(2),
    avgRNet: +(sum(net) / sorted.length).toFixed(3),
    pf: pf(gross), pfNet: pf(net), maxDdRNet: +dd.toFixed(2),
    missAvgMfeR: diag.missAvgMfeR, avgBars: diag.avgBars,
  };
}

// Sanal cüzdan — executor'ın canlı davranışı: işlem başına bakiyenin %2'si riske
// edilir, en fazla 4 açık pozisyon. Her turda önce kapananlar işlenir (reconcile),
// sonra karşılığı olmayan AKTİF sinyaller açılır (adoptSignals): kontenjan dolu
// olduğu için kaçan sinyal, sinyal hâlâ aktifken yer açılırsa ORİJİNAL girişle açılır.
export function simulateWallet(trades) {
  let balance = START_BALANCE, peak = START_BALANCE, maxDdPct = 0, late = 0;
  const open = [], opened = new Set();
  const byEntry = [...trades].sort((a, b) => a.ts - b.ts || COIN_LIST.indexOf(a.coin) - COIN_LIST.indexOf(b.coin));

  const settle = untilMs => {
    open.sort((a, b) => a.t.closedMs - b.t.closedMs);
    while (open.length && open[0].t.closedMs <= untilMs) {
      const { t, size } = open.shift();
      const gross = (t.dir === 'LONG' ? 1 : -1) * (t.exit - t.entry) * size.qty;
      const cost = executor.tradeCosts({ notional: size.notional, openMs: t.ts, closeMs: t.exitBarMs }).costUsd;
      balance = +(balance + gross - cost).toFixed(2);
      peak = Math.max(peak, balance);
      maxDdPct = Math.max(maxDdPct, ((peak - balance) / peak) * 100);
    }
  };

  const times = [...new Set(trades.flatMap(t => [t.ts, t.closedMs]))].sort((a, b) => a - b);
  for (const now of times) {
    settle(now);
    for (const t of byEntry) {
      if (t.ts > now) break;
      if (opened.has(t) || t.closedMs <= now || open.length >= executor.MAX_POSITIONS) continue;
      if (open.some(p => p.t.coin === t.coin)) continue;
      const size = executor.sizeTrade({ balance, entry: t.entry, stop: t.stop });
      if (!size || size.riskUsd < 0.01) continue;
      open.push({ t, size });
      opened.add(t);
      if (t.ts < now) late++;
    }
  }
  settle(Infinity);
  return {
    start: START_BALANCE, balance,
    returnPct: +(((balance / START_BALANCE) - 1) * 100).toFixed(1),
    maxDdPct: +maxDdPct.toFixed(1),
    opened: opened.size, openedLate: late, missed: trades.length - opened.size,
  };
}

// ---------------------------- rapor -----------------------------------------
const pad = (v, n) => String(v ?? '—').padStart(n);
const row = (name, s) =>
  `${name.padEnd(7)}${pad(s.trades, 7)}${pad(s.winRate != null ? `${s.winRate}%` : null, 9)}` +
  `${pad(s.sumRNet, 9)}${pad(s.avgRNet, 9)}${pad(s.pfNet, 8)}${pad(s.maxDdRNet, 9)}${pad(s.missAvgMfeR, 10)}`;

export function tradeRow(t) {
  return {
    coin: t.coin, dir: t.dir, entryTime: iso(t.ts), entry: t.entry, stop: t.stop, target: t.target,
    outcome: t.outcome, exit: t.exit, exitBar: iso(t.exitBarMs), closedAt: iso(t.closedMs),
    bars: t.bars, r: t.r, rNet: +netR(t).toFixed(3), mfeR: t.mfeR, maeR: t.maeR,
  };
}

async function main() {
  // komut satırından tek varyant denemek için (varsayılanlar = canlı kurallar)
  const rules = { ...RULES };
  if (arg('target', null)) rules.targetR = +arg('target');
  if (arg('atr', null)) rules.atrMult = +arg('atr');
  const exit = {};
  if (arg('be', null)) exit.beAtR = +arg('be');
  if (arg('timestop', null)) exit.timeStopMs = +arg('timestop') * DAY;
  const variant = JSON.stringify({ ...rules, ...exit }) !== JSON.stringify(RULES);

  const perCoin = {}, openAtEnd = [];
  let allTrades = [];
  for (const coin of COIN_LIST) {
    try {
      const { d1, h4, h1 } = await coinData(coin);
      const { trades, open } = simulateCoin(coin, d1, h4, h1, { rules, exit });
      perCoin[coin] = statsR(trades);
      allTrades = allTrades.concat(trades);
      if (open) openAtEnd.push({ coin, ...open, ts: iso(open.ts) });
      console.log(`${coin}: ${trades.length} işlem (${d1.length} gün · ${h4.length} 4s · ${h1.length} 1s mum)`);
    } catch (e) {
      console.error(`${coin} atlandı: ${e.message}`);
    }
  }

  const total = statsR(allTrades);
  const wallet = simulateWallet(allTrades);

  console.log(`\nBACKTEST ${FROM} → ${TO ?? 'bugün'} · kurallar: update.mjs analyzeCoin${variant ? ` (VARYANT: ${JSON.stringify({ ...rules, ...exit })})` : ''} · R = işlem başına risk birimi`);
  console.log(`${'coin'.padEnd(7)}${pad('işlem', 7)}${pad('isabet', 9)}${pad('ΣR net', 9)}${pad('ort R', 9)}${pad('PF net', 8)}${pad('maxDD R', 9)}${pad('kaçan MFE', 10)}`);
  for (const c of Object.keys(perCoin)) console.log(row(c, perCoin[c]));
  console.log(row('TOPLAM', total));
  console.log(`\nSanal cüzdan (%2 risk, en fazla ${executor.MAX_POSITIONS} pozisyon, komisyon + fonlama): ` +
    `${wallet.start}$ → ${wallet.balance}$ (${wallet.returnPct >= 0 ? '+' : ''}${wallet.returnPct}%), ` +
    `en büyük düşüş %${wallet.maxDdPct} · açılan ${wallet.opened}, geç açılan ${wallet.openedLate}, kontenjandan kaçan ${wallet.missed}`);
  if (openAtEnd.length) console.log(`Dönem sonunda açık: ${openAtEnd.map(o => `${o.coin} ${o.dir}`).join(', ')}`);
  try {
    const kpi = JSON.parse(readFileSync(STATE_PATH, 'utf8')).kpi;
    if (kpi) console.log(`Karşılaştırma — sitedeki KPI (TradingView backtest): ${kpi.trades} işlem, isabet %${kpi.win_rate}, PF ${kpi.profit_factor}, getiri %${kpi.return_pct}`);
  } catch {}

  const rows = allTrades.sort((a, b) => a.ts - b.ts).map(tradeRow);
  const base = `backtest-${LABEL}${variant ? '-varyant' : ''}`;
  writeFileSync(new URL(`${base}.json`, OUT_DIR), JSON.stringify({
    generated: iso(Date.now()), from: FROM, to: TO ?? iso(toMs), coins: COIN_LIST,
    rules: 'scripts/update.mjs analyzeCoin (v3) + executor.scanBars',
    variant: variant ? { ...rules, ...exit } : null,
    total, perCoin, wallet, openAtEnd, trades: rows,
  }, null, 2) + '\n');
  const cols = Object.keys(rows[0] ?? {});
  if (cols.length) {
    writeFileSync(new URL(`${base}-trades.csv`, OUT_DIR),
      [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n') + '\n');
  }
  console.log(`\nyazıldı: research/${base}.json${cols.length ? ` · research/${base}-trades.csv` : ''}`);
}

// Doğrudan çalıştırıldığında rapor üretir; içe aktarıldığında (research.mjs) sadece
// fonksiyonlarını verir.
const isMain = process.argv[1]
  && (process.platform === 'win32'
    ? fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
    : fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) main().catch(e => { console.error('BACKTEST BAŞARISIZ:', e.message); process.exit(1); });
