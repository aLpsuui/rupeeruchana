// ============================================================================
// Rupeeruchana — GERÇEK cüzdan defteri
// Tek cüzdan var, gerçek: 50$. Bu dosya defterin kurallarını ve kayıt işlemlerini
// tutar; iki yerden kullanılır:
//   1) komut satırı (insan):  node scripts/gercek.mjs ac|kapat|atla|oner|durum
//   2) scripts/live-executor.mjs (VPS'teki otomatik yürütücü) — aynı fonksiyonlar.
// Maliyet modeli executor.tradeCosts ile aynı; borsadan gerçek komisyon gelirse o yazılır.
//
// Plan (2 Eki 2026): kasa 50$, işlem başına risk %2 (1$), izole 2x, aynı anda en
// fazla 3 pozisyon, BTC yok (vadeli minimumu 86$ > kasa), çekirdek + radar sinyallerinin
// HEPSİ geliş sırasıyla (seçmece yok), stop + hedef emri anında, 7 gün süre stopu,
// ekleme ve stop taşıma yok, kasa 35$'a inerse DUR.
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tradeCosts } from './executor.mjs';

// Kuru moddaki yürütücü (RUPEE_MODE=dry) AYRI deftere yazar: 20 işlemlik gerçek
// sicil prova kayıtlarıyla kirlenmesin. Komut satırı (insan) RUPEE_MODE görmez,
// hep gerçek deftere yazar. gercek-kuru.json git'e girmez (.gitignore).
const DOSYA = new URL(process.env.RUPEE_MODE === 'dry' ? '../data/gercek-kuru.json' : '../data/gercek.json', import.meta.url);
export const KURAL = { RISK_PCT: 0.02, MAX_POS: 3, DUR_BAKIYE: 35, KALDIRAC: 2, SURE_GUN: 7, HEDEF_ISLEM: 20,
  YASAK: { BTC: 'vadeli minimum 0,001 BTC ≈ 86$, 50$ kasaya sığmaz' } };

const f2 = n => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 4 : 2 });
const simdi = () => new Date().toISOString();

export function yukle() {
  if (!existsSync(DOSYA)) {
    return { note: 'GERÇEK cüzdan — elle ya da VPS yürütücüsüyle açılan işlemler, aynı kurallar.',
      startBalance: 50, balance: 50, startedAt: simdi(), open: [], closed: [], skipped: [], stats: null };
  }
  return JSON.parse(readFileSync(DOSYA, 'utf8'));
}
export function kaydet(l) { l.stats = ozet(l); l.updated = simdi(); writeFileSync(DOSYA, JSON.stringify(l, null, 2) + '\n'); return l; }

export function ozet(l) {
  const c = l.closed || [];
  const say = k => c.filter(x => x.outcome === k).length;
  const R = c.map(x => x.rResult).filter(x => x != null);
  const grup = filtre => { const g = c.filter(filtre); return { n: g.length, hedef: g.filter(x => x.outcome === 'HEDEF ✓').length, R: +g.reduce((a, x) => a + (x.rResult || 0), 0).toFixed(2) }; };
  return {
    trades: c.length, hedef: say('HEDEF ✓'), stop: say('STOP ✗'), sure: say('SÜRE ⏱'), elle: say('ELLE ✋'),
    winRate: c.length ? +((say('HEDEF ✓') / c.length) * 100).toFixed(1) : null,
    pnlSum: +c.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(2),
    rSum: +R.reduce((a, b) => a + b, 0).toFixed(2), rAvg: R.length ? +(R.reduce((a, b) => a + b, 0) / R.length).toFixed(3) : null,
    feeSum: +c.reduce((a, x) => a + (x.feeUsd || 0) + (x.fundingUsd || 0), 0).toFixed(2),
    kaynak: { cekirdek: grup(x => x.kaynak === 'cekirdek'), radar: grup(x => x.kaynak === 'radar') },
    yon: { LONG: grup(x => x.dir === 'LONG'), SHORT: grup(x => x.dir === 'SHORT') },
    skipped: (l.skipped || []).length,
  };
}

// %2 risk için pozisyon büyüklüğü
export function pozisyonOner(l, giris, stop) {
  const mesafe = Math.abs(giris - stop) / giris;
  const risk = l.balance * KURAL.RISK_PCT;
  const poz = risk / mesafe;
  return { mesafe, risk, poz, teminat: poz / KURAL.KALDIRAC, sigar: poz <= l.balance * KURAL.KALDIRAC };
}

// Açılış kaydı. Kuralları burada zorlar; borsa emri BU fonksiyondan ÖNCE/SONRA ayrı atılır.
export function acKayit(l, { coin, dir, giris, stop, hedef, poz, kaynak = 'radar', not = null, ekstra = {} }) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); dir = String(dir || '').toUpperCase();
  giris = +giris; stop = +stop; hedef = +hedef;
  if (!coin || !['LONG', 'SHORT'].includes(dir) || !giris || !stop || !hedef) throw new Error('eksik alan: coin, dir, giriş, stop, hedef');
  if (KURAL.YASAK[coin]) throw new Error(`${coin} yasak: ${KURAL.YASAK[coin]}`);
  if (!['radar', 'cekirdek'].includes(kaynak)) throw new Error('kaynak radar ya da cekirdek olmalı');
  if (l.open.some(o => o.coin === coin)) throw new Error(`${coin} zaten açık (ekleme yok, kural)`);
  if (l.open.length >= KURAL.MAX_POS) throw new Error(`kontenjan dolu (${KURAL.MAX_POS})`);
  if (l.balance <= KURAL.DUR_BAKIYE) throw new Error(`DUR kuralı: bakiye ${f2(l.balance)}$ ≤ ${KURAL.DUR_BAKIYE}$`);
  if (dir === 'LONG' ? !(stop < giris && hedef > giris) : !(stop > giris && hedef < giris)) throw new Error('stop/hedef yön ile tutarsız');
  const mesafe = Math.abs(giris - stop) / giris;
  if (poz == null) poz = pozisyonOner(l, giris, stop).poz;
  poz = +poz;
  const riskUsd = poz * mesafe, riskPct = riskUsd / l.balance;
  const kayit = {
    coin, dir, kaynak, ts: simdi(), entry: giris, stop, target: hedef, notional: +poz.toFixed(2), qty: +(poz / giris).toFixed(6),
    leverage: KURAL.KALDIRAC, marginUsd: +(poz / KURAL.KALDIRAC).toFixed(2), riskUsd: +riskUsd.toFixed(2), riskPct: +(riskPct * 100).toFixed(2),
    stopPct: +(mesafe * 100).toFixed(2), rr: +(Math.abs(hedef - giris) / Math.abs(giris - stop)).toFixed(2),
    deadline: new Date(Date.now() + KURAL.SURE_GUN * 864e5).toISOString(), note: not, ...ekstra,
  };
  l.open.push(kayit); kaydet(l);
  return kayit;
}

// Kapanış kaydı. maliyet verilirse (borsadan gerçek komisyon) model yerine o kullanılır.
export function kapatKayit(l, { coin, cikis, sebep = null, not = null, maliyet = null, ekstra = {} }) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); cikis = +cikis;
  const i = l.open.findIndex(o => o.coin === coin);
  if (i < 0) throw new Error(`${coin} açık değil`);
  if (!cikis) throw new Error('çıkış fiyatı gerekli');
  const o = l.open[i], yon = o.dir === 'LONG' ? 1 : -1;
  const pnlGross = (cikis - o.entry) * o.qty * yon;
  const m = maliyet || tradeCosts({ notional: o.notional, openMs: Date.parse(o.ts), closeMs: Date.now() });
  const feeUsd = +(m.feeUsd ?? 0), fundingUsd = +(m.fundingUsd ?? 0);
  const pnl = pnlGross - feeUsd - fundingUsd;
  const outcome = { hedef: 'HEDEF ✓', stop: 'STOP ✗', sure: 'SÜRE ⏱', elle: 'ELLE ✋' }[sebep] ||
    (yon * (cikis - o.target) >= 0 ? 'HEDEF ✓' : yon * (cikis - o.stop) <= 0 ? 'STOP ✗' : 'ELLE ✋');
  const kayit = { ...o, exit: cikis, closedTs: simdi(), outcome, pnlGross: +pnlGross.toFixed(2), feeUsd: +feeUsd.toFixed(2), fundingUsd: +fundingUsd.toFixed(2),
    pnl: +pnl.toFixed(2), rResult: +(pnl / o.riskUsd).toFixed(2), bars: Math.round((Date.now() - Date.parse(o.ts)) / 36e5), closeNote: not, ...ekstra };
  l.open.splice(i, 1); l.closed.unshift(kayit); l.balance = +(l.balance + pnl).toFixed(2); kaydet(l);
  return kayit;
}

export function atlaKayit(l, { coin, dir, sebep }) {
  coin = String(coin || '').toUpperCase().replace('USDT', ''); dir = String(dir || '').toUpperCase();
  if (!coin || !sebep) throw new Error('coin ve sebep gerekli');
  const k = { coin, dir, ts: simdi(), reason: sebep };
  l.skipped.unshift(k); kaydet(l);
  return k;
}

export function durumMetni(l) {
  const s = ozet(l), sat = [];
  sat.push(`GERÇEK CÜZDAN · başlangıç ${f2(l.startBalance)}$ (${(l.startedAt || '').slice(0, 10)}) · bakiye ${f2(l.balance)}$ · toplam ${f2(s.pnlSum)}$ · maliyet ${f2(s.feeSum)}$`);
  sat.push(`sicil ${s.hedef}✓ ${s.stop}✗ ${s.sure}⏱ ${s.elle}✋ / ${s.trades} · isabet ${s.winRate ?? '-'}% · toplam ${s.rSum}R · işlem başına ${s.rAvg ?? '-'}R · atlanan ${s.skipped}`);
  sat.push(`kaynak: çekirdek ${s.kaynak.cekirdek.hedef}/${s.kaynak.cekirdek.n} (${s.kaynak.cekirdek.R}R) · radar ${s.kaynak.radar.hedef}/${s.kaynak.radar.n} (${s.kaynak.radar.R}R) · yön: LONG ${s.yon.LONG.hedef}/${s.yon.LONG.n} · SHORT ${s.yon.SHORT.hedef}/${s.yon.SHORT.n}`);
  sat.push(`açık ${l.open.length}/${KURAL.MAX_POS}:` + (l.open.length ? '' : ' yok'));
  l.open.forEach(o => sat.push(`  ${o.coin} ${o.dir} (${o.kaynak}) giriş ${px(o.entry)} stop ${px(o.stop)} hedef ${px(o.target)} · ${f2(o.notional)}$ · risk ${f2(o.riskUsd)}$ · süre ${o.deadline.slice(0, 10)}${o.mode ? ' · ' + o.mode : ''}`));
  if (l.closed.length) { sat.push('son kapananlar:'); l.closed.slice(0, 5).forEach(c => sat.push(`  ${c.closedTs.slice(0, 10)} ${c.coin} ${c.dir} ${c.outcome} ${f2(c.pnl)}$ (${c.rResult}R)`)); }
  sat.push(`${KURAL.HEDEF_ISLEM} işlem hedefine kalan: ${Math.max(0, KURAL.HEDEF_ISLEM - s.trades)}`);
  return sat.join('\n');
}

// ---------------------------- komut satırı -----------------------------------
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url), entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
})();

if (isMain) {
  const [, , komut, ...a] = process.argv;
  const l = yukle();
  try {
    if (komut === 'oner') {
      const o = pozisyonOner(l, +a[0], +a[1]);
      console.log(`Bakiye ${f2(l.balance)}$ · risk %${KURAL.RISK_PCT * 100} = ${f2(o.risk)}$ · stop mesafesi %${(o.mesafe * 100).toFixed(2)}`);
      console.log(`-> pozisyon ${f2(o.poz)}$ (izole ${KURAL.KALDIRAC}x ile teminat ${f2(o.teminat)}$)${o.sigar ? '' : '  UYARI: kasaya sığmıyor, atla'}`);
    } else if (komut === 'ac') {
      const [coin, dir, giris, stop, hedef, poz, kaynak, ...not] = a;
      const k = acKayit(l, { coin, dir, giris, stop, hedef, poz: poz != null ? +poz : null, kaynak: kaynak || 'radar', not: not.join(' ') || null, ekstra: { mode: 'elle' } });
      if (k.riskPct > KURAL.RISK_PCT * 130) console.log(`UYARI: risk %${k.riskPct}, kural %${KURAL.RISK_PCT * 100}. Borsa minimumundan geliyorsa not düş.`);
      console.log(`AÇILDI ${k.coin} ${k.dir} (${k.kaynak}) · giriş ${px(k.entry)} · stop ${px(k.stop)} (−%${k.stopPct}) · hedef ${px(k.target)} (${k.rr}R)`);
      console.log(`pozisyon ${f2(k.notional)}$ · teminat ${f2(k.marginUsd)}$ @${k.leverage}x · riske edilen ${f2(k.riskUsd)}$ (%${k.riskPct}) · süre stopu ${k.deadline.slice(0, 10)}`);
      console.log('ŞİMDİ: borsada stop-market + take-profit emirlerini gir. Sonra ekrana bakma.');
    } else if (komut === 'kapat') {
      const [coin, cikis, sebep, ...not] = a;
      const k = kapatKayit(l, { coin, cikis, sebep, not: not.join(' ') || null });
      console.log(`KAPANDI ${k.coin} ${k.dir} → ${k.outcome} · çıkış ${px(k.exit)} · brüt ${f2(k.pnlGross)}$ − maliyet ${f2(k.feeUsd + k.fundingUsd)}$ = net ${f2(k.pnl)}$ (${k.rResult}R)`);
      console.log(`bakiye ${f2(l.balance)}$ · sicil ${l.stats.hedef}✓/${l.stats.trades} · toplam ${f2(l.stats.pnlSum)}$`);
      if (k.outcome === 'ELLE ✋') console.log('NOT: elle kapanış kural dışı sayılır; sebebini yazdıysan iyi.');
      if (l.balance <= KURAL.DUR_BAKIYE) console.log(`!!! DUR KURALI: bakiye ${f2(l.balance)}$. Yeni işlem yok, önce inceleme.`);
    } else if (komut === 'atla') {
      const [coin, dir, ...sebep] = a;
      const k = atlaKayit(l, { coin, dir, sebep: sebep.join(' ') });
      console.log(`ATLANDI ${k.coin} ${k.dir}: ${k.reason} (toplam atlanan ${l.skipped.length})`);
    } else if (komut === 'durum' || !komut) {
      console.log(durumMetni(l));
    } else throw new Error('komutlar: oner | ac | kapat | atla | durum');
  } catch (e) { console.error('HATA:', e.message); process.exit(1); }
}
