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
const START_BALANCE = 1000;    // sanal USDT (12 Ağu 2026: 50$ → 1000$)
// Neden 1000$: sistemin başarısı ölçekten bağımsızdır (risk sabit yüzde), ama
// 50$'lık bakiyede işlem başına ~1$ risk gerçek borsanın minimum emir
// büyüklüğünün altında kalıyor ve komisyon/fonlama modellemesi anlamsızlaşıyor.
// 1000$ ile pozisyon boyutları gerçekçi ve sonuçlar doğrudan ölçeklenebilir.
export const TIME_STOP_MS = 7 * 86400000; // süre stopu: 7 gün
// --- Boyutlama: SABİT RİSK (12 Ağu 2026'da sabit teminat modundan geri dönüldü) ---
// Sabit teminat × kaldıraç modunda (10$ × 10x = 100$ nominal) işlem başına gerçek
// risk stop mesafesiyle birlikte değişiyordu: dar stopta ~2$, geniş stopta ~5$.
// 48$'lık bir bakiyede bu işlem başına %4-10 risk demek ve 4 pozisyon açıkken
// hesabın beşte biriyle yarısı arası tehlikede olur. İnce bir avantajı olan bir
// sistemde değişken risk, beklentiyi ölçülemez hale getirir.
// Yeni kural: risk birimi sabittir, pozisyon büyüklüğü stop mesafesinden türetilir.
// Kaldıraç yalnızca teminat mekaniğidir, risk birimi değildir.
export const RISK_PCT = 0.02;     // işlem başına bakiyenin %2'si
export const MAX_LEVERAGE = 10;   // teminat hesabı için
export const MAX_POSITIONS = 4;   // aynı anda açık pozisyon sınırı

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

// ---------------------------- boyutlama (saf, test edilebilir) ---------------
// Risk sabit, adet stop mesafesinden türetilir:  adet = risk$ / |giriş − stop|
// Tek fren: teminat kontenjanı. 4 pozisyonluk sistemde tek bir işlem, bakiyenin
// dörtte birinden fazla teminat tutamaz; gerekirse pozisyon (ve dolayısıyla
// risk) orantılı küçültülür. Bu yalnızca stop çok darken devreye girer.
export function sizeTrade({ balance, entry, stop, riskPct = RISK_PCT,
                            leverage = MAX_LEVERAGE, maxPositions = MAX_POSITIONS }) {
  const perUnit = Math.abs(entry - stop);
  if (!(perUnit > 0) || !(entry > 0) || !(balance > 0)) return null;

  const targetRisk = balance * riskPct;
  let qty = targetRisk / perUnit;
  let notional = qty * entry;

  const maxNotional = (balance / maxPositions) * leverage; // teminat kontenjanı
  let capped = false;
  if (notional > maxNotional) {
    qty = maxNotional / entry;
    notional = maxNotional;
    capped = true;
  }
  return {
    qty: +qty.toPrecision(6),
    notional: +notional.toFixed(2),
    marginUsd: +(notional / leverage).toFixed(2),
    riskUsd: +(qty * perUnit).toFixed(2),
    stopPct: +((perUnit / entry) * 100).toFixed(2), // sonraki analizler için
    leverage,
    capped,
  };
}

// ---------------------------- işlem açma ------------------------------------
export async function openTrade(sig, notify) {
  const symbol = `${sig.coinRaw}USDT`;
  const ledger = loadLedger();
  if (ledger.open.some(p => p.symbol === symbol)) {
    console.log(`${symbol}: zaten açık sanal pozisyon var, atlandı`);
    return;
  }
  if (ledger.open.length >= MAX_POSITIONS) {
    console.log(`aynı anda en fazla ${MAX_POSITIONS} sanal pozisyon — atlandı`);
    return;
  }
  const size = sizeTrade({ balance: ledger.balance, entry: sig.entryNum, stop: sig.stopNum });
  if (!size) return;
  if (size.riskUsd < 0.01) {
    await notify('⚠️ Sanal cüzdan: bakiye yetersiz', `Bakiye ${ledger.balance.toFixed(2)}$ — anlamlı büyüklükte pozisyon açılamıyor.`, 'warning');
    return;
  }

  ledger.open.push({
    symbol, dir: sig.dir || 'LONG', qty: size.qty,
    entry: sig.entryNum, stop: sig.stopNum, target: sig.targetNum,
    riskUsd: size.riskUsd, notional: size.notional, leverage: size.leverage,
    marginUsd: size.marginUsd, stopPct: size.stopPct,
    ts: sig.tsISO || new Date().toISOString(),
  });
  saveLedger(ledger);
  const px2 = n => n.toFixed(n < 1 ? 5 : 2);
  await notify(
    `🤖 SANAL işlem açıldı: ${symbol} ${sig.dir || 'LONG'}`,
    `Giriş ${px2(sig.entryNum)} · Stop ${px2(sig.stopNum)} (%${size.stopPct}) · Hedef ${px2(sig.targetNum)} · Pozisyon ${size.notional}$ (teminat ${size.marginUsd}$ × ${size.leverage}x) · Riske edilen ${size.riskUsd}$ (bakiyenin %${(RISK_PCT * 100).toFixed(0)}'si) · Bakiye ${ledger.balance.toFixed(2)}$`,
    'robot'
  );
  console.log(`SANAL AÇILDI: ${symbol} ${sig.dir} qty=${size.qty} notional=${size.notional}$ teminat=${size.marginUsd}$ risk=${size.riskUsd}$ stop=%${size.stopPct}${size.capped ? ' (teminat kontenjanina takildi)' : ''}`);
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
