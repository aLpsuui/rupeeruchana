// ============================================================================
// Rupeeruchana — CANLI YÜRÜTÜCÜ (VPS'te tek süreç olarak çalışır)
//
// Ne yapar:
//   1) Her 4 saatlik mum kapanışında (00/04/08/12/16/20 UTC + 1 dk) motoru
//      (scripts/update.mjs) çalıştırır, data/'yı GitHub'a push eder (site oradan
//      yayınlanır), yeni SİNYAL'leri Binance vadeli hesabına yansıtır.
//   2) Her dakika: açık işlemlerin dolumunu (stop/hedef) borsadan okur, deftere
//      yazar, 7 günlük süre stopunu uygular, canlı panoyu üretir
//      (data/canli.json + küçük HTTP ucu), Telegram'a yalnızca DEĞİŞİM olunca yazar.
//
// "Sinyal 4 saatte bir, izleme sürekli": kural kapalı 4s mum üstüne tanımlı,
// mum kapanmadan sinyal yoktur. Pano "şimdi kapansa ne olurdu"yu gösterir, bu
// bir sinyal değil, ısınma göstergesidir.
//
// Modlar (RUPEE_MODE): dry (emir yok, rapor), testnet (sahte para, gerçek emir
// akışı), live. Durdurma anahtarı: repo kökünde DUR adlı dosya → yeni giriş yok.
// Kurallar scripts/gercek.mjs içindeki KURAL'dan gelir, burada kopyası yok.
//
// Çalıştırma:  node --env-file=.env scripts/live-executor.mjs          (daemon)
//              node --env-file=.env scripts/live-executor.mjs --once   (tek tik, test)
//              node --env-file=.env scripts/live-executor.mjs --tur    (motoru şimdi çalıştır)
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { istemci } from './binance.mjs';
import { notify } from './notify.mjs';
import { analyzeCoin, COINS, ALTS } from './update.mjs';
import * as defter from './gercek.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.env.RUPEE_MODE || 'dry';
const PUSH = process.env.RUPEE_PUSH === '1';
const PORT = +(process.env.CANLI_PORT || 8787);
const ONCE = process.argv.includes('--once');
const TUR_SIMDI = process.argv.includes('--tur');
const DUR_DOSYASI = resolve(ROOT, 'DUR');
const STATE = resolve(ROOT, 'data/state.json');
const CANLI = resolve(ROOT, 'data/canli.json');
const KURAL = defter.KURAL;

const bx = istemci({ mode: MODE, key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const f2 = n => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const px = n => Number(n).toLocaleString('tr-TR', { maximumFractionDigits: n < 1 ? 5 : n < 100 ? 4 : 2 });
const uyku = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------- bellek --------------------------------------------
let sonTurMum = null;              // en son motor çalıştırılan 4s mumun açılış zamanı
let gunluk = {};                   // coin -> {times, closes...} günlük mumlar (4 saatte bir tazelenir)
let gunlukZaman = 0;
let oncekiIsinma = {};             // coin -> 'KURULUM LONG' vb. (değişim tespiti)
let uyarildi = {};                 // `${coin}:${mumAcilis}` -> true (mum başına tek uyarı)
let sonHata = {};                  // hata mesajı -> zaman (spam önleme)

// ---------------------------- yardımcılar ----------------------------------------
async function tg(baslik, govde, tag) {
  try { await notify(baslik, govde, tag); } catch (e) { log('telegram hatası', e.message); }
}
async function hataBildir(baslik, e) {
  const k = baslik + e.message.slice(0, 60);
  if (Date.now() - (sonHata[k] || 0) < 3600e3) return;   // aynı hata saatte bir
  sonHata[k] = Date.now();
  log('HATA', baslik, e.message);
  await tg(`⚠️ Yürütücü: ${baslik}`, e.message.slice(0, 300), 'warning');
}
function mumAcilis(ms = Date.now()) { return Math.floor(ms / 14400e3) * 14400e3; }  // 4s = 14.400.000 ms
function mumKapanisaDk(ms = Date.now()) { return Math.round((mumAcilis(ms) + 14400e3 - ms) / 60000); }
function stateOku() { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; } }
function durMu() { return existsSync(DUR_DOSYASI); }

// ---------------------------- 1) TUR: motor + push + sinyalleri yansıt ---------
async function tur(sebep) {
  const mum = mumAcilis();
  log(`TUR başlıyor (${sebep}) · mum ${new Date(mum).toISOString()}`);
  try {
    await exec('node', ['scripts/update.mjs'], { cwd: ROOT, env: { ...process.env, RUPEE_NO_NOTIFY: process.env.RUPEE_NO_NOTIFY || '0' }, maxBuffer: 16e6 });
    log('motor bitti');
  } catch (e) { await hataBildir('motor çalışmadı', e); return; }
  sonTurMum = mum;

  if (PUSH) {
    try {
      await exec('git', ['add', 'data'], { cwd: ROOT });
      const { stdout } = await exec('git', ['status', '--porcelain', 'data'], { cwd: ROOT });
      if (stdout.trim()) {
        await exec('git', ['-c', 'user.name=rupeeruchana-vps', '-c', 'user.email=vps@rupeeruchana.local', 'commit', '-q', '-m', `ajan (vps): 4 saatlik analiz ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`], { cwd: ROOT });
        await exec('git', ['pull', '--rebase', '-q', 'origin', 'main'], { cwd: ROOT });
        await exec('git', ['push', '-q', 'origin', 'main'], { cwd: ROOT });
        log('data push edildi');
      }
    } catch (e) { await hataBildir('git push', e); }
  }
  await sinyalleriYansit();
}

// Motorun yeni açtığı AKTİF sinyalleri (çekirdek + radar) deftere ve borsaya yansıt.
async function sinyalleriYansit() {
  const st = stateOku(); if (!st) return;
  const l = defter.yukle();
  const adaylar = [
    ...(st.signals || []).filter(s => s.state === 'AKTİF').map(s => ({ ...s, kaynak: 'cekirdek' })),
    ...(st.altSignals || []).filter(s => s.state === 'AKTİF').map(s => ({ ...s, kaynak: 'radar' })),
  ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));   // geliş sırası, seçmece yok

  for (const s of adaylar) {
    const coin = s.coin;
    // Yalnızca bu turda doğan sinyaller: eskiye (plan öncesi) girilmez.
    if (Date.parse(s.ts) < Date.parse(l.startedAt || 0)) continue;
    if (l.open.some(o => o.coin === coin)) continue;
    if (l.closed.some(c => c.coin === coin && c.sinyalTs === s.ts)) continue;
    if (l.skipped.some(k => k.coin === coin && k.sinyalTs === s.ts)) continue;

    const giris = s.entryN ?? +String(s.entry).replace(/\./g, '').replace(',', '.');
    const stop = s.stopN ?? +String(s.stop).replace(/\./g, '').replace(',', '.');
    const hedef = s.targetN ?? +String(s.target).replace(/\./g, '').replace(',', '.');
    let sebep = null;
    if (KURAL.YASAK[coin]) sebep = KURAL.YASAK[coin];
    else if (l.open.length >= KURAL.MAX_POS) sebep = 'kontenjan dolu';
    else if (l.balance <= KURAL.DUR_BAKIYE) sebep = `DUR kuralı (bakiye ${f2(l.balance)}$)`;
    else if (durMu()) sebep = 'DUR dosyası var (elle durduruldu)';
    if (sebep) {
      defter.atlaKayit(l, { coin, dir: s.dir, sebep }); l.skipped[0].sinyalTs = s.ts; defter.kaydet(l);
      await tg(`⏭ Atlandı: ${coin} ${s.dir}`, `${sebep} · giriş ${px(giris)} · stop ${px(stop)} · hedef ${px(hedef)}`, 'fast_forward');
      continue;
    }

    // Gerçek giriş fiyatı: sinyal kapanış fiyatından, biz piyasa emriyle giriyoruz.
    // Fiyat sinyalden %1'den fazla uzaklaştıysa o sinyal bizim değil (plan kuralı).
    let fiyat = giris;
    try { fiyat = await bx.fiyat(coin + 'USDT'); } catch {}
    const sapma = Math.abs(fiyat / giris - 1) * 100;
    if (sapma > 1) {
      defter.atlaKayit(l, { coin, dir: s.dir, sebep: `fiyat sinyalden %${sapma.toFixed(2)} uzaklaştı (${px(giris)} → ${px(fiyat)})` }); l.skipped[0].sinyalTs = s.ts; defter.kaydet(l);
      await tg(`⏭ Atlandı: ${coin} ${s.dir}`, `fiyat kaçtı: sinyal ${px(giris)}, şimdi ${px(fiyat)} (%${sapma.toFixed(2)})`, 'fast_forward');
      continue;
    }

    const o = defter.pozisyonOner(l, fiyat, stop, coin);
    if (!o.sigar) { defter.atlaKayit(l, { coin, dir: s.dir, sebep: 'pozisyon kasaya sığmıyor (stop çok dar)' }); l.skipped[0].sinyalTs = s.ts; defter.kaydet(l); continue; }
    let qty = o.poz / fiyat;
    try {
      const flt = await bx.filtre(coin + 'USDT');
      qty = await bx.miktarYuvarla(coin + 'USDT', qty);
      if (qty < flt.minQty || qty * fiyat < flt.minNotional) {
        // borsa minimumu: en küçük emre çık, riski yeniden hesapla, %2'nin %60 üstüne çıkıyorsa atla
        qty = Math.max(flt.minQty, await bx.miktarYuvarla(coin + 'USDT', (flt.minNotional || 0) / fiyat + flt.stepSize));
        const risk = qty * Math.abs(fiyat - stop);
        // MIN_ISTISNA (BTC): borsa minimumu riski kuralın üstüne çıkarsa da atlanmaz (kullanıcı kararı).
        if (risk > l.balance * KURAL.RISK_PCT * 1.6 && !KURAL.MIN_ISTISNA.includes(coin)) {
          defter.atlaKayit(l, { coin, dir: s.dir, sebep: `borsa minimumu riski ${f2(risk)}$'a çıkarıyor (kural ${f2(l.balance * KURAL.RISK_PCT)}$)` }); l.skipped[0].sinyalTs = s.ts; defter.kaydet(l);
          await tg(`⏭ Atlandı: ${coin} ${s.dir}`, `borsa minimum emir büyüklüğü riski ${f2(risk)}$'a çıkarıyor`, 'fast_forward');
          continue;
        }
      }
    } catch (e) { await hataBildir(`${coin} filtre`, e); continue; }

    try {
      const sonuc = await bx.pozisyonAc({ symbol: coin + 'USDT', dir: s.dir, qty, stop, target: hedef, kaldirac: defter.kaldiracOf(coin) });
      const gerçekGiris = sonuc.entry.avgPrice || fiyat;
      const k = defter.acKayit(l, { coin, dir: s.dir, giris: gerçekGiris, stop, hedef, poz: sonuc.entry.qty * gerçekGiris, kaynak: s.kaynak,
        not: `sinyal ${px(giris)}, giriş ${px(gerçekGiris)}`, ekstra: { mode: MODE, sinyalTs: s.ts, orders: { entry: sonuc.entry.orderId, stop: sonuc.stop.orderId, target: sonuc.target.orderId } } });
      const etiket = MODE === 'dry' ? '🧪 KURU: açardım' : MODE === 'testnet' ? '🧪 TESTNET açıldı' : '💵 GERÇEK açıldı';
      await tg(`${etiket}: ${coin} ${s.dir} (${s.kaynak})`,
        `giriş ${px(k.entry)} · stop ${px(k.stop)} (−%${k.stopPct}) · hedef ${px(k.target)} (${k.rr}R)\npozisyon ${f2(k.notional)}$ · teminat ${f2(k.marginUsd)}$ @${k.leverage}x · risk ${f2(k.riskUsd)}$ (%${k.riskPct})\naçık ${l.open.length}/${KURAL.MAX_POS} · bakiye ${f2(l.balance)}$`,
        s.dir === 'LONG' ? 'green_circle' : 'red_circle');
      log('AÇILDI', coin, s.dir, MODE);
    } catch (e) { await hataBildir(`${coin} emir`, e); }
  }
}

// ---------------------------- 2) İZLE: dolumlar, süre stopu, pano ----------------
async function dolumlariIsle() {
  const l = defter.yukle();
  if (!l.open.length) return;
  let pozlar = null;
  if (MODE !== 'dry') { try { pozlar = await bx.pozisyonlar(); } catch (e) { await hataBildir('pozisyon sorgusu', e); return; } }

  for (const o of [...l.open]) {
    if (o.mode === 'elle') continue;   // insanın elle açtığı işlem: emirleri yürütücüde değil, takibi de insanda
    const symbol = o.coin + 'USDT';
    let fiyat = null; try { fiyat = await bx.fiyat(symbol); } catch {}
    const yon = o.dir === 'LONG' ? 1 : -1;
    const sureDoldu = Date.now() > Date.parse(o.deadline);

    if (MODE === 'dry') {
      // kuru modda dolumu fiyattan taklit et (sadece rapor amaçlı)
      if (fiyat == null) continue;
      let sebep = null;
      if (o.target != null && yon * (fiyat - o.target) >= 0) sebep = 'hedef'; else if (yon * (fiyat - o.stop) <= 0) sebep = 'stop'; else if (sureDoldu) sebep = 'sure';
      if (!sebep) continue;
      const k = defter.kapatKayit(l, { coin: o.coin, cikis: sebep === 'hedef' ? o.target : sebep === 'stop' ? o.stop : fiyat, sebep, ekstra: { mode: 'dry' } });
      await tg(`🧪 KURU kapandı: ${o.coin} ${o.dir} → ${k.outcome}`, `net ${f2(k.pnl)}$ (${k.rResult}R) · bakiye ${f2(l.balance)}$ · sicil ${l.stats.hedef}✓/${l.stats.trades}`, k.outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign');
      continue;
    }

    const acikPoz = pozlar.find(p => p.symbol === symbol);
    if (acikPoz && !sureDoldu) continue;              // hâlâ açık, süre dolmadı

    if (acikPoz && sureDoldu) {
      try { await bx.pozisyonKapat(symbol, o.dir, Math.abs(acikPoz.miktar)); log('süre stopu, kapatıldı', symbol); await uyku(1500); }
      catch (e) { await hataBildir(`${o.coin} süre stopu`, e); continue; }
    } else {
      try { await bx.iptalHepsi(symbol); } catch {}   // dolan emrin eşini temizle
    }

    // kapanış ayrıntısı borsadan
    let g = null; try { g = await bx.gerceklesen(symbol, Date.parse(o.ts)); } catch (e) { await hataBildir(`${o.coin} userTrades`, e); }
    const cikis = g?.cikis || fiyat || o.entry;
    let sebep = sureDoldu ? 'sure' : null;
    if (!sebep) {
      try {
        const [s1, t1] = await Promise.all([o.orders?.stop ? bx.emirDurum(symbol, o.orders.stop) : null, o.orders?.target ? bx.emirDurum(symbol, o.orders.target) : null]);
        if (t1?.status === 'FILLED') sebep = 'hedef'; else if (s1?.status === 'FILLED') sebep = 'stop';
      } catch {}
    }
    const maliyet = g ? { feeUsd: g.komisyon, fundingUsd: 0 } : null;   // fonlama realizedPnl içinde değil; Binance ayrı yazar, burada 0 kabul
    const k = defter.kapatKayit(l, { coin: o.coin, cikis, sebep, maliyet, ekstra: { mode: MODE, borsaPnl: g?.realizedPnl ?? null } });
    const etiket = MODE === 'testnet' ? '🧪 TESTNET kapandı' : '💵 GERÇEK kapandı';
    await tg(`${etiket}: ${o.coin} ${o.dir} → ${k.outcome}`,
      `çıkış ${px(k.exit)} · brüt ${f2(k.pnlGross)}$ − komisyon ${f2(k.feeUsd)}$ = net ${f2(k.pnl)}$ (${k.rResult}R)\nbakiye ${f2(l.balance)}$ · sicil ${l.stats.hedef}✓/${l.stats.trades} · toplam ${f2(l.stats.pnlSum)}$` + (l.balance <= KURAL.DUR_BAKIYE ? '\n!!! DUR KURALI: yeni işlem açılmayacak.' : ''),
      k.outcome.includes('HEDEF') ? 'dart' : 'octagonal_sign');
  }
}

// Canlı pano: her coin için "şimdi kapansa ne olurdu" + açık işlemlerin anlık durumu
async function panoUret() {
  const simdi = Date.now();
  if (simdi - gunlukZaman > 4 * 3600e3) {   // günlük mumlar 4 saatte bir
    for (const c of [...COINS, ...ALTS]) { try { gunluk[c] = await bx.klines(c + 'USDT', '1d', 120); } catch {} }
    gunlukZaman = simdi;
  }
  const kalanDk = mumKapanisaDk(simdi), mum = mumAcilis(simdi);
  const coinler = [];
  for (const c of [...COINS, ...ALTS]) {
    try {
      const h = await bx.klines(c + 'USDT', '4h', 260);
      if (!gunluk[c]) continue;
      const kapali = analyzeCoin(c, gunluk[c], h);                                   // resmî durum (kapalı mumlar)
      const uzat = { ...h }; for (const k of ['opens', 'highs', 'lows', 'closes', 'times']) uzat[k] = [...h[k], h[k].at(-1)];
      const simdiKapansa = analyzeCoin(c, gunluk[c], uzat);                           // oluşan mum kapanmış sayılırsa
      const isinma = simdiKapansa.status + (simdiKapansa.dir ? ' ' + simdiKapansa.dir : '');
      coinler.push({ coin: c, kaynak: COINS.includes(c) ? 'cekirdek' : 'radar', fiyat: h.closes.at(-1), durum: kapali.status, dir: kapali.dir || null,
        simdiKapansa: simdiKapansa.status, simdiDir: simdiKapansa.dir || null, rsi: simdiKapansa.rsiNow ?? null, uzaklikEma21: simdiKapansa.ema21 ? +((h.closes.at(-1) / simdiKapansa.ema21 - 1) * 100).toFixed(2) : null });
      // Telegram: yalnızca "kapansa SİNYAL olur" hâline GEÇİŞTE ve kapanışa ≤ 30 dk kala, mum başına bir kez
      const anahtar = `${c}:${mum}`;
      if (simdiKapansa.status === 'SİNYAL' && kalanDk <= 30 && !uyarildi[anahtar] && !KURAL.YASAK[c]) {
        uyarildi[anahtar] = true;
        await tg(`👀 Tetik yakın: ${c} ${simdiKapansa.dir}`, `Mum şimdi kapansa ${simdiKapansa.dir} sinyali olur · kapanışa ${kalanDk} dk · fiyat ${px(h.closes.at(-1))}. Sinyal ancak kapanışta kesinleşir, emir o zaman girilir.`, 'eyes');
      }
      oncekiIsinma[c] = isinma;
    } catch (e) { /* tek coin düşerse pano devam eder */ }
  }
  const l = defter.yukle();
  const acik = [];
  for (const o of l.open) {
    let fiyat = null; try { fiyat = await bx.fiyat(o.coin + 'USDT'); } catch {}
    const yon = o.dir === 'LONG' ? 1 : -1;
    acik.push({ ...o, fiyat, pnl: fiyat ? +(((fiyat - o.entry) * o.qty * yon)).toFixed(2) : null, r: fiyat ? +(((fiyat - o.entry) * o.qty * yon) / o.riskUsd).toFixed(2) : null,
      stopaMesafe: fiyat ? +((o.stop / fiyat - 1) * 100).toFixed(2) : null, hedefeMesafe: fiyat && o.target != null ? +((o.target / fiyat - 1) * 100).toFixed(2) : null,
      kalanSaat: Math.max(0, Math.round((Date.parse(o.deadline) - simdi) / 36e5)) });
  }
  let borsa = null;
  if (MODE !== 'dry') { try { borsa = await bx.bakiye(); } catch {} }
  const pano = { updated: new Date(simdi).toISOString(), mode: MODE, dur: durMu(), mumKapanisaDk: kalanDk, sonTur: sonTurMum ? new Date(sonTurMum).toISOString() : null,
    bakiye: l.balance, borsaBakiye: borsa, acik, sicil: l.stats, coinler };
  writeFileSync(CANLI, JSON.stringify(pano, null, 1) + '\n');
  return pano;
}

async function izle() {
  try { await dolumlariIsle(); } catch (e) { await hataBildir('dolum takibi', e); }
  try { await panoUret(); } catch (e) { await hataBildir('pano', e); }
}

// ---------------------------- HTTP: pano ucu --------------------------------------
function panoSunucusu() {
  createServer((req, res) => {
    const yol = req.url.split('?')[0];
    if (yol === '/canli.json' || yol === '/') {
      try { const b = readFileSync(CANLI); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(b); }
      catch { res.writeHead(503, { 'Access-Control-Allow-Origin': '*' }); res.end('{"hata":"pano henüz üretilmedi"}'); }
    } else if (yol === '/saglik') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: true, mode: MODE, dur: durMu(), sonTur: sonTurMum })); }
    else { res.writeHead(404); res.end(); }
  }).listen(PORT, '127.0.0.1', () => log(`pano ucu 127.0.0.1:${PORT}/canli.json`));
}

// ---------------------------- döngü ------------------------------------------------
async function tik() {
  const d = new Date(), saat = d.getUTCHours(), dk = d.getUTCMinutes();
  const mum = mumAcilis();
  // mum kapanışından 1 dk sonra, bu mum için henüz tur atılmadıysa
  if (saat % 4 === 0 && dk >= 1 && sonTurMum !== mum) await tur('mum kapanışı');
  await izle();
}

async function basla() {
  log(`yürütücü başlıyor · mod ${MODE} · push ${PUSH ? 'açık' : 'kapalı'} · kök ${ROOT}`);
  await bx.saatEsitle();
  if (MODE !== 'dry') { try { const b = await bx.bakiye(); log(`borsa bakiyesi ${f2(b.toplam)}$ (kullanılabilir ${f2(b.kullanilabilir)}$)`); } catch (e) { await hataBildir('bakiye okunamadı (anahtar/IP?)', e); } }
  // açılışta: son tur hangi mumdaysa onu bil (gereksiz tekrar tur atma)
  const st = stateOku(); if (st?.updated) sonTurMum = mumAcilis(Date.parse(st.updated));
  if (TUR_SIMDI) { await tur('elle'); }
  if (ONCE) { await izle(); log('tek tik bitti'); return; }
  panoSunucusu();
  await tg(`🟢 Yürütücü başladı (${MODE})`, `kurallar: risk %${KURAL.RISK_PCT * 100} · max ${KURAL.MAX_POS} pozisyon · ${KURAL.KALDIRAC}x izole · BTC istisna (risk ~%5,6) · 7 gün süre stopu · dur ${KURAL.DUR_BAKIYE}$`, 'green_circle');
  for (;;) {
    const basi = Date.now();
    try { await tik(); } catch (e) { await hataBildir('tik', e); }
    const bekle = Math.max(5000, 60000 - (Date.now() - basi));
    await uyku(bekle);
  }
}

basla().catch(e => { console.error('YÜRÜTÜCÜ ÇÖKTÜ:', e); process.exit(1); });
