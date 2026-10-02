// ============================================================================
// Rupeeruchana — GERÇEK cüzdan defteri (elle yürütülen işlemler)
// Sanal cüzdanla aynı kurallar, aynı maliyet modeli (executor.mjs), ama para
// gerçek ve emirleri insan giriyor. Amaç kâr değil: 20 gerçek işlemde sanal ile
// gerçek arasındaki farkı (slipaj, kaçırılan sinyal, disiplin) sayıya dökmek.
//
// Plan (2 Eki 2026): kasa 50$, işlem başına risk %2 (1$), izole 2x, aynı anda
// en fazla 3 pozisyon, BTC yok (vadeli minimumu 86$ > kasa), çekirdek + radar
// sinyallerinin HEPSİ geliş sırasıyla (seçmece yok), stop + hedef emri anında,
// 7 gün süre stopu, ekleme ve stop taşıma yok, kasa 35$'a inerse DUR.
//
// Kullanım:
//   node scripts/gercek.mjs oner  GİRİŞ STOP                 -> %2 risk için pozisyon büyüklüğü
//   node scripts/gercek.mjs ac    COIN LONG|SHORT GİRİŞ STOP HEDEF POZİSYON$ [radar|cekirdek] [not]
//   node scripts/gercek.mjs kapat COIN ÇIKIŞ [hedef|stop|sure|elle] [not]
//   node scripts/gercek.mjs atla  COIN LONG|SHORT SEBEP      -> kontenjan dolu / kaçırdım / btc-min
//   node scripts/gercek.mjs durum
// Her komut data/gercek.json'ı günceller; sonra commit + push et (ya da Claude'a söyle).
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tradeCosts, FEE_RATE } from './executor.mjs';

const DOSYA = new URL('../data/gercek.json', import.meta.url);
const RISK_PCT = 0.02, MAX_POS = 3, DUR_BAKIYE = 35, KALDIRAC = 2, SURE_GUN = 7;
const YASAK = { BTC: 'vadeli minimum 0,001 BTC ≈ 86$, 50$ kasaya sığmaz' };

const f2 = n => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 4 : 2 });
const simdi = () => new Date().toISOString();

function yukle() {
  if (!existsSync(DOSYA)) {
    return { note: 'GERÇEK cüzdan — elle yürütülen işlemler, aynı kurallar. Plan: 50$, %2 risk, max 3 pozisyon, BTC yok.',
      startBalance: 50, balance: 50, startedAt: simdi(), open: [], closed: [], skipped: [], stats: null };
  }
  return JSON.parse(readFileSync(DOSYA, 'utf8'));
}
function kaydet(l) { l.stats = ozet(l); l.updated = simdi(); writeFileSync(DOSYA, JSON.stringify(l, null, 2) + '\n'); }

function ozet(l) {
  const c = l.closed;
  const say = k => c.filter(x => x.outcome === k).length;
  const R = c.map(x => x.rResult).filter(x => x != null);
  const grup = (ad, filtre) => { const g = c.filter(filtre); return { n: g.length, hedef: g.filter(x => x.outcome === 'HEDEF ✓').length, R: +g.reduce((a, x) => a + (x.rResult || 0), 0).toFixed(2) }; };
  return {
    trades: c.length, hedef: say('HEDEF ✓'), stop: say('STOP ✗'), sure: say('SÜRE ⏱'), elle: say('ELLE ✋'),
    winRate: c.length ? +((say('HEDEF ✓') / c.length) * 100).toFixed(1) : null,
    pnlSum: +c.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(2),
    rSum: +R.reduce((a, b) => a + b, 0).toFixed(2), rAvg: R.length ? +(R.reduce((a, b) => a + b, 0) / R.length).toFixed(3) : null,
    feeSum: +c.reduce((a, x) => a + (x.feeUsd || 0) + (x.fundingUsd || 0), 0).toFixed(2),
    kaynak: { cekirdek: grup('cekirdek', x => x.kaynak === 'cekirdek'), radar: grup('radar', x => x.kaynak === 'radar') },
    yon: { LONG: grup('LONG', x => x.dir === 'LONG'), SHORT: grup('SHORT', x => x.dir === 'SHORT') },
    skipped: l.skipped.length,
  };
}

function oner(l, giris, stop) {
  const mesafe = Math.abs(giris - stop) / giris;
  const risk = l.balance * RISK_PCT;
  const poz = risk / mesafe;
  console.log(`Bakiye ${f2(l.balance)}$ · risk %${RISK_PCT * 100} = ${f2(risk)}$ · stop mesafesi %${(mesafe * 100).toFixed(2)}`);
  console.log(`-> pozisyon ${f2(poz)}$ (izole ${KALDIRAC}x ile teminat ${f2(poz / KALDIRAC)}$)`);
  if (poz > l.balance * KALDIRAC) console.log('UYARI: pozisyon kasayı aşıyor; stop çok dar ya da kasa çok küçük. Bu sinyali atla.');
  return poz;
}

function ac(l, [coin, dir, giris, stop, hedef, poz, kaynak = 'radar', ...not]) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); dir = String(dir || '').toUpperCase();
  giris = +giris; stop = +stop; hedef = +hedef; poz = poz != null ? +poz : null;
  if (!coin || !['LONG', 'SHORT'].includes(dir) || !giris || !stop || !hedef) throw new Error('kullanım: ac COIN LONG|SHORT GİRİŞ STOP HEDEF POZİSYON$ [radar|cekirdek] [not]');
  if (YASAK[coin]) throw new Error(`${coin} yasak: ${YASAK[coin]}`);
  if (!['radar', 'cekirdek'].includes(kaynak)) throw new Error('kaynak radar ya da cekirdek olmalı');
  if (l.open.some(o => o.coin === coin)) throw new Error(`${coin} zaten açık (ekleme yok, kural)`);
  if (l.open.length >= MAX_POS) throw new Error(`kontenjan dolu (${MAX_POS}). Bunu "atla ${coin} ${dir} kontenjan-dolu" ile kaydet.`);
  if (l.balance <= DUR_BAKIYE) throw new Error(`DUR kuralı: bakiye ${f2(l.balance)}$ ≤ ${DUR_BAKIYE}$. Yeni işlem yok, önce inceleme.`);
  if (dir === 'LONG' ? !(stop < giris && hedef > giris) : !(stop > giris && hedef < giris)) throw new Error('stop/hedef yön ile tutarsız');
  const mesafe = Math.abs(giris - stop) / giris;
  if (poz == null) poz = oner(l, giris, stop);
  const riskUsd = poz * mesafe, riskPct = riskUsd / l.balance;
  if (riskPct > RISK_PCT * 1.3) console.log(`UYARI: risk %${(riskPct * 100).toFixed(2)}, kural %${RISK_PCT * 100}. Borsa minimumundan geliyorsa not düş.`);
  const kayit = {
    coin, dir, kaynak, ts: simdi(), entry: giris, stop, target: hedef, notional: +poz.toFixed(2), qty: +(poz / giris).toFixed(6),
    leverage: KALDIRAC, marginUsd: +(poz / KALDIRAC).toFixed(2), riskUsd: +riskUsd.toFixed(2), riskPct: +(riskPct * 100).toFixed(2),
    stopPct: +(mesafe * 100).toFixed(2), rr: +(Math.abs(hedef - giris) / Math.abs(giris - stop)).toFixed(2),
    deadline: new Date(Date.now() + SURE_GUN * 864e5).toISOString(), note: not.join(' ') || null,
  };
  l.open.push(kayit); kaydet(l);
  console.log(`AÇILDI ${coin} ${dir} (${kaynak}) · giriş ${px(giris)} · stop ${px(stop)} (−%${kayit.stopPct}) · hedef ${px(hedef)} (${kayit.rr}R)`);
  console.log(`pozisyon ${f2(poz)}$ · teminat ${f2(kayit.marginUsd)}$ @${KALDIRAC}x · riske edilen ${f2(riskUsd)}$ (%${kayit.riskPct}) · süre stopu ${kayit.deadline.slice(0, 10)}`);
  console.log('ŞİMDİ: borsada stop-market + take-profit limit emirlerini gir. Sonra ekrana bakma.');
}

function kapat(l, [coin, cikis, sebep, ...not]) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); cikis = +cikis;
  const i = l.open.findIndex(o => o.coin === coin);
  if (i < 0) throw new Error(`${coin} açık değil`);
  if (!cikis) throw new Error('kullanım: kapat COIN ÇIKIŞ [hedef|stop|sure|elle] [not]');
  const o = l.open[i], yon = o.dir === 'LONG' ? 1 : -1;
  const pnlGross = (cikis - o.entry) * o.qty * yon;
  const m = tradeCosts({ notional: o.notional, openMs: Date.parse(o.ts), closeMs: Date.now() });
  const pnl = pnlGross - m.costUsd;
  const outcome = { hedef: 'HEDEF ✓', stop: 'STOP ✗', sure: 'SÜRE ⏱', elle: 'ELLE ✋' }[sebep] ||
    (yon * (cikis - o.target) >= 0 ? 'HEDEF ✓' : yon * (cikis - o.stop) <= 0 ? 'STOP ✗' : 'ELLE ✋');
  const kayit = { ...o, exit: cikis, closedTs: simdi(), outcome, pnlGross: +pnlGross.toFixed(2), feeUsd: m.feeUsd, fundingUsd: m.fundingUsd,
    pnl: +pnl.toFixed(2), rResult: +(pnl / o.riskUsd).toFixed(2), bars: Math.round((Date.now() - Date.parse(o.ts)) / 36e5), closeNote: not.join(' ') || null };
  l.open.splice(i, 1); l.closed.unshift(kayit); l.balance = +(l.balance + pnl).toFixed(2); kaydet(l);
  console.log(`KAPANDI ${coin} ${o.dir} → ${outcome} · çıkış ${px(cikis)} · brüt ${f2(pnlGross)}$ − maliyet ${f2(m.costUsd)}$ = net ${f2(pnl)}$ (${kayit.rResult}R)`);
  console.log(`bakiye ${f2(l.balance)}$ · sicil ${l.stats.hedef}✓/${l.stats.trades} · toplam ${f2(l.stats.pnlSum)}$`);
  if (outcome === 'ELLE ✋') console.log('NOT: elle kapanış kural dışı sayılır; sebebini yazdıysan iyi, yazmadıysan şimdi ekle.');
  if (l.balance <= DUR_BAKIYE) console.log(`!!! DUR KURALI: bakiye ${f2(l.balance)}$. Yeni işlem açma, önce inceleme.`);
}

function atla(l, [coin, dir, ...sebep]) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); dir = String(dir || '').toUpperCase();
  if (!coin || !sebep.length) throw new Error('kullanım: atla COIN LONG|SHORT SEBEP');
  l.skipped.unshift({ coin, dir, ts: simdi(), reason: sebep.join(' ') }); kaydet(l);
  console.log(`ATLANDI ${coin} ${dir}: ${sebep.join(' ')} (toplam atlanan ${l.skipped.length})`);
}

function durum(l) {
  const s = ozet(l);
  console.log(`GERÇEK CÜZDAN · başlangıç ${f2(l.startBalance)}$ (${(l.startedAt || '').slice(0, 10)}) · bakiye ${f2(l.balance)}$ · toplam ${f2(s.pnlSum)}$ · maliyet ${f2(s.feeSum)}$`);
  console.log(`sicil ${s.hedef}✓ ${s.stop}✗ ${s.sure}⏱ ${s.elle}✋ / ${s.trades} · isabet ${s.winRate ?? '-'}% · toplam ${s.rSum}R · işlem başına ${s.rAvg ?? '-'}R · atlanan ${s.skipped}`);
  console.log(`kaynak: çekirdek ${s.kaynak.cekirdek.hedef}/${s.kaynak.cekirdek.n} (${s.kaynak.cekirdek.R}R) · radar ${s.kaynak.radar.hedef}/${s.kaynak.radar.n} (${s.kaynak.radar.R}R) · yön: LONG ${s.yon.LONG.hedef}/${s.yon.LONG.n} · SHORT ${s.yon.SHORT.hedef}/${s.yon.SHORT.n}`);
  console.log(`açık ${l.open.length}/${MAX_POS}:` + (l.open.length ? '' : ' yok'));
  l.open.forEach(o => console.log(`  ${o.coin} ${o.dir} (${o.kaynak}) giriş ${px(o.entry)} stop ${px(o.stop)} hedef ${px(o.target)} · ${f2(o.notional)}$ · risk ${f2(o.riskUsd)}$ · süre ${o.deadline.slice(0, 10)}`));
  if (l.closed.length) { console.log('son kapananlar:'); l.closed.slice(0, 5).forEach(c => console.log(`  ${c.closedTs.slice(0, 10)} ${c.coin} ${c.dir} ${c.outcome} ${f2(c.pnl)}$ (${c.rResult}R)`)); }
  console.log(`20 işlem hedefine kalan: ${Math.max(0, 20 - s.trades)}`);
}

const [, , komut, ...arg] = process.argv;
const l = yukle();
try {
  if (komut === 'oner') oner(l, +arg[0], +arg[1]);
  else if (komut === 'ac') ac(l, arg);
  else if (komut === 'kapat') kapat(l, arg);
  else if (komut === 'atla') atla(l, arg);
  else if (komut === 'durum' || !komut) durum(l);
  else throw new Error('komutlar: oner | ac | kapat | atla | durum');
} catch (e) { console.error('HATA:', e.message); process.exit(1); }
