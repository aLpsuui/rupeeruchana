// ============================================================================
// Rupeeruchana — Dip Radarı
// Binance'teki tüm USDT çiftlerini tarar ve şu koşulu sağlayanları listeler:
//   fiyat günlük EMA50'nin %35+ ALTINDA  VE  son 60 günün en düşük kapanışı
//
// NEDEN BU KOŞUL (15 Ağu 2026, 404 coin / 117.872 örnekle ölçüldü):
//   |                          | rastgele giriş | dip koşulu |
//   | 30 günde +%50 gören      |         %11,5  |     %20,2  |
//   | 30 günde +%100 gören     |          %3,7  |      %6,5  |
//   | 30 gün ortalama getiri   |         -%8,8  |     -%1,8  |
//   İkiye katlama ihtimali yaklaşık iki katına çıkıyor. AMA medyan hâlâ -%7,3:
//   bu bir piyango dağılımıdır, çoğu aday kanar, 15'te biri patlar.
//   Test edilip ELENEN varyantlar: hacim 2x filtresi (iyileştirmedi),
//   dip sonrası tepe kırılımı teyidi (ortalamayı -%6'ya düşürdü).
//
// Bu modül SİNYAL ÜRETMEZ, işlem AÇMAZ. Yaptığı tek şey adayları listelemek ve
// kendi isabetini 30 gün boyunca ölçüp kaydetmek: sicil tutmayan bir tarayıcı
// kendini kandırmanın en kolay yoludur.
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson } from './http.mjs';
import { notify } from './notify.mjs';

const API = 'https://data-api.binance.vision/api/v3';
const OUT = new URL('../data/dipradar.json', import.meta.url);

export const EMA_GAP = 0.35;   // EMA50'nin en az %35 altında
export const LOW_DAYS = 60;    // son 60 günün en düşük kapanışı
export const HORIZON = 30;     // adayı 30 gün takip et
const BATCH = 12;              // aynı anda kaç istek

// Stablecoin, sarmalanmış ve kaldıraçlı token'lar taramaya girmez
const HARIC = /^(USDC|FDUSD|TUSD|DAI|BUSD|EUR|GBP|TRY|BRL|ARS|USDP|PAXG|WBTC|WBETH|BETH)$/;

function ema(v, len) {
  const k = 2 / (len + 1); const out = [];
  let p = v.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = 0; i < v.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    if (i === len - 1) { out.push(p); continue; }
    p = v[i] * k + p * (1 - k); out.push(p);
  }
  return out;
}

// Saf ve test edilebilir: bu mumlarda koşul sağlanıyor mu?
export function dipKosulu({ closes, emaGap = EMA_GAP, lowDays = LOW_DAYS }) {
  if (closes.length < lowDays + 2) return null;
  const e50 = ema(closes, 50);
  const son = closes.at(-1), e = e50.at(-1);
  if (e == null || !(e > 0)) return null;
  const sapma = son / e - 1;
  const dipMi = son <= Math.min(...closes.slice(-lowDays));
  return {
    uygun: sapma < -emaGap && dipMi,
    emaGapPct: +(sapma * 100).toFixed(1),
    dipMi,
  };
}

export function ozetle(kapali = []) {
  if (!kapali.length) return { n: 0 };
  const chg = kapali.map(k => k.chgPct).filter(x => x != null);
  const max = kapali.map(k => k.maxPct).filter(x => x != null);
  const ort = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
  const medyan = a => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null; };
  const yuzde = (a, esik) => a.length ? +((a.filter(x => x >= esik).length / a.length) * 100).toFixed(1) : null;
  return {
    n: kapali.length,
    ortChg: ort(chg), medyanChg: medyan(chg),
    artida: chg.length ? +((chg.filter(x => x > 0).length / chg.length) * 100).toFixed(0) : null,
    pct50: yuzde(max, 50), pct100: yuzde(max, 100),
  };
}

function yukle() {
  if (existsSync(OUT)) {
    try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
  }
  return { active: [], closed: [] };
}

async function main() {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const eski = yukle();

  const info = await fetchJson(`${API}/exchangeInfo`, 'exchangeInfo');
  const coins = info.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING'
              && !HARIC.test(s.baseAsset) && !/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset))
    .map(s => s.baseAsset);

  const takip = new Map((eski.active || []).map(a => [a.coin, a]));
  const bulunan = [];
  let tarandi = 0, atlandi = 0;

  for (let b = 0; b < coins.length; b += BATCH) {
    await Promise.all(coins.slice(b, b + BATCH).map(async coin => {
      let bars;
      try {
        bars = await fetchJson(`${API}/klines?symbol=${coin}USDT&interval=1d&limit=120`, `${coin} dip tarama`, { retries: 0 });
      } catch { atlandi++; return; }
      if (!bars || bars.length < LOW_DAYS + 2) { atlandi++; return; }
      tarandi++;

      const t = bars.map(k => +k[0]);
      const h = bars.map(k => +k[2]);
      const l = bars.map(k => +k[3]);
      const c = bars.map(k => +k[4]);
      const k = dipKosulu({ closes: c });
      if (k?.uygun) bulunan.push({ coin, price: c.at(-1), emaGapPct: k.emaGapPct });

      // takipteki adayın performansını güncelle (giriş gününden bugüne)
      const izlenen = takip.get(coin);
      if (izlenen) {
        const i0 = t.findIndex(x => x >= Date.parse(izlenen.ts) - 86400000);
        if (i0 >= 0) {
          izlenen.price = c.at(-1);
          izlenen.chgPct = +((c.at(-1) / izlenen.entry - 1) * 100).toFixed(1);
          izlenen.maxPct = +((Math.max(...h.slice(i0)) / izlenen.entry - 1) * 100).toFixed(1);
          izlenen.minPct = +((Math.min(...l.slice(i0)) / izlenen.entry - 1) * 100).toFixed(1);
          izlenen.days = Math.floor((nowMs - Date.parse(izlenen.ts)) / 86400000);
        }
      }
    }));
  }

  // yeni adayları takibe al (aynı coini tekrar eklemeyiz)
  const yeniler = [];
  for (const b of bulunan) {
    if (takip.has(b.coin)) continue;
    yeniler.push(b);
    takip.set(b.coin, {
      coin: b.coin, ts: now, entry: b.price, price: b.price,
      emaGapPct: b.emaGapPct, chgPct: 0, maxPct: 0, minPct: 0, days: 0,
    });
  }

  // 30 günü dolanları sicile taşı
  const active = [], kapananlar = [];
  for (const a of takip.values()) {
    if (a.days >= HORIZON) kapananlar.push({ ...a, closedTs: now });
    else active.push(a);
  }
  const closed = [...kapananlar, ...(eski.closed || [])].slice(0, 300);

  const out = {
    updated: now,
    note: 'Dip Radarı — sinyal değildir, işlem açmaz. Adaylar 30 gün takip edilir ve isabet ölçülür.',
    criteria: { emaGapPct: EMA_GAP * 100, lowDays: LOW_DAYS, horizonDays: HORIZON },
    scanned: tarandi, skipped: atlandi,
    hits: bulunan.length,
    active: active.sort((a, b) => a.emaGapPct - b.emaGapPct),
    closed,
    stats: ozetle(closed),
    // ölçüm anındaki referans (15 Ağu 2026, 404 coin / 117.872 örnek)
    baseline: { pct50: 11.5, pct100: 3.7, ortChg: -8.8, kaynak: 'rastgele giriş, aynı evren' },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  // Yeni aday nadirdir (evrenin ~%1'i), o yüzden bildirime değer.
  // Aynı switch: RUPEE_RADAR_NOTIFY=1
  if (yeniler.length && process.env.RUPEE_RADAR_NOTIFY === '1') {
    await notify(
      `🕳 DİP RADARI: ${yeniler.length} yeni aday`,
      `${yeniler.map(y => `${y.coin} (EMA50'nin %${Math.abs(y.emaGapPct)} altında)`).join('\n')}\n\n` +
      `Ölçüm: bu koşulda 30 gün içinde ikiye katlama ihtimali %6,5 (rastgele girişte %3,7). ` +
      `Medyan getiri yine de eksi — piyango dağılımı. Sinyal değildir, işlem açılmaz.`,
      'hole'
    );
  }

  console.log(`dip radarı: ${tarandi} coin tarandı (${atlandi} atlandı) — koşulu sağlayan ${bulunan.length}, takipte ${active.length}, sicil ${closed.length}`);
  if (bulunan.length) console.log(`  adaylar: ${bulunan.map(b => `${b.coin}(${b.emaGapPct}%)`).join(' ')}`);
  if (out.stats.n) console.log(`  sicil: ${out.stats.n} kayıt · ortalama ${out.stats.ortChg}% · +%100 gören ${out.stats.pct100}% (taban %3,7)`);
}

if (!process.argv.includes('--no-run')) {
  main().catch(e => { console.error('DİP RADARI BAŞARISIZ:', e.message); process.exit(1); });
}
