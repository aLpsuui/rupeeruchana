// ============================================================================
// Rupeeruchana — 4 saatlik ajan analiz motoru
// GitHub Actions üzerinde çalışır: Binance halka açık verisiyle v3 swing
// kurallarını hesaplar, data/state.json'ı günceller.
// Kurallar (site ile birebir aynı):
//   LONG : fiyat > günlük EMA50 && EMA50 yükseliyor && son 8 kapalı 4s mumda
//          RSI(14) < 42 görüldü && son kapalı 4s mum EMA21 üzerine kesişti
//   SHORT: ayna görüntüsü (EMA50 altı, düşen EMA, RSI > 58, EMA21 altına kesişim)
//   Risk : stop = 2×ATR(14), hedef = 2,5R
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import * as executor from './executor.mjs';

const COINS = ['BTC', 'ETH', 'SOL', 'LINK', 'DOGE', 'XRP', 'AVAX'];
const WATCH = ['ETH', 'LINK', 'SOL', 'DOGE', 'BTC']; // izleme listesi sırası
const STATE_PATH = new URL('../data/state.json', import.meta.url);
const API = 'https://data-api.binance.vision/api/v3'; // küresel halka açık veri ucu (GitHub runner'larından erişilebilir)

// ---- Anlık bildirim (ntfy.sh — telefonda ntfy uygulamasıyla bu konuya abone ol) ----
const NTFY_TOPIC = 'rupeeruchana-sinyal-f28db1';
async function notify(title, body, tags = 'chart_with_upwards_trend') {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high', Tags: tags },
      body,
    });
  } catch (e) { console.error('bildirim gönderilemedi:', e.message); }
}

// ---------------------------- indikatör matematiği --------------------------
function ema(values, len) {
  const k = 2 / (len + 1);
  const out = [];
  let prev = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    if (i === len - 1) { out.push(prev); continue; }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes, len = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  out[len] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  }
  return out;
}

function atr(highs, lows, closes, len = 14) {
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  // Wilder RMA
  let prev = trs.slice(0, len).reduce((a, b) => a + b, 0) / len;
  const out = new Array(closes.length).fill(null);
  out[len - 1] = prev;
  for (let i = len; i < trs.length; i++) {
    prev = (prev * (len - 1) + trs[i]) / len;
    out[i] = prev;
  }
  return out;
}

// ---------------------------- veri çekme ------------------------------------
async function klines(symbol, interval, limit) {
  const r = await fetch(`${API}/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`${symbol} ${interval} klines: HTTP ${r.status}`);
  const raw = await r.json();
  return {
    opens:  raw.map(k => +k[1]),
    highs:  raw.map(k => +k[2]),
    lows:   raw.map(k => +k[3]),
    closes: raw.map(k => +k[4]),
    times:  raw.map(k => +k[0]),
  };
}

async function ticker24(symbols) {
  const q = encodeURIComponent(JSON.stringify(symbols.map(s => s + 'USDT')));
  const r = await fetch(`${API}/ticker/24hr?symbols=${q}`);
  if (!r.ok) throw new Error(`ticker24: HTTP ${r.status}`);
  const data = await r.json();
  return data
    .map(d => ({ s: d.symbol.replace('USDT', ''), p: +d.lastPrice, c: +d.priceChangePercent }))
    .sort((a, b) => symbols.indexOf(a.s) - symbols.indexOf(b.s));
}

// ---------------------------- analiz ----------------------------------------
export function analyzeCoin(coin, daily, h4) {
  // kapalı mumlarla çalış (son eleman oluşmakta olan mum)
  const dC = daily.closes.slice(0, -1);
  const price = daily.closes.at(-1);
  const e50 = ema(dC, 50);
  const dailyEma = e50.at(-1);
  const dailyEmaPrev = e50.at(-2);
  const rising = dailyEma > dailyEmaPrev;
  const falling = dailyEma < dailyEmaPrev;

  const hC = h4.closes.slice(0, -1);
  const hH = h4.highs.slice(0, -1);
  const hL = h4.lows.slice(0, -1);
  const e21 = ema(hC, 21);
  const r14 = rsi(hC, 14);
  const a14 = atr(hH, hL, hC, 14);

  const last = hC.length - 1, prev = last - 1;
  const rsiWin = r14.slice(-8).filter(v => v !== null);
  const hadPullback = Math.min(...rsiWin) < 42;
  const hadBounce   = Math.max(...rsiWin) > 58;
  const crossUp   = hC[last] > e21[last] && hC[prev] <= e21[prev];
  const crossDown = hC[last] < e21[last] && hC[prev] >= e21[prev];

  const uptrend   = price > dailyEma && rising;
  const downtrend = price < dailyEma && falling;

  const atrNow = a14.at(-1);
  let signal = null, status = 'BEKLEMEDE', dir = null;

  if (uptrend && hadPullback && crossUp) {
    const entry = hC[last], stop = entry - 2 * atrNow;
    signal = { dir: 'LONG', entry, stop, target: entry + 2.5 * (entry - stop) };
    status = 'SİNYAL'; dir = 'LONG';
  } else if (downtrend && hadBounce && crossDown) {
    const entry = hC[last], stop = entry + 2 * atrNow;
    signal = { dir: 'SHORT', entry, stop, target: entry - 2.5 * (stop - entry) };
    status = 'SİNYAL'; dir = 'SHORT';
  } else if (uptrend && hadPullback) { status = 'KURULUM'; dir = 'LONG'; }
  else if (downtrend && hadBounce)   { status = 'KURULUM'; dir = 'SHORT'; }
  else if (uptrend)                  { status = 'LONG ADAYI'; dir = 'LONG'; }
  else if (downtrend)                { status = 'SHORT ADAYI'; dir = 'SHORT'; }

  // kilit seviyeler: son 20 günün tepesi / son 10 günün dibi
  const hi = Math.max(...daily.highs.slice(-21, -1));
  const lo = Math.min(...daily.lows.slice(-11, -1));
  const chg50 = ((price / dC.at(-50) - 1) * 100);

  return {
    coin, price, dailyEma, rising, falling, uptrend, downtrend,
    rsiNow: r14.at(-1), rsiMin8: Math.min(...rsiWin), rsiMax8: Math.max(...rsiWin),
    ema21: e21.at(-1), atrNow, hadPullback, hadBounce,
    status, dir, signal, hi, lo, chg50,
  };
}

// ---------------------------- biçimleme -------------------------------------
const nf = (n, d) => n.toLocaleString('tr-TR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const px = n => n >= 1000 ? nf(n, 0) : n >= 10 ? nf(n, 2) : n >= 1 ? nf(n, 3) : nf(n, 4);

function noteFor(a) {
  if (a.status === 'SİNYAL')  return a.dir === 'LONG' ? 'AKTİF SİNYAL — geri çekilme sonrası EMA21 geri alındı' : 'AKTİF SİNYAL — tepki sonrası EMA21 kaybedildi';
  if (a.status === 'KURULUM') return a.dir === 'LONG' ? `Trend + geri çekilme hazır (RSI dip ${nf(a.rsiMin8,0)}); 4s EMA21 kapanışı bekleniyor` : `Düşüş trendi + tepki hazır (RSI tepe ${nf(a.rsiMax8,0)}); EMA21 altına kapanış bekleniyor`;
  if (a.status === 'LONG ADAYI')  return `Trend yukarı (50 günde ${a.chg50 >= 0 ? '+' : ''}${nf(a.chg50,0)}%); gerçek bir geri çekilme bekleniyor`;
  if (a.status === 'SHORT ADAYI') return `Trend aşağı (50 günde ${nf(a.chg50,0)}%); satılacak bir tepki bekleniyor`;
  return a.rising ? 'Fiyat günlük EMA50 altında ama ortalama yükseliyor — rejim arası' : 'Yön belirsiz — rejim arası sıkışma';
}

function trendComment(btc) {
  const p = px(btc.price), e = px(btc.dailyEma);
  if (btc.status === 'SİNYAL') return `BTC ${p} — ${btc.dir} sinyali oluştu. Detaylar sinyal kartında; stop ve hedef baştan belli.`;
  if (btc.uptrend)   return `BTC ${p} — günlük EMA50'nin (${e}) üzerinde ve ortalama yükseliyor. Long tarafı açık; kaliteli bir geri çekilme bekliyorum.`;
  if (btc.downtrend) return `BTC ${p} — günlük EMA50'nin (${e}) altında ve ortalama düşüyor. Short tarafı açık; satılacak tepki bekliyorum.`;
  return `BTC ${p} — günlük EMA50 (${e}) etrafında rejim arası. İki yönde de kapı kapalı; bir sonraki 4s kapanışını izliyorum.`;
}

const RISK_LINES = [
  'Sinyal yok = pozisyon yok. Beklemek de bir karardır.',
  'Kural dışı işlem, backtest\'te en pahalı hataydı. Disiplin sürüyor.',
  'Risk sabit, kurallar açık. Sinyal gelmeden bu sayfada alım-satım önerisi göremezsiniz.',
  'Sistemin işi sık işlem değil, doğru anda işlem. Şu an doğru an değilse sayfa sessiz kalır.',
];

// ---------------------------- ana akış --------------------------------------
async function main() {
  const old = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const now = new Date().toISOString();

  const analyses = {};
  for (const c of COINS) {
    const [d, h] = await Promise.all([klines(c, '1d', 120), klines(c, '4h', 260)]);
    analyses[c] = analyzeCoin(c, d, h);
  }
  const tick = await ticker24(COINS);

  // --- eski aktif sinyalleri fiyata göre kapat/güncelle (+ bildirim)
  const signals = [];
  for (const s of (old.signals || [])) {
    if (s.state !== 'AKTİF') { signals.push(s); continue; }
    const a = analyses[s.coin];
    if (!a) { signals.push(s); continue; }
    let ns = s;
    if (s.dir === 'LONG'  && a.price >= parseFloat(String(s.target).replace(/\./g,'').replace(',','.'))) ns = { ...s, state: 'HEDEF ✓', closed: now };
    else if (s.dir === 'LONG'  && a.price <= parseFloat(String(s.stop).replace(/\./g,'').replace(',','.')))   ns = { ...s, state: 'STOP ✗', closed: now };
    else if (s.dir === 'SHORT' && a.price <= parseFloat(String(s.target).replace(/\./g,'').replace(',','.'))) ns = { ...s, state: 'HEDEF ✓', closed: now };
    else if (s.dir === 'SHORT' && a.price >= parseFloat(String(s.stop).replace(/\./g,'').replace(',','.')))   ns = { ...s, state: 'STOP ✗', closed: now };
    if (ns !== s) {
      await notify(
        `${ns.state.includes('HEDEF') ? '🎯' : '🛑'} ${s.coin} ${s.dir} kapandı: ${ns.state}`,
        `Giriş ${s.entry} → ${ns.state.includes('HEDEF') ? 'Hedef' : 'Stop'} seviyesi görüldü. Detay: sitede.`,
        ns.state.includes('HEDEF') ? 'dart' : 'octagonal_sign'
      );
    }
    signals.push(ns);
  }

  // --- testnet: açık pozisyonların durumunu kontrol et (hedef/stop dolmuş mu?)
  if (executor.enabled()) {
    try { await executor.reconcile(notify); }
    catch (e) { console.error('testnet takip hatası:', e.message); }
  }

  // --- yeni sinyaller
  const feed = [];
  for (const c of WATCH) {
    const a = analyses[c];
    if (a.signal && !signals.some(s => s.coin === c && s.state === 'AKTİF')) {
      signals.unshift({
        coin: c, dir: a.signal.dir, state: 'AKTİF', ts: now,
        entry: px(a.signal.entry), stop: px(a.signal.stop), target: px(a.signal.target),
      });
      feed.push({
        who: 'Tarayıcı bir sinyal yayınladı', ts: now, kind: 'plus',
        candidate: {
          dir: a.signal.dir, pair: `${c} / USDT`, tf: '4s kapanış teyitli',
          trigger: `Giriş ${px(a.signal.entry)}`, stop: `Stop ${px(a.signal.stop)}`,
          target: `Hedef ${px(a.signal.target)}`,
          evidence: noteFor(a),
        },
        footnote: 'Stop = 2×ATR(14) · Hedef = 2,5R · Yatırım tavsiyesi değildir.',
      });
      await notify(
        `${a.signal.dir === 'LONG' ? '🟢' : '🔴'} YENİ SİNYAL: ${c} ${a.signal.dir}`,
        `Giriş ${px(a.signal.entry)} · Stop ${px(a.signal.stop)} · Hedef ${px(a.signal.target)} (2,5R)`,
        a.signal.dir === 'LONG' ? 'green_circle' : 'red_circle'
      );
      // --- testnet otomatik işlem (yalnızca LONG — spot testnet short desteklemez)
      if (executor.enabled() && a.signal.dir === 'LONG') {
        try {
          await executor.openLong({ coinRaw: c, entryNum: a.signal.entry, stopNum: a.signal.stop, targetNum: a.signal.target }, notify);
        } catch (e) {
          console.error(`testnet emir hatası ${c}:`, e.message);
          await notify(`⚠️ TESTNET emir hatası: ${c}`, e.message.slice(0, 150), 'warning');
        }
      } else if (executor.enabled() && a.signal.dir === 'SHORT') {
        await notify(`ℹ️ ${c} SHORT sinyali`, 'Spot testnet short desteklemiyor — yalnızca bildirim.', 'information_source');
      }
    }
  }

  // --- yorumlar
  feed.push({ who: 'Trend Ajanı', ts: now, kind: 'ok', body: trendComment(analyses.BTC) });
  const setups = WATCH.filter(c => analyses[c].status === 'KURULUM');
  const scanBits = WATCH.filter(c => c !== 'BTC').map(c => {
    const a = analyses[c];
    return `${c}: ${a.status.toLowerCase()} (RSI ${nf(a.rsiNow, 0)})`;
  }).join(' · ');
  feed.push({ who: 'Tarayıcı', ts: now, kind: 'dot', body: `Tarama — ${scanBits}.` });
  feed.push({
    who: 'Risk Bekçisi', ts: now, kind: 'dot',
    body: setups.length
      ? `${setups.join(', ')} kurulum aşamasında — tetik kapanışı gelmeden sinyal yayınlanmaz.`
      : RISK_LINES[Math.floor(Date.parse(now) / 14400000) % RISK_LINES.length],
  });

  // --- izleme listesi
  const watchlist = WATCH.map(c => {
    const a = analyses[c];
    return {
      coin: c, status: a.status, dir: a.dir,
      star: a.status === 'KURULUM' || a.status === 'SİNYAL',
      note: noteFor(a), hi: px(a.hi), lo: px(a.lo),
    };
  });

  // --- float panel
  const best = WATCH.map(c => analyses[c]).find(a => a.status === 'SİNYAL')
            || WATCH.map(c => analyses[c]).find(a => a.status === 'KURULUM');
  const float = best ? {
    headline: best.status === 'SİNYAL' ? `${best.coin} ${best.dir} sinyali aktif.` : `${best.coin} kurulumu izleniyor — tetik bekleniyor.`,
    detail: noteFor(best),
    candidate: best.signal
      ? { dir: best.dir, pair: `${best.coin} / USDT`, entry: px(best.signal.entry), stop: px(best.signal.stop), target: px(best.signal.target) }
      : { dir: best.dir, pair: `${best.coin} / USDT`, entry: 'tetikte belirlenecek', stop: best.dir === 'LONG' ? '−2×ATR' : '+2×ATR', target: '2,5R' },
    trailing: 'Bir sonraki mum kapanışında durumu yeniden değerlendireceğim.',
  } : {
    headline: 'Şu an izlenen bir kurulum yok.',
    detail: 'Tüm coinler rejim arası veya aday aşamasında. Ajan 4 saat sonra tekrar bakacak.',
    candidate: null,
    trailing: 'Sabır da stratejinin parçası.',
  };

  const state = {
    updated: now,
    engine: 'github-actions-v1',
    kpi: old.kpi,
    signals: signals.slice(0, 12),
    watchlist,
    feed: [...feed, ...(old.feed || [])].slice(0, 40),
    ticker: tick.map(t => ({ s: t.s, p: t.p, c: +t.c.toFixed(2) })),
    float,
  };

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`OK ${now} — sinyal: ${signals.filter(s => s.state === 'AKTİF').length} aktif, izleme: ${watchlist.map(w => `${w.coin}:${w.status}`).join(' ')}`);
}

// test modu: `node update.mjs --selftest` → sentetik veriyle kural mantığını doğrula
if (process.argv.includes('--selftest')) {
  const { runSelfTest } = await import('./selftest.mjs');
  runSelfTest({ analyzeCoin });
} else if (process.argv.includes('--test-trade')) {
  // Elle tetiklenen zincir testi: minik bir testnet işlemi açar (sahte para)
  if (!executor.enabled()) { console.error('BINANCE_TESTNET_KEY/SECRET tanımlı değil.'); process.exit(1); }
  const r = await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT');
  const p = parseFloat((await r.json()).price);
  await executor.forceTestTrade(notify, p);
  console.log('Test işlemi gönderildi.');
} else {
  main().catch(e => { console.error('GÜNCELLEME BAŞARISIZ:', e.message); process.exit(1); });
}
