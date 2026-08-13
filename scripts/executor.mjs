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

// --- İşlem maliyetleri (13 Ağu 2026'da eklendi) ---
// Simülasyon o güne kadar hiçbir maliyet saymıyordu, yani sonuçlar gerçekte
// olduğundan iyi görünüyordu. Profit factor 1,17 gibi ince bir avantajda
// komisyon ve fonlama sonucu belirleyebilir.
// FEE: Binance USDⓈ-M vadeli taker komisyonu, tek yön. Giriş de çıkış da piyasa
//      emri sayılır (stop/hedef dokunuşuyla kapanıyoruz), yani gidiş dönüş 2×.
// FUNDING: perpetual fonlama 8 saatte bir (00:00, 08:00, 16:00 UTC) işler.
//      Gerçek oran değişkendir ve bazen lehimize olur, ama vadeli fonlama
//      verisi (fapi) GitHub sunucularından coğrafi engelli. Bu yüzden tutucu
//      varsayım: her periyotta tipik oran kadar ALEYHE ödeme yapılır.
export const FEE_RATE = 0.0005;    // %0,05 tek yön
export const FUNDING_8H = 0.0001;  // %0,01 / 8 saat, hep aleyhe sayılır
const FUNDING_PERIOD_MS = 8 * 3600000;

// Girişten çıkışa kaç fonlama anı geçildi (00:00/08:00/16:00 UTC sınırları)
export function fundingPeriods(openMs, closeMs) {
  if (!(closeMs > openMs)) return 0;
  return Math.floor(closeMs / FUNDING_PERIOD_MS) - Math.floor(openMs / FUNDING_PERIOD_MS);
}

export function tradeCosts({ notional, openMs, closeMs, feeRate = FEE_RATE, funding8h = FUNDING_8H }) {
  const fee = notional * feeRate * 2;
  const periods = fundingPeriods(openMs, closeMs);
  const funding = notional * funding8h * periods;
  return {
    feeUsd: +fee.toFixed(2),
    fundingUsd: +funding.toFixed(2),
    fundingPeriods: periods,
    costUsd: +(fee + funding).toFixed(2),
  };
}

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
// Ayrıca MFE/MAE ölçer (entry verilirse): işlem kapanana kadar lehe ve aleyhe
// en fazla kaç R gidildi. Bu iki sayı, "hedefe niye ulaşılamıyor" sorusunun
// tek veriye dayalı cevabıdır: hedef mi uzak, stop mu dar, yoksa giriş mi kötü.
export function scanBars(bars, { dir, stop, target, entry, startMs, nowMs }) {
  const deadline = startMs + TIME_STOP_MS;
  const R = (entry != null && stop != null) ? Math.abs(entry - stop) : null;
  let lastClose = null, n = 0, mfe = 0, mae = 0;

  const track = (high, low) => {
    if (!R) return;
    const fav = dir === 'SHORT' ? entry - low  : high - entry;
    const adv = dir === 'SHORT' ? high - entry : entry - low;
    if (fav / R > mfe) mfe = fav / R;
    if (adv / R > mae) mae = adv / R;
  };
  let lastMs = null;
  const done = (outcome, exit) => ({
    outcome, exit,
    exitMs: lastMs,                     // çıkışın gerçekleştiği mumun zamanı
    mfeR: R ? +mfe.toFixed(2) : null,   // lehe en fazla kaç R
    maeR: R ? +mae.toFixed(2) : null,   // aleyhe en fazla kaç R
    bars: n,                            // kaç saatlik mum tutuldu
  });

  for (const k of bars) {
    if (+k[0] > deadline) break;           // süre stopundan sonraki mumlar sayılmaz
    const high = +k[2], low = +k[3];
    lastClose = +k[4]; lastMs = +k[0]; n++;
    track(high, low);                      // çıkış mumu da ölçüme dahildir
    if (dir === 'SHORT') {
      if (high >= stop)   return done('STOP ✗',  stop);
      if (low  <= target) return done('HEDEF ✓', target);
    } else { // LONG
      if (low  <= stop)   return done('STOP ✗',  stop);
      if (high >= target) return done('HEDEF ✓', target);
    }
  }
  // ZAMAN STOPU: 7 gün içinde ne stop ne hedef — süre dolduğu andaki kapanıştan çık.
  // Gerekçe: çözülmeyen işlem sermayeyi kilitler; sistem "bekleyen umut" taşımaz.
  if (lastClose != null && nowMs > deadline) return done('SÜRE ⏱', lastClose);
  return done(null, null);
}

// ---------------------------- sicil özeti (saf) ------------------------------
// Asıl teşhis satırı: hedefe ULAŞMAYAN işlemler ortalama kaç R'ye kadar gitti?
// Bu sayı hedefe (2,5R) yakınsa sorun sabırda/zaman stopunda, çok uzaksa ya
// hedef fazla iddialı ya da giriş kötü.
export function summarize(closed = []) {
  const withR = closed.filter(c => c.mfeR != null);
  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const hedef = closed.filter(c => (c.outcome || '').includes('HEDEF'));
  const stop  = closed.filter(c => (c.outcome || '').includes('STOP'));
  const sure  = closed.filter(c => (c.outcome || '').includes('SÜRE'));
  const miss  = withR.filter(c => !(c.outcome || '').includes('HEDEF'));

  return {
    trades: closed.length,
    hedef: hedef.length, stop: stop.length, sure: sure.length,
    winRate: closed.length ? +((hedef.length / closed.length) * 100).toFixed(1) : null,
    pnlSum: closed.length ? +closed.reduce((a, c) => a + (c.pnl || 0), 0).toFixed(2) : null,
    avgMfeR: avg(withR.map(c => c.mfeR)),
    avgMaeR: avg(withR.map(c => c.maeR)),
    // teşhis: hedefe ulaşamayanların en iyi anı
    missAvgMfeR: avg(miss.map(c => c.mfeR)),
    missMaxMfeR: miss.length ? Math.max(...miss.map(c => c.mfeR)) : null,
    avgBars: avg(withR.map(c => c.bars || 0)),
    sample: withR.length,
    // maliyet muhasebesi: avantaj ince olduğu için bunlar sonucu belirleyebilir
    feeSum: +closed.reduce((a, c) => a + (c.feeUsd || 0), 0).toFixed(2),
    fundingSum: +closed.reduce((a, c) => a + (c.fundingUsd || 0), 0).toFixed(2),
    grossSum: +closed.reduce((a, c) => a + (c.pnlGross ?? c.pnl ?? 0), 0).toFixed(2),
  };
}

// ---------------------------- pozisyon takibi --------------------------------
export async function reconcile(notify) {
  const ledger = loadLedger();
  if (!ledger.open.length) {
    // açık pozisyon yokken bile özet güncel kalsın (yalnızca değiştiyse yaz,
    // aksi halde her tur gereksiz commit üretir)
    const stats = summarize(ledger.closed || []);
    if (JSON.stringify(ledger.stats) !== JSON.stringify(stats)) {
      ledger.stats = stats;
      saveLedger(ledger);
    }
    return;
  }
  const still = [];

  for (const p of ledger.open) {
    try {
      const startMs = Date.parse(p.ts);
      const bars = await fetchJson(
        `${DATA_API}/klines?symbol=${p.symbol}&interval=1h&startTime=${startMs}&limit=1000`,
        `${p.symbol} takip klines`
      );

      const { outcome, exit: exitPx, exitMs, mfeR, maeR, bars: nBars } = scanBars(bars, {
        dir: p.dir, stop: p.stop, target: p.target, entry: p.entry, startMs, nowMs: Date.now(),
      });
      // açık pozisyonda da yolculuğu göster (site "en iyi anı" yazabilsin)
      if (!outcome) { still.push({ ...p, mfeR, maeR, bars: nBars }); continue; }

      const sign = p.dir === 'LONG' ? 1 : -1;
      const gross = sign * (exitPx - p.entry) * p.qty;
      // Maliyetler brütten düşülür: komisyon (gidiş dönüş) + fonlama (8 saatlik)
      const costs = tradeCosts({
        notional: p.notional ?? p.qty * p.entry,
        openMs: startMs,
        closeMs: exitMs ?? Date.now(),
      });
      const pnl = gross - costs.costUsd;
      ledger.balance = +(ledger.balance + pnl).toFixed(2);
      ledger.closed.unshift({
        ...p, outcome, exit: exitPx,
        pnlGross: +gross.toFixed(2),
        feeUsd: costs.feeUsd, fundingUsd: costs.fundingUsd,
        pnl: +pnl.toFixed(2),
        mfeR, maeR, bars: nBars, closedTs: new Date().toISOString(),
      });

      await notify(
        `${outcome.includes('HEDEF') ? '🎯' : '🛑'} SANAL kapandı: ${p.symbol} ${p.dir} ${outcome}`,
        `PnL ${fmt(pnl)}$ (brüt ${fmt(gross)}$ − maliyet ${costs.costUsd}$) · Lehe en fazla ${mfeR}R, aleyhe ${maeR}R · Yeni sanal bakiye: ${ledger.balance.toFixed(2)}$ · Sicil: ${ledger.closed.filter(c => c.outcome.includes('HEDEF')).length}✓/${ledger.closed.length}`,
        outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign'
      );
    } catch (e) {
      console.error(`sanal takip hatası ${p.symbol}:`, e.message);
      still.push(p);
    }
  }
  ledger.closed = ledger.closed.slice(0, 200);
  ledger.open = still;
  ledger.stats = summarize(ledger.closed);
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
