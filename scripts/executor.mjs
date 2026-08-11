// ============================================================================
// Rupeeruchana — Sanal Cüzdan Otomatik İşlem Modülü (Paper Trading)
// Borsa YOK, anahtar YOK, coğrafi engel YOK: motor kendi içinde 50$'lık sanal
// bir cüzdan işletir. Sinyalde sanal pozisyon açar; her turda gerçek piyasa
// verisiyle (data-api.binance.vision) stop/hedefi kontrol eder, kapanışta
// PnL'i hesaplayıp bildirir. Sicil: data/autotrade.json
// Kurallar gerçek planla aynı: işlem başına %2 risk (50$ için 1$), stop/hedef
// sinyalden gelir. LONG ve SHORT ikisi de desteklenir (sanal olduğu için).
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson } from './http.mjs';

const DATA_API = 'https://data-api.binance.vision/api/v3';
const LEDGER_PATH = new URL('../data/autotrade.json', import.meta.url);
const START_BALANCE = 50;      // sanal USDT
export const TIME_STOP_MS = 7 * 86400000; // süre stopu: 7 gün
// --- Boyutlama modu (kullanıcı talimatı, 8 Ağu 2026): her işlem sabit teminat × kaldıraç ---
const MARGIN_USD = 10;         // işlem başına teminat
const LEVERAGE = 10;           // kaldıraç → pozisyon = 10$ × 10x = 100$ nominal
// Not: bu modda işlem başına gerçek risk stop mesafesine göre değişir (~%2,5 stop'ta ~2,5$).

export const enabled = () => true; // sanal cüzdan her zaman aktif

// ---------------------------- kayıt defteri ---------------------------------
function loadLedger() {
  if (existsSync(LEDGER_PATH)) {
    try { return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); } catch {}
  }
  return {
    note: 'SANAL CÜZDAN — gerçek para değildir. Başlangıç: 50 USDT, işlem başına risk %2.',
    balance: START_BALANCE,
    open: [],
    closed: [],
  };
}
function saveLedger(l) { writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n'); }

const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2);

// ---------------------------- işlem açma ------------------------------------
export async function openTrade(sig, notify) {
  const symbol = `${sig.coinRaw}USDT`;
  const ledger = loadLedger();
  if (ledger.open.some(p => p.symbol === symbol)) {
    console.log(`${symbol}: zaten açık sanal pozisyon var, atlandı`);
    return;
  }
  if (ledger.open.length >= 4) {
    console.log('aynı anda en fazla 4 sanal pozisyon — atlandı');
    return;
  }
  if (ledger.balance < MARGIN_USD) {
    await notify('⚠️ Sanal cüzdan: bakiye yetersiz', `Bakiye ${ledger.balance.toFixed(2)}$ — ${MARGIN_USD}$ teminatlı yeni işlem açılamıyor.`, 'warning');
    return;
  }
  const perUnit = Math.abs(sig.entryNum - sig.stopNum);
  if (perUnit <= 0) return;
  const notional = MARGIN_USD * LEVERAGE;                       // 10$ × 10x = 100$ pozisyon
  const qty = notional / sig.entryNum;
  const risk = +(qty * perUnit).toFixed(2);                     // stop'ta gerçekleşecek kayıp
  const leverage = LEVERAGE;

  ledger.open.push({
    symbol, dir: sig.dir || 'LONG', qty: +qty.toPrecision(6),
    entry: sig.entryNum, stop: sig.stopNum, target: sig.targetNum,
    riskUsd: risk, notional, leverage, marginUsd: MARGIN_USD,
    ts: sig.tsISO || new Date().toISOString(),
  });
  saveLedger(ledger);
  await notify(
    `🤖 SANAL işlem açıldı: ${symbol} ${sig.dir || 'LONG'}`,
    `Giriş ${sig.entryNum.toFixed(sig.entryNum < 1 ? 5 : 2)} · Stop ${sig.stopNum.toFixed(sig.stopNum < 1 ? 5 : 2)} · Hedef ${sig.targetNum.toFixed(sig.targetNum < 1 ? 5 : 2)} · Pozisyon ${notional}$ (${MARGIN_USD}$ × ${LEVERAGE}x) · Stop'ta kayıp ~${risk.toFixed(2)}$ · Bakiye ${ledger.balance.toFixed(2)}$`,
    'robot'
  );
  console.log(`SANAL AÇILDI: ${symbol} ${sig.dir} qty=${qty} notional=${notional}$ lev=${leverage}x risk=${risk}$`);
}

// ---------------------------- mum taraması (saf, test edilebilir) ------------
// Girişten bu yana 1 saatlik mumları gezer: stop mu hedef mi önce dokunuldu?
// İki kural:
//   1) Aynı mumda ikisi de dokunduysa tutucu varsayım: STOP önce (aleyhimize say).
//   2) Süre stopu anından (giriş + 7 gün) SONRAKİ mumlar sayılmaz. Motor günlerce
//      durursa (bkz. 10 Ağu 2026 kilitlenmesi) pozisyon süre stopunda kapanmış
//      olmalıdır; gecikmiş dokunuşlar geriye dönük işlenmez.
export function scanBars(bars, { dir, stop, target, startMs, nowMs }) {
  const deadline = startMs + TIME_STOP_MS;
  let lastClose = null;

  for (const k of bars) {
    if (+k[0] > deadline) break;           // süre stopundan sonraki mumlar sayılmaz
    const high = +k[2], low = +k[3];
    lastClose = +k[4];
    if (dir === 'SHORT') {
      if (high >= stop)   return { outcome: 'STOP ✗',  exit: stop };
      if (low  <= target) return { outcome: 'HEDEF ✓', exit: target };
    } else { // LONG
      if (low  <= stop)   return { outcome: 'STOP ✗',  exit: stop };
      if (high >= target) return { outcome: 'HEDEF ✓', exit: target };
    }
  }
  // ZAMAN STOPU: 7 gün içinde ne stop ne hedef — süre dolduğu andaki kapanıştan çık.
  // Gerekçe: çözülmeyen işlem sermayeyi kilitler; sistem "bekleyen umut" taşımaz.
  if (lastClose != null && nowMs > deadline) return { outcome: 'SÜRE ⏱', exit: lastClose };
  return { outcome: null, exit: null };
}

// ---------------------------- pozisyon takibi --------------------------------
export async function reconcile(notify) {
  const ledger = loadLedger();
  if (!ledger.open.length) return;
  const still = [];

  for (const p of ledger.open) {
    try {
      const startMs = Date.parse(p.ts);
      const bars = await fetchJson(
        `${DATA_API}/klines?symbol=${p.symbol}&interval=1h&startTime=${startMs}&limit=1000`,
        `${p.symbol} takip klines`
      );

      const { outcome, exit: exitPx } = scanBars(bars, {
        dir: p.dir, stop: p.stop, target: p.target, startMs, nowMs: Date.now(),
      });
      if (!outcome) { still.push(p); continue; }

      const sign = p.dir === 'LONG' ? 1 : -1;
      const pnl = sign * (exitPx - p.entry) * p.qty;
      ledger.balance = +(ledger.balance + pnl).toFixed(2);
      ledger.closed.unshift({ ...p, outcome, exit: exitPx, pnl: +pnl.toFixed(2), closedTs: new Date().toISOString() });

      await notify(
        `${outcome.includes('HEDEF') ? '🎯' : '🛑'} SANAL kapandı: ${p.symbol} ${p.dir} ${outcome}`,
        `PnL ${fmt(pnl)}$ · Yeni sanal bakiye: ${ledger.balance.toFixed(2)}$ · Sicil: ${ledger.closed.filter(c => c.outcome.includes('HEDEF')).length}✓/${ledger.closed.length}`,
        outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign'
      );
    } catch (e) {
      console.error(`sanal takip hatası ${p.symbol}:`, e.message);
      still.push(p);
    }
  }
  ledger.closed = ledger.closed.slice(0, 200);
  ledger.open = still;
  saveLedger(ledger);
}

// ---------------------------- sinyal aynası ----------------------------------
// Cüzdan, resmî AKTİF sinyallerin tamamını yansıtır: herhangi bir sebeple
// (modül sonradan kuruldu, tur atlandı vs.) cüzdanda karşılığı olmayan aktif
// sinyal varsa pozisyonu açar. openTrade zaten sembol bazında tekrarı engeller.
export async function adoptSignals(signals, notify) {
  const ledger = loadLedger();
  for (const s of signals || []) {
    if (s.state !== 'AKTİF' || s.entryN == null) continue;
    // koruma: bu sinyalin pozisyonu daha önce kapandıysa yeniden AÇMA
    const closedAlready = (ledger.closed || []).some(c =>
      c.symbol === `${s.coin}USDT` && Date.parse(c.closedTs) > Date.parse(s.ts));
    if (closedAlready) continue;
    try {
      await openTrade({ coinRaw: s.coin, dir: s.dir, entryNum: s.entryN, stopNum: s.stopN, targetNum: s.targetN, tsISO: s.ts }, notify);
    } catch (e) { console.error(`ayna hatası ${s.coin}:`, e.message); }
  }
}

// ---------------------------- zincir testi -----------------------------------
// Dar bantlı minik test pozisyonu: birkaç saat içinde doğal olarak kapanır ve
// açılış + kapanış bildirimlerinin ikisini de doğrular.
export async function forceTestTrade(notify) {
  const t = await fetchJson(`${DATA_API}/ticker/price?symbol=BTCUSDT`, 'test işlemi fiyatı');
  const price = parseFloat(t.price);
  await openTrade({
    coinRaw: 'BTC', dir: 'LONG',
    entryNum: price, stopNum: price * 0.995, targetNum: price * 1.005,
  }, notify);
}

// eski API adlarıyla uyumluluk
export const openLong = (sig, notify) => openTrade({ ...sig, dir: 'LONG' }, notify);
