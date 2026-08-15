// ============================================================================
// Rupeeruchana — Takvim / Olay İzleyici
//
// Üç kaynak, güvenilirlik sırasına göre:
//   1) SEMBOL FARKI  — exchangeInfo'daki USDT çiftleri bir öncekiyle karşılaştırılır.
//      Yeni çift = yeni listeleme, kaybolan çift = delist. %100 mekanik, hiçbir
//      duyuruya bağlı değil, data-api.binance.vision üzerinden çalışır (motorla
//      aynı uç, yani coğrafi engel riski yok). ASIL KAYNAK BUDUR.
//   2) DUYURULAR     — Binance CMS duyuru listesi. Daha erken haber verir ama
//      www.binance.com GitHub sunucularından engellenebilir; başarısız olursa
//      sessizce atlanır ve 1. kaynak işi görür.
//   3) TOKEN KİLİTLERİ — data/unlocks.json içinde ELLE tutulan liste.
//      Ücretsiz ve güvenilir bir kilit takvimi API'si yok (DefiLlama artık
//      ücretli). Bu yüzden otomatik değil, elle beslenen bir liste.
//
// BEKLENTİ AYARI: takvim büyük ihtimalle pump BULDURMAZ, tuzaktan KAÇIRTIR.
// ACE örneğinde takvimdeki tek olay 18 Ağustos token kilidiydi ve aşağı yönlüydü.
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson, httpFetch } from './http.mjs';
import { notify } from './notify.mjs';

const API = 'https://data-api.binance.vision/api/v3';
const DUYURU = 'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=20';
const OUT = new URL('../data/takvim.json', import.meta.url);
const UNLOCKS = new URL('../data/unlocks.json', import.meta.url);

const HARIC = /^(USDC|FDUSD|TUSD|DAI|BUSD|EUR|GBP|TRY|BRL|ARS|USDP)$/;

// Duyuru başlığını sınıflandır (başlıklar İngilizce gelir)
export function siniflandir(baslik = '') {
  const t = baslik.toLowerCase();
  if (/will delist|will remove|delisting|removal of/.test(t)) return 'delist';
  if (/will list|adds? .*trading pair|will add .*spot/.test(t)) return 'listeleme';
  if (/futures will launch|perpetual contract/.test(t)) return 'vadeli';
  if (/seed tag|monitoring tag/.test(t)) return 'etiket';
  if (/launchpool|airdrop|hodler airdrops/.test(t)) return 'launchpool';
  return 'diger';
}

// Kilit tarihlerinden yakın olanları çıkar
export function yakinKilitler(liste = [], nowMs, gun = 14) {
  return liste
    .map(u => ({ ...u, kalanGun: Math.round((Date.parse(u.date) - nowMs) / 86400000) }))
    .filter(u => u.kalanGun >= 0 && u.kalanGun <= gun)
    .sort((a, b) => a.kalanGun - b.kalanGun);
}

function yukle(path, varsayilan) {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  return varsayilan;
}

async function main() {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const eski = yukle(OUT, { symbols: [], sonDuyuruId: 0, olaylar: [] });
  const ilkTur = !eski.symbols?.length;

  // --- 1) sembol farkı
  const info = await fetchJson(`${API}/exchangeInfo`, 'exchangeInfo');
  const simdiki = info.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && !HARIC.test(s.baseAsset))
    .map(s => s.baseAsset)
    .sort();

  const oncekiSet = new Set(eski.symbols || []);
  const simdikiSet = new Set(simdiki);
  const yeni = ilkTur ? [] : simdiki.filter(c => !oncekiSet.has(c));
  const giden = ilkTur ? [] : (eski.symbols || []).filter(c => !simdikiSet.has(c));

  const olaylar = [];
  for (const c of yeni) olaylar.push({ ts: now, tip: 'yeni-listeleme', coin: c, baslik: `${c}/USDT işlem görmeye başladı` });
  for (const c of giden) olaylar.push({ ts: now, tip: 'delist', coin: c, baslik: `${c}/USDT artık işlem görmüyor` });

  // --- 2) duyurular (başarısız olursa sessizce atla)
  let sonDuyuruId = eski.sonDuyuruId || 0;
  let duyuruDurum = 'ok';
  try {
    const r = await httpFetch(DUYURU, { headers: { 'User-Agent': 'Mozilla/5.0' } }, { timeoutMs: 15000, retries: 1 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const makaleler = j?.data?.articles || [];
    if (!makaleler.length) throw new Error('boş liste');
    for (const m of makaleler) {
      if (!(m.id > sonDuyuruId)) continue;
      const tip = siniflandir(m.title);
      if (tip !== 'diger' && !eski.sonDuyuruId) continue; // ilk turda geçmişi doldurma
      if (tip !== 'diger') olaylar.push({ ts: now, tip: `duyuru-${tip}`, baslik: m.title });
    }
    sonDuyuruId = Math.max(sonDuyuruId, ...makaleler.map(m => m.id));
  } catch (e) {
    duyuruDurum = `erişilemedi: ${e.message}`;
    console.warn(`duyuru kaynağı atlandı — ${e.message}`);
  }

  // --- 3) elle tutulan kilit listesi
  const kilitler = yukle(UNLOCKS, { unlocks: [] }).unlocks || [];
  const yakin = yakinKilitler(kilitler, nowMs, 14);

  const out = {
    updated: now,
    note: 'Takvim — sinyal değildir. Amacı pump bulmak değil, bilinen olaylardan haberdar etmek.',
    duyuruDurum,
    symbols: simdiki,
    symbolCount: simdiki.length,
    sonDuyuruId,
    yakinKilitler: yakin,
    olaylar: [...olaylar, ...(eski.olaylar || [])].slice(0, 60),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  console.log(`takvim: ${simdiki.length} USDT çifti${ilkTur ? ' (ilk tur, referans alındı)' : ''} — yeni ${yeni.length}, giden ${giden.length}, duyuru ${duyuruDurum}`);
  if (yakin.length) console.log(`  yaklaşan kilit: ${yakin.map(k => `${k.coin} ${k.kalanGun}g`).join(' ')}`);

  if (olaylar.length && process.env.RUPEE_RADAR_NOTIFY === '1') {
    const satirlar = olaylar.slice(0, 8).map(o => `• ${o.baslik}`).join('\n');
    await notify(
      `🗓 TAKVİM: ${olaylar.length} yeni olay`,
      `${satirlar}\n\nSinyal değildir, işlem açılmaz.`,
      'calendar'
    );
  }
}

if (!process.argv.includes('--no-run')) {
  main().catch(e => { console.error('TAKVİM BAŞARISIZ:', e.message); process.exit(1); });
}
