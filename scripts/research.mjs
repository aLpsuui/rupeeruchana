// ============================================================================
// Rupeeruchana — kural varyantı taraması (yalnızca araştırma; canlıya dokunmaz)
//
// Her varyant temel kuraldan TEK bir boyutta ayrılır. Sonuçlar iki döneme bölünür:
//   AYAR  (2022-01-01 → ayrım tarihi)  — fikirlerin bakıldığı dönem
//   TEST  (ayrım tarihi → bugün)       — hiç bakılmadan bırakılan dönem
// Bir varyant ancak TEST döneminde de temeli geçerse aday olur. Yalnızca AYAR
// döneminde iyi görünen varyant geçmişe uydurulmuştur; canlıda kaybettirir.
//
// Sıralama ve karar kâr faktörüne (PF) değil, işlem başına net R'ye bakar: PF az
// işlemde kolayca şişer. "coin+" sütunu kaç coinde artıda bitirdiğini söyler;
// tek bir coinden gelen kâr tesadüf olabilir.
//
//   node scripts/research.mjs
//   node scripts/research.mjs --coins all --split 2025-01-01
// ============================================================================

import { writeFileSync } from 'node:fs';
import { RULES } from './update.mjs';
import {
  COIN_LIST, coinData, simulateCoin, regimeSeries, statsR, netR, iso, arg, DAY,
} from './backtest.mjs';

const SPLIT = Date.parse(arg('split', '2025-01-01'));
const OUT = new URL('../research/', import.meta.url);

// --- varyantlar: her biri temelden tek boyutta ayrılır ----------------------
const VARIANTS = [
  { ad: 'TEMEL (canlı)', rules: {}, exit: {} },

  // Hedef: kaçan işlemler ortalama ~0,86R lehe gidiyor — hedef fazla iddialı olabilir
  { ad: 'hedef 1,5R', rules: { targetR: 1.5 }, exit: {} },
  { ad: 'hedef 2,0R', rules: { targetR: 2.0 }, exit: {} },
  { ad: 'hedef 3,0R', rules: { targetR: 3.0 }, exit: {} },

  // Stop genişliği
  { ad: 'stop 1,5×ATR', rules: { atrMult: 1.5 }, exit: {} },
  { ad: 'stop 2,5×ATR', rules: { atrMult: 2.5 }, exit: {} },
  { ad: 'stop 3×ATR', rules: { atrMult: 3 }, exit: {} },

  // Tetik hassasiyeti
  { ad: 'RSI 38/62 (daha seçici)', rules: { rsiLong: 38, rsiShort: 62 }, exit: {} },
  { ad: 'RSI 45/55 (daha gevşek)', rules: { rsiLong: 45, rsiShort: 55 }, exit: {} },
  { ad: 'RSI penceresi 4 mum', rules: { rsiWin: 4 }, exit: {} },
  { ad: 'RSI penceresi 12 mum', rules: { rsiWin: 12 }, exit: {} },

  // Çıkış yönetimi
  { ad: 'süre stopu 3 gün', rules: {}, exit: { timeStopMs: 3 * DAY } },
  { ad: 'süre stopu 14 gün', rules: {}, exit: { timeStopMs: 14 * DAY } },
  { ad: 'başa baş stopu +1R', rules: {}, exit: { beAtR: 1 } },
  { ad: 'başa baş stopu +1,5R', rules: {}, exit: { beAtR: 1.5 } },

  // Piyasa rejimi: dip radarının bulgusu, koşulun kazandığı tek yer boğa rejimiydi
  { ad: 'yalnız BTC boğasında LONG', rules: {}, exit: {}, rejim: 'yonlu' },
  { ad: 'yalnız BTC boğasında işlem', rules: {}, exit: {}, rejim: 'sadeceLong' },
];

const pad = (v, n) => String(v ?? '—').padStart(n);
const fmt = (s, key) => s.trades ? pad(s[key], 8) : pad('—', 8);

async function main() {
  console.log(`veri yükleniyor (${COIN_LIST.length} coin)...`);
  const data = {};
  for (const coin of COIN_LIST) data[coin] = await coinData(coin);

  // BTC rejimi: her 4s kapanışında BTC fiyatı kendi günlük EMA50'sinin üstünde mi
  const btc = data.BTC ?? data[COIN_LIST[0]];
  const rejim = regimeSeries('BTC', btc.d1, btc.h4);

  const results = [];
  for (const v of VARIANTS) {
    const filter = !v.rejim ? null
      : v.rejim === 'sadeceLong'
        ? (a, T) => rejim.get(T) === 'boga' && a.signal.dir === 'LONG'
        : (a, T) => (rejim.get(T) === 'boga') === (a.signal.dir === 'LONG');
    let trades = [];
    for (const coin of COIN_LIST) {
      const { d1, h4, h1 } = data[coin];
      trades = trades.concat(simulateCoin(coin, d1, h4, h1, { rules: v.rules, exit: v.exit, filter }).trades);
    }
    const ayar = trades.filter(t => t.ts < SPLIT);
    const test = trades.filter(t => t.ts >= SPLIT);
    const coinArti = COIN_LIST.filter(c => {
      const a = test.filter(t => t.coin === c);
      return a.length && a.reduce((s, t) => s + netR(t), 0) > 0;
    }).length;
    results.push({ ad: v.ad, varyant: { ...v.rules, ...v.exit, ...(v.rejim ? { rejim: v.rejim } : {}) }, ayar: statsR(ayar), test: statsR(test), coinArti });
    process.stdout.write('.');
  }
  console.log('\n');

  const temel = results[0];
  const head = `${'varyant'.padEnd(26)}${pad('AYAR n', 8)}${pad('ΣR', 8)}${pad('ort R', 8)}` +
    `${pad('TEST n', 9)}${pad('ΣR', 8)}${pad('ort R', 8)}${pad('PF', 7)}${pad('maxDD', 8)}${pad('coin+', 7)}`;
  console.log(`AYAR: 2022-01-01 → ${arg('split', '2025-01-01')}   ·   TEST: ${arg('split', '2025-01-01')} → bugün   ·   R = işlem başına risk`);
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of results) {
    const iyi = r.test.trades && temel.test.trades && r.test.avgRNet > temel.test.avgRNet && r.ayar.avgRNet > temel.ayar.avgRNet;
    console.log(
      `${(r.ad + (iyi ? ' *' : '')).padEnd(26)}${fmt(r.ayar, 'trades')}${fmt(r.ayar, 'sumRNet')}${fmt(r.ayar, 'avgRNet')}` +
      `${pad(r.test.trades, 9)}${fmt(r.test, 'sumRNet')}${fmt(r.test, 'avgRNet')}${pad(r.test.pfNet, 7)}${fmt(r.test, 'maxDdRNet')}${pad(`${r.coinArti}/${COIN_LIST.length}`, 7)}`
    );
  }
  console.log('\n* = hem AYAR hem TEST döneminde temelden iyi (işlem başına net R). Aday olmanın');
  console.log('  asgari şartı budur, yeterli şartı değil: az işlemli varyantta fark gürültü olabilir.');

  const file = new URL(`varyantlar-${new Date().toISOString().slice(0, 10)}.json`, OUT);
  writeFileSync(file, JSON.stringify({
    generated: iso(Date.now()), split: arg('split', '2025-01-01'), coins: COIN_LIST, temelKurallar: RULES, results,
  }, null, 2) + '\n');
  console.log(`\nyazıldı: research/${file.pathname.split('/').pop()}`);
}

main().catch(e => { console.error('ARAŞTIRMA BAŞARISIZ:', e.message); process.exit(1); });
