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

const DATA_API = 'https://data-api.binance.vision/api/v3';
const LEDGER_PATH = new URL('../data/autotrade.json', import.meta.url);
const START_BALANCE = 50;      // sanal USDT — gerçek test planıyla aynı
const RISK_PCT = 2;            // işlem başına bakiye yüzdesi (50$ → 1$)

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
  const risk = Math.max(0.5, ledger.balance * RISK_PCT / 100);
  const perUnit = Math.abs(sig.entryNum - sig.stopNum);
  if (perUnit <= 0) return;
  const qty = risk / perUnit;
  const notional = +(qty * sig.entryNum).toFixed(2);           // pozisyona giren tutar ($)
  const leverage = +(notional / ledger.balance).toFixed(2);    // bakiyeye oranla kaç x

  ledger.open.push({
    symbol, dir: sig.dir || 'LONG', qty: +qty.toPrecision(6),
    entry: sig.entryNum, stop: sig.stopNum, target: sig.targetNum,
    riskUsd: +risk.toFixed(2), notional, leverage,
    ts: sig.tsISO || new Date().toISOString(),
  });
  saveLedger(ledger);
  await notify(
    `🤖 SANAL işlem açıldı: ${symbol} ${sig.dir || 'LONG'}`,
    `Giriş ${sig.entryNum.toFixed(sig.entryNum < 1 ? 5 : 2)} · Stop ${sig.stopNum.toFixed(sig.stopNum < 1 ? 5 : 2)} · Hedef ${sig.targetNum.toFixed(sig.targetNum < 1 ? 5 : 2)} · Pozisyon ${notional}$ (${leverage}x) · Risk ${risk.toFixed(2)}$ · Bakiye ${ledger.balance.toFixed(2)}$`,
    'robot'
  );
  console.log(`SANAL AÇILDI: ${symbol} ${sig.dir} qty=${qty} notional=${notional}$ lev=${leverage}x`);
}

// ---------------------------- pozisyon takibi --------------------------------
// Girişten bu yana 1 saatlik mumları gezer: stop mu hedef mi önce dokunuldu?
// Aynı mumda ikisi de dokunduysa tutucu varsayım: STOP önce (aleyhimize say).
export async function reconcile(notify) {
  const ledger = loadLedger();
  if (!ledger.open.length) return;
  const still = [];

  for (const p of ledger.open) {
    try {
      const startMs = Date.parse(p.ts);
      const r = await fetch(`${DATA_API}/klines?symbol=${p.symbol}&interval=1h&startTime=${startMs}&limit=1000`);
      if (!r.ok) throw new Error(`klines HTTP ${r.status}`);
      const bars = await r.json();

      let outcome = null, exitPx = null;
      for (const k of bars) {
        const high = +k[2], low = +k[3];
        if (p.dir === 'LONG') {
          if (low <= p.stop)        { outcome = 'STOP ✗';  exitPx = p.stop;   break; }
          if (high >= p.target)     { outcome = 'HEDEF ✓'; exitPx = p.target; break; }
        } else { // SHORT
          if (high >= p.stop)       { outcome = 'STOP ✗';  exitPx = p.stop;   break; }
          if (low <= p.target)      { outcome = 'HEDEF ✓'; exitPx = p.target; break; }
        }
      }
      // ZAMAN STOPU: 7 gün içinde ne stop ne hedef — pozisyon son fiyattan kapatılır.
      // Gerekçe: çözülmeyen işlem sermayeyi kilitler; sistem "bekleyen umut" taşımaz.
      if (!outcome && bars.length && (Date.now() - startMs) > 7 * 86400000) {
        outcome = 'SÜRE ⏱';
        exitPx = +bars[bars.length - 1][4];
      }
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
  const r = await fetch(`${DATA_API}/ticker/price?symbol=BTCUSDT`);
  const price = parseFloat((await r.json()).price);
  await openTrade({
    coinRaw: 'BTC', dir: 'LONG',
    entryNum: price, stopNum: price * 0.995, targetNum: price * 1.005,
  }, notify);
}

// eski API adlarıyla uyumluluk
export const openLong = (sig, notify) => openTrade({ ...sig, dir: 'LONG' }, notify);
