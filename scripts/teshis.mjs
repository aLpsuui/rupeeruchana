// ============================================================================
// Rupeeruchana — tek coin teşhisi
// "Şu an sinyal gelir mi?" sorusunun kural kural cevabı. v3 kurallarının her bir
// koşulunun nerede durduğunu ve tetiğe ne kadar kaldığını yazar.
// Analiz motorunun AYNI fonksiyonunu (analyzeCoin) kullanır, ayrı bir kural
// kopyası değildir. Hiçbir dosyaya yazmaz, bildirim yollamaz.
//
// Kullanım:  node scripts/teshis.mjs BTC        (argüman yoksa COINS'in hepsi)
//            node scripts/teshis.mjs TRUMP XRP
// ============================================================================

import { analyzeCoin, COINS, RULES } from './update.mjs';
import { fetchJson } from './http.mjs';

const API = 'https://data-api.binance.vision/api/v3';

async function klines(coin, interval, limit) {
  const raw = await fetchJson(
    `${API}/klines?symbol=${coin}USDT&interval=${interval}&limit=${limit}`,
    `${coin} ${interval}`,
  );
  return {
    opens: raw.map(k => +k[1]), highs: raw.map(k => +k[2]),
    lows: raw.map(k => +k[3]), closes: raw.map(k => +k[4]), times: raw.map(k => +k[0]),
  };
}

// update.mjs'teki gösterge matematiğinin aynısı (o dosya dışa açmıyor).
function ema(v, len) {
  const k = 2 / (len + 1);
  const out = [];
  let prev = v.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = 0; i < v.length; i++) {
    if (i < len - 1) { out.push(null); continue; }
    if (i === len - 1) { out.push(prev); continue; }
    prev = v[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(c, len = 14) {
  const out = new Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len;
  out[len] = 100 - 100 / (1 + g / (l || 1e-9));
  for (let i = len + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (len - 1) + Math.max(d, 0)) / len;
    l = (l * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = 100 - 100 / (1 + g / (l || 1e-9));
  }
  return out;
}

const f = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 0 });
const pct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

async function teshis(coin) {
  const [d, h] = await Promise.all([klines(coin, '1d', 120), klines(coin, '4h', 260)]);
  const a = analyzeCoin(coin, d, h);

  const dC = d.closes.slice(0, -1);
  const e50 = ema(dC, RULES.dailyLen);
  const egim = (e50.at(-1) / e50.at(-2) - 1) * 100;
  const hC = h.closes.slice(0, -1);
  const e21 = ema(hC, RULES.emaLen);
  const r14 = rsi(hC, RULES.rsiLen);
  const son8 = r14.slice(-RULES.rsiWin).filter(v => v !== null);
  const rsiDip = Math.min(...son8), rsiTepe = Math.max(...son8);
  const ustunde = a.price > e50.at(-1);

  console.log(`\n${coin}/USDT — v3 kural teşhisi`);
  console.log('-'.repeat(62));
  console.log(`fiyat                  ${f(a.price)}`);
  console.log(`günlük EMA50           ${f(e50.at(-1))}  (fiyat ${pct((a.price / e50.at(-1) - 1) * 100)} ${ustunde ? 'ÜSTÜNDE' : 'ALTINDA'})`);
  console.log(`EMA50 eğimi            ${pct(egim)}/gün -> ${egim > 0 ? 'YÜKSELİYOR' : 'DÜŞÜYOR'}`);
  console.log(`4s EMA21               ${f(e21.at(-1))}  (son kapanış ${f(hC.at(-1))}, ${hC.at(-1) > e21.at(-1) ? 'üstünde' : 'altında'})`);
  console.log(`4s RSI(14)             ${r14.at(-1).toFixed(1)}  (son ${RULES.rsiWin} mumda dip ${rsiDip.toFixed(1)} / tepe ${rsiTepe.toFixed(1)})`);
  console.log(`motorun durumu         ${a.status}${a.dir ? ' ' + a.dir : ''}`);

  // Her iki yönün koşulları: [ad, sağlandı mı, açıklama]
  const yonler = {
    LONG: [
      ['fiyat günlük EMA50 üstünde', ustunde, `EMA50 ${f(e50.at(-1))}`],
      ['günlük EMA50 yükseliyor', egim > 0, `${pct(egim)}/gün`],
      [`son ${RULES.rsiWin} 4s mumda RSI < ${RULES.rsiLong} görüldü`, rsiDip < RULES.rsiLong, `dip ${rsiDip.toFixed(1)}`],
      ['son kapalı 4s mum EMA21 ÜSTÜNE kesti', hC.at(-1) > e21.at(-1) && hC.at(-2) <= e21.at(-2),
        `önceki kapanış ${f(hC.at(-2))} / EMA21 ${f(e21.at(-2))}, son ${f(hC.at(-1))} / ${f(e21.at(-1))}`],
    ],
    SHORT: [
      ['fiyat günlük EMA50 altında', !ustunde, `EMA50 ${f(e50.at(-1))}${ustunde ? ` — ${pct((e50.at(-1) / a.price - 1) * 100)} inmesi lazım` : ''}`],
      ['günlük EMA50 düşüyor', egim < 0, `${pct(egim)}/gün`],
      [`son ${RULES.rsiWin} 4s mumda RSI > ${RULES.rsiShort} görüldü`, rsiTepe > RULES.rsiShort, `tepe ${rsiTepe.toFixed(1)}`],
      ['son kapalı 4s mum EMA21 ALTINA kesti', hC.at(-1) < e21.at(-1) && hC.at(-2) >= e21.at(-2),
        `önceki kapanış ${f(hC.at(-2))} / EMA21 ${f(e21.at(-2))}, son ${f(hC.at(-1))} / ${f(e21.at(-1))}`],
    ],
  };

  for (const [yon, kosullar] of Object.entries(yonler)) {
    const saglanan = kosullar.filter(k => k[1]).length;
    console.log(`\n${yon} için ${saglanan}/4 koşul sağlanıyor:`);
    for (const [ad, ok, not] of kosullar) console.log(`  ${ok ? '[+]' : '[ ]'} ${ad}  —  ${not}`);
  }

  if (a.signal) {
    console.log(`\nAKTİF SİNYAL: ${a.dir} · giriş ${f(a.signal.entry)} · stop ${f(a.signal.stop)} · hedef ${f(a.signal.target)}`);
  }
}

const hedefler = process.argv.slice(2).map(s => s.toUpperCase().replace('USDT', ''));
for (const c of (hedefler.length ? hedefler : COINS)) {
  try { await teshis(c); }
  catch (e) { console.log(`\n${c}: teşhis başarısız — ${e.message}`); }
}
console.log('\nBilgilendirmedir, yatırım tavsiyesi değildir. Kurallar: v3 · 4s · stop 2×ATR · hedef 2,5R.');
