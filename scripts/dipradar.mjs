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

// İKİ KATMAN (15 Ağu 2026'da eklendi).
// Sıkı eşik yavaş eriyen coinleri kaçırıyor: fiyat yavaş düşünce EMA50 de peşinden
// gelir ve aradaki mesafe hiç açılmaz. COW eşiğe %1 uzaklıkla takıldı (-%34 vs -%35),
// sonra bir günde %46 yaptı. Ölçüm (aynı 404 coin / 117.872 örnek):
//   eşik    aday   30g ort   +%50    +%100   toplam çift-katlama
//   -%35    1951    -%1,8   %20,2    %6,5    127
//   -%25    6348    -%3,1   %17,9    %5,4    343
// Sıkı katman daha kaliteli, geniş katman üç kat fazla bilet veriyor. Piyango
// dağılımında hangisinin daha iyi olduğu belli değil, o yüzden İKİSİ DE
// takip edilir ve sicilleri ayrı ayrı ölçülür.
export const EMA_GAP = 0.25;        // radara girme eşiği (geniş katman)
export const EMA_GAP_SIKI = 0.35;   // "sıkı" katman sınırı
export const LOW_DAYS = 60;    // son 60 günün en düşük kapanışı
export const HORIZON = 30;     // adayı 30 gün takip et

// --- PİYASA REJİMİ (17 Ağu 2026'da eklendi — bu modülün en belirleyici bulgusu) ---
// Aynı dip koşulu, BTC'nin kendi 50 günlük EMA'sının üstünde/altında olmasına göre
// ayrıldığında bambaşka davranıyor (500 günlük pencere, 451 gün rejim verisi):
//   rejim   küme        örnek   30g ort   +%50    +%100
//   BOĞA    rastgele    52489    -%5,1   %14,2    %4,3
//   BOĞA    dip koşulu    303    +%8,4   %35,0   %12,5   <-- gerçek avantaj
//   AYI     rastgele    92034    -%6,1   %11,4    %3,5
//   AYI     dip koşulu   5971    -%1,9   %18,6    %5,4   <-- rastgeleden iyi ama eksi
// Yani koşul her rejimde tabanı yener, ama yalnızca boğada mutlak kazandırır.
// Modül adayları her rejimde listeler (sicil birikmeye devam etsin diye) ama
// rejimi her yerde açıkça yazar ve bildirimi yalnızca boğada yollar.
export const REJIM_EMA = 50;
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
    katman: sapma < -EMA_GAP_SIKI ? 'siki' : 'genis',
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

// Taranacak coin listesi. Sıra: canlı exchangeInfo → takvim.json anlık görüntüsü.
async function semboller() {
  const ele = c => !HARIC.test(c) && !/(UP|DOWN|BULL|BEAR)$/.test(c);
  try {
    const info = await fetchJson(`${API}/exchangeInfo`, 'exchangeInfo', { timeoutMs: 90_000, retries: 1 });
    const liste = info.symbols
      .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && ele(s.baseAsset))
      .map(s => s.baseAsset);
    if (liste.length) return liste;
    throw new Error('boş liste');
  } catch (e) {
    const snap = yukle(new URL('../data/takvim.json', import.meta.url), null);
    const yedek = (snap?.symbols || []).filter(ele);
    if (!yedek.length) throw new Error(`sembol listesi alınamadı: ${e.message}`);
    console.warn(`exchangeInfo alınamadı (${e.message}) — takvim anlık görüntüsü kullanılıyor (${yedek.length} coin, ${snap.updated})`);
    return yedek;
  }
}

// BTC kendi 50 günlük EMA'sının üstünde mi? Dip koşulunun kazanıp kazanmadığını
// belirleyen tek değişken bu.
async function piyasaRejimi() {
  try {
    const raw = await fetchJson(`${API}/klines?symbol=BTCUSDT&interval=1d&limit=120`, 'BTC rejim');
    const c = raw.map(k => +k[4]);
    const e = ema(c.slice(0, -1), REJIM_EMA);   // kapanmış günlerden
    const btc = c.at(-1), btcEma = e.at(-1);
    if (btcEma == null) return { rejim: 'bilinmiyor' };
    return {
      rejim: btc > btcEma ? 'boga' : 'ayi',
      btc: +btc.toFixed(0),
      btcEma: +btcEma.toFixed(0),
      fark: +(((btc / btcEma) - 1) * 100).toFixed(1),
    };
  } catch (e) {
    console.warn(`rejim belirlenemedi: ${e.message}`);
    return { rejim: 'bilinmiyor' };
  }
}

async function main() {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const eski = yukle();

  // Sembol listesi: önce exchangeInfo (~9 MB, ayrı zaman aşımı bütçesi), olmazsa
  // takvim modülünün bıraktığı anlık görüntü. 15 Ağu 2026'da exchangeInfo yanıt
  // vermeyince tarama tamamen durmuştu; tek bir yavaş uç bütün modülü öldürmemeli.
  const coins = await semboller();
  const rj = await piyasaRejimi();

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
      if (k?.uygun) bulunan.push({ coin, price: c.at(-1), emaGapPct: k.emaGapPct, katman: k.katman });

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
      emaGapPct: b.emaGapPct, katman: b.katman, rejim: rj.rejim,
      chgPct: 0, maxPct: 0, minPct: 0, days: 0,
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
    criteria: { emaGapPct: EMA_GAP * 100, sikiPct: EMA_GAP_SIKI * 100, lowDays: LOW_DAYS, horizonDays: HORIZON },
    scanned: tarandi, skipped: atlandi,
    hits: bulunan.length,
    active: active.sort((a, b) => a.emaGapPct - b.emaGapPct),
    closed,
    stats: ozetle(closed),
    // iki katmanın sicilleri ayrı ayrı: hangisi daha iyi, veri söyleyecek
    statsSiki: ozetle(closed.filter(k => k.katman === 'siki')),
    statsGenis: ozetle(closed.filter(k => k.katman === 'genis')),
    ...rj,
    // ölçülmüş referans: koşul her rejimde tabanı yener, ama yalnız boğada artı verir
    olculen: {
      boga: { ort: 8.4, pct50: 35.0, pct100: 12.5, taban100: 4.3, ornek: 303 },
      ayi:  { ort: -1.9, pct50: 18.6, pct100: 5.4, taban100: 3.5, ornek: 5971 },
    },
    statsBoga: ozetle(closed.filter(k => k.rejim === 'boga')),
    statsAyi: ozetle(closed.filter(k => k.rejim === 'ayi')),
    // ölçüm anındaki referans (15 Ağu 2026, 404 coin / 117.872 örnek)
    baseline: { pct50: 11.5, pct100: 3.7, ortChg: -8.8, kaynak: 'rastgele giriş, aynı evren' },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  // Bildirim yalnızca BOĞA rejiminde. Ayı rejiminde koşul rastgeleyi yener ama
  // mutlak getirisi eksi; o dönemde bildirim yollamak yanlış işlem davet eder.
  if (yeniler.length && process.env.RUPEE_RADAR_NOTIFY === '1') {
    if (rj.rejim === 'boga') {
      await notify(
        `🕳 DİP RADARI: ${yeniler.length} yeni aday · BOĞA rejimi`,
        `${yeniler.map(y => `${y.coin} (EMA50'nin %${Math.abs(y.emaGapPct)} altında)`).join('\n')}\n\n` +
        `BTC 50g EMA'sının %${rj.fark} üstünde. Bu rejimde ölçüm: 30 günde ortalama +%8,4, ` +
        `her 8 adaydan biri ikiye katlıyor (%12,5, taban %4,3).\n` +
        `Sinyal değildir, işlem açılmaz. Kuyruk dağılımı: küçük ve eşit pozisyon şart.`,
        'hole'
      );
    } else {
      console.log(`bildirim atlandı — ayı rejimi (BTC 50g EMA'nın %${rj.fark ?? '?'} altında)`);
    }
  }

  console.log(`piyasa rejimi: ${rj.rejim.toUpperCase()}${rj.btc ? ` (BTC ${rj.btc} vs 50g EMA ${rj.btcEma}, %${rj.fark})` : ''}`);
  console.log(`dip radarı: ${tarandi} coin tarandı (${atlandi} atlandı) — koşulu sağlayan ${bulunan.length}, takipte ${active.length}, sicil ${closed.length}`);
  if (bulunan.length) console.log(`  adaylar: ${bulunan.map(b => `${b.coin}(${b.emaGapPct}%${b.katman === 'siki' ? '!' : ''})`).join(' ')}`);
  if (out.stats.n) console.log(`  sicil: ${out.stats.n} kayıt · ortalama ${out.stats.ortChg}% · +%100 gören ${out.stats.pct100}% (taban %3,7)`);
}

if (!process.argv.includes('--no-run')) {
  main().catch(e => { console.error('DİP RADARI BAŞARISIZ:', e.message); process.exit(1); });
}
