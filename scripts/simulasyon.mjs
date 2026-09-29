// ============================================================================
// Rupeeruchana — sermaye simülasyonu
// "X dolarla N işlem sonunda ne olur?" sorusunun dürüst cevabı: tek bir sayı
// değil, bir DAĞILIM. Sanal cüzdanın gerçek R dizisinden (komisyon ve fonlama
// dahil) bootstrap ile binlerce gidişat üretir.
//
// İki simülasyon çalıştırır ve farkı açıkça gösterir:
//   A) ölçülen edge GERÇEK kabul edilerek     -> iyimser, dar aralık
//   B) edge'in kendisi de belirsiz kabul edilerek -> dürüst, geniş aralık
// Fark önemlidir: 18 işlemde ölçülen bir ortalama, gerçek edge hakkında çok az
// şey söyler. B şıkkındaki genişlik, "henüz bilmiyoruz"un sayısal ifadesidir.
//
// Kullanım:  node scripts/simulasyon.mjs               (100$ · 125 işlem · %2 risk)
//            node scripts/simulasyon.mjs 250 200 0.01  (250$ · 200 işlem · %1 risk)
//
// Hiçbir dosyaya yazmaz, ağa çıkmaz. Yatırım tavsiyesi değildir.
// ============================================================================

import { readFileSync } from 'node:fs';

const [, , bArg, nArg, rArg] = process.argv;
const BASLANGIC = Number(bArg) || 100;
const N = Number(nArg) || 125;
const RISK = Number(rArg) || 0.02;
const TUR = 40000;

const t = JSON.parse(readFileSync(new URL('../data/autotrade.json', import.meta.url), 'utf8'));
const R = (t.closed || []).map(x => (x.riskUsd ? x.pnl / x.riskUsd : null)).filter(x => x != null);
if (R.length < 5) {
  console.log(`Sicilde yalnızca ${R.length} kapalı işlem var — simülasyon anlamsız olur. En az 5 gerekir.`);
  process.exit(0);
}

const ort = R.reduce((a, b) => a + b, 0) / R.length;
const sd = Math.sqrt(R.reduce((a, b) => a + (b - ort) ** 2, 0) / (R.length - 1));
const se = sd / Math.sqrt(R.length);
const merkezli = R.map(r => r - ort);   // şekli aynı, ortalaması sıfır

const f2 = n => n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const normal = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// Bir gidişat: her işlemde bakiye (1 + risk × R) ile çarpılır (bileşik).
function gidisat(edge) {
  let b = BASLANGIC, zirve = BASLANGIC, maxDD = 0;
  for (let i = 0; i < N; i++) {
    b *= 1 + RISK * (edge + merkezli[(Math.random() * merkezli.length) | 0]);
    if (b > zirve) zirve = b;
    maxDD = Math.max(maxDD, (zirve - b) / zirve);
  }
  return { son: b, maxDD };
}

function kosu(edgeUretici) {
  const son = [], dd = [];
  for (let i = 0; i < TUR; i++) { const g = gidisat(edgeUretici()); son.push(g.son); dd.push(g.maxDD); }
  son.sort((a, b) => a - b); dd.sort((a, b) => a - b);
  const y = p => son[Math.floor(p * TUR)];
  return {
    y, dd: p => dd[Math.floor(p * TUR)],
    zararOran: son.filter(x => x < BASLANGIC).length / TUR,
    yariOran: son.filter(x => x < BASLANGIC / 2).length / TUR,
    ikiKatOran: son.filter(x => x > BASLANGIC * 2).length / TUR,
  };
}

console.log(`Sicil: ${R.length} kapalı işlem · işlem başına ${ort.toFixed(3)}R · std sapma ${sd.toFixed(2)}R`);
console.log(`Edge anlamlılığı: t = ${(ort / se).toFixed(2)} ` +
  `-> ${Math.abs(ort / se) > 2 ? 'ANLAMLI' : `ANLAMLI DEĞİL (t=2 için ~${Math.ceil((2 * sd / ort) ** 2)} işlem gerekir)`}`);
console.log(`Simülasyon: ${f2(BASLANGIC)}$ · ${N} işlem · işlem başına %${(RISK * 100).toFixed(1)} risk · ${TUR.toLocaleString('tr-TR')} tur\n`);

const A = kosu(() => ort);                    // edge gerçek
const B = kosu(() => ort + se * normal());    // edge belirsiz

const satir = (ad, k) => {
  console.log(ad);
  console.log(`   en kötü %5 ${f2(k.y(0.05))}$ · alt çeyrek ${f2(k.y(0.25))}$ · ORTANCA ${f2(k.y(0.50))}$ ` +
              `· üst çeyrek ${f2(k.y(0.75))}$ · en iyi %5 ${f2(k.y(0.95))}$`);
  console.log(`   zarar %${(k.zararOran * 100).toFixed(1)} · yarıya inme %${(k.yariOran * 100).toFixed(1)} ` +
              `· ikiye katlama %${(k.ikiKatOran * 100).toFixed(1)} · yol boyu en derin düşüş (ortanca) %${(k.dd(0.5) * 100).toFixed(0)}`);
};
satir('A) Ölçülen edge GERÇEK kabul edilirse:', A);
console.log();
satir('B) Edge belirsizliği dahil (DÜRÜST OLAN):', B);

console.log(`\nB şıkkı neden daha geniş: ölçülen ${ort.toFixed(3)}R'nin standart hatası ${se.toFixed(3)}R,`);
console.log(`yani gerçek edge makul olarak ${(ort - 1.64 * se).toFixed(2)}R ile ${(ort + 1.64 * se).toFixed(2)}R arasında.`);
console.log('Bu aralık sıfırı içeriyorsa, sistemin para kaybettiriyor olma olasılığı hâlâ ciddidir.');
console.log('\nBilgilendirmedir, yatırım tavsiyesi değildir. Geçmiş sicil geleceği garanti etmez.');
