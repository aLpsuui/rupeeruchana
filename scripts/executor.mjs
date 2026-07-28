// ============================================================================
// Rupeeruchana — Testnet Otomatik İşlem Modülü (Binance Spot Testnet)
// GÜVENLİK: Bu modül YALNIZCA https://testnet.binance.vision (sahte para) ile
// konuşur. Gerçek borsaya bağlanmaz. Anahtarlar GitHub Secrets'tan gelir;
// anahtar yoksa modül sessizce devre dışı kalır.
// Akış: LONG sinyal → market alış + OCO satış (hedef limit + stop) borsaya
// kurulur → sonraki turlarda OCO durumu kontrol edilir → sonuç bildirilir.
// SHORT sinyaller spot'ta yalnızca bildirim olarak kalır.
// ============================================================================

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://testnet.binance.vision';
const LEDGER_PATH = new URL('../data/autotrade.json', import.meta.url);

const KEY = process.env.BINANCE_TESTNET_KEY || '';
const SECRET = process.env.BINANCE_TESTNET_SECRET || '';

export const enabled = () => Boolean(KEY && SECRET);

// ---------------------------- yardımcılar -----------------------------------
export function roundStep(value, step) {
  // 0.001 gibi adımlara aşağı yuvarla (Binance LOT_SIZE / PRICE_FILTER)
  const d = Math.max(0, (step.toString().split('.')[1] || '').replace(/0+$/, '').length);
  const floored = Math.floor(value / step) * step;
  return parseFloat(floored.toFixed(d));
}

function qs(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function api(path, params = {}, method = 'GET', signed = false) {
  let query = qs({ ...params, ...(signed ? { timestamp: Date.now(), recvWindow: 10000 } : {}) });
  if (signed) query += `&signature=${createHmac('sha256', SECRET).update(query).digest('hex')}`;
  const url = `${BASE}${path}?${query}`;
  const r = await fetch(url, { method, headers: { 'X-MBX-APIKEY': KEY } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { open: [], closed: [], note: 'Binance Spot TESTNET — sahte para' };
  try { return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')); }
  catch { return { open: [], closed: [], note: 'Binance Spot TESTNET — sahte para' }; }
}
function saveLedger(l) { writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n'); }

async function filtersFor(symbol) {
  const info = await api('/api/v3/exchangeInfo', { symbol });
  const s = info.symbols?.[0];
  const f = Object.fromEntries((s?.filters || []).map(x => [x.filterType, x]));
  return {
    stepSize: parseFloat(f.LOT_SIZE?.stepSize || '0.000001'),
    tickSize: parseFloat(f.PRICE_FILTER?.tickSize || '0.01'),
    minNotional: parseFloat(f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || '10'),
  };
}

async function usdtFree() {
  const acc = await api('/api/v3/account', {}, 'GET', true);
  const u = (acc.balances || []).find(b => b.asset === 'USDT');
  return u ? parseFloat(u.free) : 0;
}

// ---------------------------- işlem açma ------------------------------------
// riskPct: bakiyenin yüzdesi (varsayılan %1 — gerçek plandaki kuralın aynısı)
export async function openLong(sig, notify, riskPct = 1) {
  const symbol = `${sig.coinRaw}USDT`;
  const ledger = loadLedger();
  if (ledger.open.some(p => p.symbol === symbol)) {
    console.log(`${symbol}: zaten açık testnet pozisyonu var, atlandı`);
    return;
  }

  const [flt, balance] = await Promise.all([filtersFor(symbol), usdtFree()]);
  const entry = sig.entryNum, stop = sig.stopNum, target = sig.targetNum;
  const riskUsd = Math.max(10, balance * riskPct / 100); // testnet min emir ~10$
  let qty = riskUsd / (entry - stop);
  const maxNotional = balance * 0.25;                    // tavan: bakiyenin %25'i
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  qty = roundStep(qty, flt.stepSize);
  if (qty * entry < flt.minNotional) { console.log(`${symbol}: minimum emir altında, atlandı`); return; }

  // 1) market alış
  const buy = await api('/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quantity: qty }, 'POST', true);
  const fillPx = buy.fills?.length
    ? buy.fills.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0) / buy.fills.reduce((a, f) => a + parseFloat(f.qty), 0)
    : entry;

  // 2) OCO satış: hedef limit + stop-limit — koruma borsanın kendisinde yaşar
  const tp = roundStep(target, flt.tickSize);
  const sp = roundStep(stop, flt.tickSize);
  const spl = roundStep(stop * 0.997, flt.tickSize);
  const execQty = roundStep(parseFloat(buy.executedQty || qty), flt.stepSize);
  const oco = await api('/api/v3/order/oco', {
    symbol, side: 'SELL', quantity: execQty,
    price: tp, stopPrice: sp, stopLimitPrice: spl, stopLimitTimeInForce: 'GTC',
  }, 'POST', true);

  ledger.open.push({
    symbol, dir: 'LONG', qty: execQty, entry: fillPx, stop: sp, target: tp,
    ocoId: oco.orderListId, ts: new Date().toISOString(),
  });
  saveLedger(ledger);
  await notify(`🤖 TESTNET işlem açıldı: ${symbol} LONG`,
    `Giriş ~${fillPx.toFixed(2)} · Miktar ${execQty} · Stop ${sp} · Hedef ${tp} (borsada OCO kurulu)`, 'robot');
  console.log(`TESTNET AÇILDI: ${symbol} qty=${execQty} entry=${fillPx} oco=${oco.orderListId}`);
}

// ---------------------------- pozisyon takibi --------------------------------
export async function reconcile(notify) {
  const ledger = loadLedger();
  if (!ledger.open.length) return;
  const still = [];
  for (const p of ledger.open) {
    try {
      const ol = await api('/api/v3/orderList', { orderListId: p.ocoId }, 'GET', true);
      if (ol.listOrderStatus !== 'ALL_DONE') { still.push(p); continue; }
      // hangi bacak doldu?
      let outcome = 'KAPANDI', exitPx = null;
      for (const o of ol.orders || []) {
        const od = await api('/api/v3/order', { symbol: p.symbol, orderId: o.orderId }, 'GET', true);
        if (od.status === 'FILLED') {
          exitPx = parseFloat(od.price) || parseFloat(od.stopPrice) || null;
          outcome = od.type === 'LIMIT_MAKER' || od.type === 'LIMIT' ? 'HEDEF ✓' : 'STOP ✗';
        }
      }
      const pnl = exitPx ? (exitPx - p.entry) * p.qty : null;
      ledger.closed.unshift({ ...p, outcome, exit: exitPx, pnl: pnl ? +pnl.toFixed(2) : null, closedTs: new Date().toISOString() });
      await notify(
        `${outcome.includes('HEDEF') ? '🎯' : '🛑'} TESTNET kapandı: ${p.symbol} ${outcome}`,
        `Giriş ${p.entry.toFixed(2)} → Çıkış ${exitPx ? exitPx.toFixed(2) : '?'} · PnL ${pnl ? (pnl > 0 ? '+' : '') + pnl.toFixed(2) : '?'} USDT (sahte para)`,
        outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign');
    } catch (e) {
      console.error(`takip hatası ${p.symbol}:`, e.message);
      still.push(p);
    }
  }
  ledger.closed = ledger.closed.slice(0, 100);
  ledger.open = still;
  saveLedger(ledger);
}

// ---------------------------- test işlemi (elle tetikleme) -------------------
// workflow_dispatch "test_trade" girdisiyle: zinciri doğrulamak için minik BTC işlemi
export async function forceTestTrade(notify, priceNow) {
  const stop = priceNow * 0.99, target = priceNow * 1.005; // dar test bandı
  await openLong({ coinRaw: 'BTC', entryNum: priceNow, stopNum: stop, targetNum: target }, notify, 0.5);
}
