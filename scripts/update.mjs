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
import { fetchJson } from './http.mjs';
import { notify, channel } from './notify.mjs';

// --- Tarama evreni ---
// COINS: sinyal üretebilen ve sanal cüzdana işlem açabilen çekirdek evren.
// ALTS : yalnızca RADAR — durumu hesaplanır ve sitede gösterilir, ama sinyal
//        listesine girmez, bildirim yollamaz ve sanal cüzdanda pozisyon açmaz.
//        Gerekçe: 4 pozisyonluk kontenjan düşük likiditeli alt sinyalleriyle
//        dolarsa çekirdek coinlerin sinyalleri kaçar ve sicil kıyaslanamaz olur.
const COINS = ['BTC', 'ETH', 'SOL', 'LINK', 'DOGE'];
const WATCH = ['ETH', 'LINK', 'SOL', 'DOGE', 'BTC']; // izleme listesi sırası
const ALTS = [
  'XRP', 'AVAX', 'ADA', 'POL', 'DOT', 'ATOM', 'NEAR', 'APT', 'ARB', 'OP',
  'INJ', 'SUI', 'TIA', 'SEI', 'LTC', 'BCH', 'UNI', 'AAVE', 'FIL', 'RENDER',
]; // POL (eski MATIC) ve RENDER (eski RNDR) güncel Binance sembolleridir
const ALL = [...COINS, ...ALTS];
const BATCH = 4; // aynı anda kaç coin çekilsin (tarama evreni büyüyünce tur süresi patlamasın)
const STATE_PATH = new URL('../data/state.json', import.meta.url);
const API = 'https://data-api.binance.vision/api/v3'; // küresel halka açık veri ucu (GitHub runner'larından erişilebilir)

// Bildirim katmanı scripts/notify.mjs içinde: Telegram varsa oraya, yoksa ntfy'a.
// Yerel deneme turlarında sustur: RUPEE_NO_NOTIFY=1 node scripts/update.mjs
// Radar sinyalleri için bildirim varsayılan olarak KAPALI (çekirdek sinyallerle
// karışmasın diye). Açmak için workflow'a RUPEE_RADAR_NOTIFY=1 eklemek yeterli.
const RADAR_NOTIFY = process.env.RUPEE_RADAR_NOTIFY === '1';

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
  const raw = await fetchJson(
    `${API}/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`,
    `${symbol} ${interval} klines`
  );
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
  const data = await fetchJson(`${API}/ticker/24hr?symbols=${q}`, 'ticker24');
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
  // BATCH'li paralel çekim: 25 coinlik evrende tur süresi job zaman aşımının
  // çok altında kalsın diye. Tek bir coinin verisi gelmezse tur çökmesin:
  // o coin radardan düşer, analiz devam eder.
  const failed = [];
  for (let i = 0; i < ALL.length; i += BATCH) {
    const chunk = ALL.slice(i, i + BATCH);
    const done = await Promise.all(chunk.map(async c => {
      try {
        const [d, h] = await Promise.all([klines(c, '1d', 120), klines(c, '4h', 260)]);
        return [c, analyzeCoin(c, d, h)];
      } catch (e) {
        console.error(`${c} verisi alınamadı:`, e.message);
        return [c, null];
      }
    }));
    for (const [c, a] of done) {
      if (a) analyses[c] = a; else failed.push(c);
    }
  }
  // Çekirdek evrende veri eksikse tur güvenilir değildir — sessizce yanlış
  // yayınlamaktansa başarısız ol (bir önceki state.json yerinde kalır).
  const coreMissing = COINS.filter(c => !analyses[c]);
  if (coreMissing.length) throw new Error(`çekirdek coin verisi eksik: ${coreMissing.join(', ')}`);
  if (failed.length) console.warn(`radar dışı kalan coinler: ${failed.join(', ')}`);

  const tick = await ticker24(ALL.filter(c => analyses[c]));

  // --- eski aktif sinyalleri MUM TARAMASIYLA kapat/güncelle (+ bildirim)
  // Anlık fiyat kontrolü yeterli değildir: turlar arasında stop/hedefe dokunulup
  // geri dönülebilir. Sinyal açılışından bu yana 1 saatlik mumların tepe/dipleri
  // taranır (kurallar için bkz. executor.scanBars — cüzdanla birebir aynı mantık).
  async function barScanOutcome(s, stp, tgt) {
    const startMs = Date.parse(s.ts);
    const bars = await fetchJson(
      `${API}/klines?symbol=${s.coin}USDT&interval=1h&startTime=${startMs}&limit=1000`,
      `${s.coin} sinyal tarama klines`
    );
    return executor.scanBars(bars, {
      dir: s.dir, stop: stp, target: tgt, startMs, nowMs: Date.parse(now),
    }).outcome;
  }

  const signals = [];
  for (const s of (old.signals || [])) {
    if (s.state !== 'AKTİF') { signals.push(s); continue; }
    const a = analyses[s.coin];
    if (!a) { signals.push(s); continue; }
    let ns = s;
    const tgt = s.targetN != null ? s.targetN : parseFloat(String(s.target).replace(/\./g,'').replace(',','.'));
    const stp = s.stopN   != null ? s.stopN   : parseFloat(String(s.stop).replace(/\./g,'').replace(',','.'));
    let outcome = null;
    try { outcome = await barScanOutcome(s, stp, tgt); }
    catch (e) {
      console.error(`sinyal taraması başarısız (${s.coin}):`, e.message);
      // yedek: anlık fiyat kontrolü
      if (s.dir === 'LONG'  && a.price >= tgt) outcome = 'HEDEF ✓';
      else if (s.dir === 'LONG'  && a.price <= stp) outcome = 'STOP ✗';
      else if (s.dir === 'SHORT' && a.price <= tgt) outcome = 'HEDEF ✓';
      else if (s.dir === 'SHORT' && a.price >= stp) outcome = 'STOP ✗';
    }
    if (outcome) ns = { ...s, state: outcome, closed: now };
    else if (Date.parse(now) - Date.parse(s.ts) > 7 * 86400000) ns = { ...s, state: 'SÜRE ⏱', closed: now }; // 7 günde çözülmeyen sinyal kapatılır
    if (ns !== s) {
      await notify(
        `${ns.state.includes('HEDEF') ? '🎯' : '🛑'} ${s.coin} ${s.dir} kapandı: ${ns.state}`,
        `Giriş ${s.entry} → ${ns.state.includes('HEDEF') ? 'Hedef' : 'Stop'} seviyesi görüldü. Detay: sitede.`,
        ns.state.includes('HEDEF') ? 'dart' : 'octagonal_sign'
      );
    }
    signals.push(ns);
  }

  // --- sanal cüzdan: açık pozisyonların durumunu kontrol et (hedef/stop dokundu mu?)
  try { await executor.reconcile(notify); }
  catch (e) { console.error('sanal takip hatası:', e.message); }
  // --- sinyal aynası: cüzdanda karşılığı olmayan aktif sinyalleri aç
  try { await executor.adoptSignals(signals, notify); }
  catch (e) { console.error('sinyal aynası hatası:', e.message); }

  // --- yeni sinyaller
  const feed = [];
  for (const c of WATCH) {
    const a = analyses[c];
    if (a.signal && !signals.some(s => s.coin === c && s.state === 'AKTİF')) {
      signals.unshift({
        coin: c, dir: a.signal.dir, state: 'AKTİF', ts: now,
        entry: px(a.signal.entry), stop: px(a.signal.stop), target: px(a.signal.target),
        entryN: a.signal.entry, stopN: a.signal.stop, targetN: a.signal.target,
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
      // --- sanal cüzdan otomatik işlem (LONG + SHORT)
      try {
        await executor.openTrade({ coinRaw: c, dir: a.signal.dir, entryNum: a.signal.entry, stopNum: a.signal.stop, targetNum: a.signal.target }, notify);
      } catch (e) {
        console.error(`sanal işlem hatası ${c}:`, e.message);
        await notify(`⚠️ Sanal işlem hatası: ${c}`, e.message.slice(0, 150), 'warning');
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

  // --- altcoin radarı (yalnızca izleme; sinyal/cüzdan akışına girmez)
  const tickMap = Object.fromEntries(tick.map(t => [t.s, t]));
  const STATUS_RANK = { 'SİNYAL': 0, 'KURULUM': 1, 'LONG ADAYI': 2, 'SHORT ADAYI': 2, 'BEKLEMEDE': 3 };
  const alts = ALTS.filter(c => analyses[c]).map(c => {
    const a = analyses[c];
    return {
      coin: c, price: px(a.price), chg: tickMap[c] ? +tickMap[c].c.toFixed(2) : null,
      status: a.status, dir: a.dir, rsi: Math.round(a.rsiNow),
      star: a.status === 'KURULUM' || a.status === 'SİNYAL',
      note: noteFor(a),
    };
  }).sort((x, y) =>
    (STATUS_RANK[x.status] ?? 9) - (STATUS_RANK[y.status] ?? 9) ||
    x.coin.localeCompare(y.coin, 'tr')
  );

  // --- radar sinyal sicili
  // "SİNYAL" durumu yalnızca kesişimin olduğu mumda görünür, bir sonraki turda
  // kaybolur. Radar sinyalini de çekirdek sinyaller gibi kalıcı tutuyoruz:
  // açılır, sonraki turlarda mum taramasıyla stop/hedef kontrol edilir, kapanır.
  // Fark: bildirim yollamaz ve sanal cüzdanda pozisyon AÇMAZ — sadece sicil.
  const altSignals = [];
  for (const s of (old.altSignals || [])) {
    if (s.state !== 'AKTİF') { altSignals.push(s); continue; }
    let r = null;
    try {
      const startMs = Date.parse(s.ts);
      const bars = await fetchJson(
        `${API}/klines?symbol=${s.coin}USDT&interval=1h&startTime=${startMs}&limit=1000`,
        `${s.coin} radar tarama klines`
      );
      r = executor.scanBars(bars, {
        dir: s.dir, stop: s.stopN, target: s.targetN, entry: s.entryN,
        startMs, nowMs: Date.parse(now),
      });
    } catch (e) { console.error(`radar taraması başarısız (${s.coin}):`, e.message); }
    // MFE/MAE hem açık hem kapalı kayda yazılır: radar 20 coinle çalıştığı için
    // teşhis verisi buradan çekirdek cüzdandan çok daha hızlı birikir.
    altSignals.push(r?.outcome
      ? { ...s, state: r.outcome, closed: now, mfeR: r.mfeR, maeR: r.maeR, bars: r.bars }
      : (r ? { ...s, mfeR: r.mfeR, maeR: r.maeR, bars: r.bars } : s));

    if (r?.outcome && RADAR_NOTIFY) {
      const kapali = altSignals.filter(x => x.state !== 'AKTİF');
      const isabet = kapali.filter(x => (x.state || '').includes('HEDEF')).length;
      await notify(
        `📡 RADAR kapandı: ${s.coin} ${s.dir} ${r.outcome}`,
        `Giriş ${s.entry} → ${r.outcome.includes('HEDEF') ? 'hedef' : r.outcome.includes('STOP') ? 'stop' : 'süre'} · Lehe en fazla ${r.mfeR}R, aleyhe ${r.maeR}R · Radar sicili: ${isabet}✓/${kapali.length}\n\nİzleme amaçlıdır, işlem açılmadı.`,
        r.outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign'
      );
    }
  }
  for (const c of ALTS) {
    const a = analyses[c];
    if (a?.signal && !altSignals.some(s => s.coin === c && s.state === 'AKTİF')) {
      altSignals.unshift({
        coin: c, dir: a.signal.dir, state: 'AKTİF', ts: now,
        entry: px(a.signal.entry), stop: px(a.signal.stop), target: px(a.signal.target),
        entryN: a.signal.entry, stopN: a.signal.stop, targetN: a.signal.target,
      });
      console.log(`radar sinyali acildi (islem yok): ${c} ${a.signal.dir}`);
      if (RADAR_NOTIFY) {
        await notify(
          `📡 RADAR: ${c} ${a.signal.dir}`,
          `Giriş ${px(a.signal.entry)} · Stop ${px(a.signal.stop)} · Hedef ${px(a.signal.target)} (2,5R) — izleme amaçlıdır, işlem açılmaz.`,
          a.signal.dir === 'LONG' ? 'green_circle' : 'red_circle'
        );
      }
    }
  }

  const altHot = alts.filter(a => a.star);
  feed.push({
    who: 'Altcoin Radarı', ts: now, kind: 'dot',
    body: altHot.length
      ? `${alts.length} altcoin tarandı — öne çıkanlar: ${altHot.map(a => `${a.coin} (${a.status.toLowerCase()})`).join(', ')}. Radar izleme amaçlıdır; sanal cüzdana işlem açmaz.`
      : `${alts.length} altcoin tarandı — kurulum aşamasında olan yok. Radar izleme amaçlıdır; sanal cüzdana işlem açmaz.`,
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
    alts,
    altSignals: altSignals.slice(0, 40),
    // radar sicilinin teşhis özeti: hedefe ulaşamayanlar ortalama kaç R'ye gitti?
    altStats: executor.summarize(
      altSignals.filter(s => s.state !== 'AKTİF').map(s => ({ outcome: s.state, mfeR: s.mfeR, maeR: s.maeR, bars: s.bars }))
    ),
    feed: [...feed, ...(old.feed || [])].slice(0, 40),
    ticker: tick.map(t => ({ s: t.s, p: t.p, c: +t.c.toFixed(2) })),
    float,
  };

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`bildirim kanalı: ${channel()}${RADAR_NOTIFY ? ' (radar bildirimleri açık)' : ''}`);
  console.log(`OK ${now} — sinyal: ${signals.filter(s => s.state === 'AKTİF').length} aktif, izleme: ${watchlist.map(w => `${w.coin}:${w.status}`).join(' ')}`);
  console.log(`radar: ${alts.length} altcoin${altHot.length ? ` — öne çıkan: ${altHot.map(a => `${a.coin}:${a.status}`).join(' ')}` : ''}`);
  console.log(`radar sinyalleri: ${altSignals.filter(s => s.state === 'AKTİF').length} aktif / ${altSignals.length} kayıt`);
}

// test modu: `node update.mjs --selftest` → sentetik veriyle kural mantığını doğrula
if (process.argv.includes('--selftest')) {
  const { runSelfTest } = await import('./selftest.mjs');
  runSelfTest({ analyzeCoin });
} else if (process.argv.includes('--test-trade')) {
  // Elle tetiklenen zincir testi: dar bantlı minik sanal işlem açar
  await executor.forceTestTrade(notify);
  console.log('Sanal test işlemi açıldı.');
} else if (process.argv.includes('--test-notify')) {
  // Bildirim kanalı testi: kurulumu doğrulamak için tek mesaj yollar
  console.log(`bildirim kanalı: ${channel()}`);
  // Saatler sistemin her yerinde UTC (Binance mumları da öyle kapanır), ama
  // bildirimi okuyan insan Tayland'da: ikisini birden yaz.
  const d = new Date();
  const yerel = d.toLocaleString('tr-TR', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  const utc = d.toISOString().slice(11, 16);
  await notify(
    '✅ Rupeeruchana bildirim testi',
    `Kanal: ${channel()}\n${yerel} (Tayland) · ${utc} UTC\nBu mesajı gördüysen kurulum tamam.`,
    'white_check_mark'
  );
  console.log('test bildirimi gönderildi.');
} else if (process.argv.includes('--test-signal')) {
  // Örnek sinyal bildirimi: gerçek bir sinyalin telefonda nasıl göründüğünü gösterir.
  // SİCİLE DOKUNMAZ. Sanal cüzdana sahte işlem yazmak istatistiği bozar; eski
  // sicildeki tek "HEDEF" kaydının aslında bir zincir testi olması tam da buydu.
  // Rakamlar gerçek boyutlama fonksiyonundan geçirilir ki gördüğün sayılar
  // sistemin gerçekten kullanacağı sayılar olsun.
  const entry = 63240, stop = 61890;
  const target = entry + 2.5 * (entry - stop);
  const sz = executor.sizeTrade({ balance: 1000, entry, stop });
  const gross = 2.5 * sz.riskUsd;
  // örnekte de gerçek maliyet hesabı kullanılır (2 günlük tutuş varsayımı)
  const t0 = Date.now() - 2 * 86400000;
  const kost = executor.tradeCosts({ notional: sz.notional, openMs: t0, closeMs: Date.now() });
  const pnl = gross - kost.costUsd;

  await notify(
    '🟢 YENİ SİNYAL: BTC LONG — DENEME',
    `Giriş ${px(entry)} · Stop ${px(stop)} · Hedef ${px(target)} (2,5R)\nGeri çekilme sonrası EMA21 geri alındı.\n\n⚠️ Bu bir örnektir, gerçek sinyal değildir.`,
    'green_circle'
  );
  await notify(
    '🤖 SANAL işlem açıldı: BTCUSDT LONG — DENEME',
    `Giriş ${px(entry)} · Stop ${px(stop)} (%${sz.stopPct}) · Hedef ${px(target)} · Pozisyon ${sz.notional}$ (teminat ${sz.marginUsd}$ × ${sz.leverage}x) · Riske edilen ${sz.riskUsd}$ (bakiyenin %2'si) · Bakiye 1000,00$\n\n⚠️ Örnektir, sicile yazılmadı.`,
    'robot'
  );
  await notify(
    '🎯 SANAL kapandı: BTCUSDT LONG HEDEF ✓ — DENEME',
    `PnL +${pnl.toFixed(2)}$ (brüt +${gross.toFixed(2)}$ − maliyet ${kost.costUsd}$: komisyon ${kost.feeUsd}$ + fonlama ${kost.fundingUsd}$) · Lehe en fazla 2.61R, aleyhe 0.42R · Yeni sanal bakiye: ${(1000 + pnl).toFixed(2)}$ · Sicil: 1✓/1\n\n⚠️ Örnektir, sicile yazılmadı.`,
    'dart'
  );
  console.log(`örnek sinyal bildirimleri gönderildi (kanal: ${channel()}) — sicile dokunulmadı.`);
} else {
  main().catch(e => { console.error('GÜNCELLEME BAŞARISIZ:', e.message); process.exit(1); });
}
