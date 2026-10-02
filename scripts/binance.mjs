// ============================================================================
// Rupeeruchana — Binance USDⓈ-M Vadeli adaptörü
// Bağımlılık yok: node:crypto ile HMAC-SHA256 imza, fetch ile REST.
// Üç mod:
//   dry     → imzalı HİÇBİR istek atılmaz; emirler sadece döndürülür (rapor).
//   testnet → https://testnet.binancefuture.com (sahte para, gerçek emir akışı)
//   live    → https://fapi.binance.com
// Güvenlik varsayımı: API anahtarı yalnızca "Futures" yetkili, para çekme KAPALI,
// IP kısıtı sunucunun IP'si. Anahtar .env'de, asla git'te değil.
// ============================================================================

import { createHmac } from 'node:crypto';

const BASES = { live: 'https://fapi.binance.com', testnet: 'https://testnet.binancefuture.com' };
const DATA_API = 'https://data-api.binance.vision/api/v3';   // halka açık mum/fiyat verisi
const ZAMAN_ASIMI = 15_000;

export function istemci({ mode = 'dry', key = '', secret = '' } = {}) {
  if (!['dry', 'testnet', 'live'].includes(mode)) throw new Error(`bilinmeyen mod: ${mode}`);
  const base = BASES[mode] || BASES.live;
  let bilgiCache = null, bilgiZaman = 0, saatFarki = 0;

  async function ham(method, url, headers = {}) {
    const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(ZAMAN_ASIMI) });
    const metin = await r.text();
    let j; try { j = JSON.parse(metin); } catch { j = { raw: metin }; }
    if (!r.ok) throw new Error(`Binance HTTP ${r.status} ${method} ${url.split('?')[0].replace(base, '')}: ${JSON.stringify(j).slice(0, 220)}`);
    return j;
  }
  const qs = p => Object.entries(p).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  async function acik(path, params = {}) { return ham('GET', `${base}${path}?${qs(params)}`); }

  async function imzali(method, path, params = {}) {
    if (mode === 'dry') throw new Error(`kuru modda imzalı istek yok: ${method} ${path}`);
    if (!key || !secret) throw new Error('BINANCE_KEY / BINANCE_SECRET tanımlı değil');
    const p = { ...params, timestamp: Date.now() + saatFarki, recvWindow: 5000 };
    const q = qs(p);
    const imza = createHmac('sha256', secret).update(q).digest('hex');
    return ham(method, `${base}${path}?${q}&signature=${imza}`, { 'X-MBX-APIKEY': key });
  }

  // Sunucu saatiyle farkı ölç (imza zaman damgası 1 sn'den fazla kayarsa -1021 gelir)
  async function saatEsitle() {
    try { const t = await acik('/fapi/v1/time'); saatFarki = t.serverTime - Date.now(); } catch { saatFarki = 0; }
    return saatFarki;
  }

  // exchangeInfo: adım/tick/minimum filtreleri; 1 saat önbellek
  async function bilgi() {
    if (bilgiCache && Date.now() - bilgiZaman < 3600e3) return bilgiCache;
    const j = mode === 'dry' ? await ham('GET', `${BASES.live}/fapi/v1/exchangeInfo`) : await acik('/fapi/v1/exchangeInfo');
    bilgiCache = j; bilgiZaman = Date.now();
    return j;
  }
  async function filtre(symbol) {
    const j = await bilgi();
    const s = j.symbols.find(x => x.symbol === symbol);
    if (!s) throw new Error(`${symbol} vadelide yok`);
    const f = t => s.filters.find(x => x.filterType === t) || {};
    return {
      stepSize: +f('LOT_SIZE').stepSize, minQty: +f('LOT_SIZE').minQty,
      tickSize: +f('PRICE_FILTER').tickSize, minNotional: +(f('MIN_NOTIONAL').notional || 0),
      qtyPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision,
    };
  }
  const adimla = (v, adim, hassasiyet) => +((Math.floor(v / adim + 1e-9) * adim).toFixed(hassasiyet));
  async function miktarYuvarla(symbol, qty) { const f = await filtre(symbol); return adimla(qty, f.stepSize, f.qtyPrecision); }
  async function fiyatYuvarla(symbol, px) { const f = await filtre(symbol); return +((Math.round(px / f.tickSize) * f.tickSize).toFixed(f.pricePrecision)); }

  // --- halka açık veri (her modda gerçek) ---
  async function fiyat(symbol) { const j = await ham('GET', `${DATA_API}/ticker/price?symbol=${symbol}`); return +j.price; }
  async function klines(symbol, interval, limit) {
    const raw = await ham('GET', `${DATA_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return { opens: raw.map(k => +k[1]), highs: raw.map(k => +k[2]), lows: raw.map(k => +k[3]), closes: raw.map(k => +k[4]), times: raw.map(k => +k[0]), closeTimes: raw.map(k => +k[6]) };
  }

  // --- hesap (imzalı) ---
  async function bakiye() {
    const j = await imzali('GET', '/fapi/v2/balance');
    const u = j.find(x => x.asset === 'USDT') || {};
    return { toplam: +u.balance || 0, kullanilabilir: +u.availableBalance || 0 };
  }
  async function pozisyonlar() {
    const j = await imzali('GET', '/fapi/v2/positionRisk');
    return j.filter(p => +p.positionAmt !== 0).map(p => ({
      symbol: p.symbol, miktar: +p.positionAmt, giris: +p.entryPrice, kaldirac: +p.leverage,
      marjinTipi: p.marginType, pnl: +p.unRealizedProfit, isaret: +p.markPrice,
    }));
  }
  async function hazirla(symbol, kaldirac) {
    // izole + kaldıraç; "zaten öyle" hataları (-4046, -4028 benzeri) yok sayılır
    try { await imzali('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
    catch (e) { if (!/-4046|No need to change/.test(e.message)) throw e; }
    await imzali('POST', '/fapi/v1/leverage', { symbol, leverage: kaldirac });
  }
  async function emir(params) { return imzali('POST', '/fapi/v1/order', { newOrderRespType: 'RESULT', ...params }); }
  async function emirDurum(symbol, orderId) { return imzali('GET', '/fapi/v1/order', { symbol, orderId }); }
  async function acikEmirler(symbol) { return imzali('GET', '/fapi/v1/openOrders', { symbol }); }
  async function iptalHepsi(symbol) { try { return await imzali('DELETE', '/fapi/v1/allOpenOrders', { symbol }); } catch (e) { if (!/-2011/.test(e.message)) throw e; return null; } }
  async function islemler(symbol, startTime) { return imzali('GET', '/fapi/v1/userTrades', { symbol, startTime, limit: 100 }); }

  // --- yüksek seviye: giriş + stop + hedef ---
  // Dönüş: { entry: {orderId, avgPrice, qty}, stop: {orderId}, target: {orderId} }
  // Kuru modda hiçbir şey gönderilmez, hesaplanan emirler döner.
  async function pozisyonAc({ symbol, dir, qty, stop, target, kaldirac }) {
    const side = dir === 'LONG' ? 'BUY' : 'SELL', kapatSide = dir === 'LONG' ? 'SELL' : 'BUY';
    const f = await filtre(symbol);
    const q = adimla(qty, f.stepSize, f.qtyPrecision);
    const sp = await fiyatYuvarla(symbol, stop), tp = await fiyatYuvarla(symbol, target);
    if (q < f.minQty) throw new Error(`${symbol}: miktar ${q} < minimum ${f.minQty}`);
    const plan = {
      entry: { symbol, side, type: 'MARKET', quantity: q },
      stop: { symbol, side: kapatSide, type: 'STOP_MARKET', stopPrice: sp, closePosition: 'true', workingType: 'CONTRACT_PRICE' },
      target: { symbol, side: kapatSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'CONTRACT_PRICE' },
    };
    if (mode === 'dry') return { dry: true, plan, entry: { orderId: null, avgPrice: null, qty: q }, stop: { orderId: null }, target: { orderId: null } };
    await hazirla(symbol, kaldirac);
    const e = await emir(plan.entry);
    const avg = +e.avgPrice || +e.price || null;
    let s = null, t = null;
    try {
      s = await emir(plan.stop);
      t = await emir(plan.target);
    } catch (err) {
      // Stop/hedef konamadıysa pozisyonu korumasız bırakma: hemen kapat.
      try { await emir({ symbol, side: kapatSide, type: 'MARKET', quantity: q, reduceOnly: 'true' }); } catch {}
      throw new Error(`stop/hedef emri konamadı, pozisyon kapatıldı: ${err.message}`);
    }
    return { dry: false, plan, entry: { orderId: e.orderId, avgPrice: avg, qty: +e.executedQty || q }, stop: { orderId: s.orderId }, target: { orderId: t.orderId } };
  }

  async function pozisyonKapat(symbol, dir, qty) {
    const kapatSide = dir === 'LONG' ? 'SELL' : 'BUY';
    await iptalHepsi(symbol);
    if (mode === 'dry') return { dry: true };
    const q = await miktarYuvarla(symbol, qty);
    return emir({ symbol, side: kapatSide, type: 'MARKET', quantity: q, reduceOnly: 'true' });
  }

  // Kapanmış bir işlemin gerçekleşen çıkış fiyatı, komisyonu ve realize PnL'i (userTrades'ten)
  async function gerceklesen(symbol, acilisMs) {
    const t = await islemler(symbol, acilisMs - 60_000);
    const kapanis = t.filter(x => Date.parse(new Date(x.time)) > acilisMs + 1000 && +x.realizedPnl !== 0);
    const komisyon = t.reduce((a, x) => a + (x.commissionAsset === 'USDT' ? +x.commission : 0), 0);
    const pnl = t.reduce((a, x) => a + (+x.realizedPnl || 0), 0);
    const qty = kapanis.reduce((a, x) => a + +x.qty, 0);
    const cikis = qty ? kapanis.reduce((a, x) => a + +x.price * +x.qty, 0) / qty : null;
    return { cikis, komisyon: +komisyon.toFixed(4), realizedPnl: +pnl.toFixed(4), islemSayisi: t.length };
  }

  return { mode, base, saatEsitle, bilgi, filtre, miktarYuvarla, fiyatYuvarla, fiyat, klines, bakiye, pozisyonlar, hazirla,
           emir, emirDurum, acikEmirler, iptalHepsi, islemler, pozisyonAc, pozisyonKapat, gerceklesen };
}
