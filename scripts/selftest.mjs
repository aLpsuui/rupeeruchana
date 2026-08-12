// Sentetik veriyle kural mantığı testi — ağ gerektirmez.
// node scripts/update.mjs --selftest

import { scanBars, sizeTrade, summarize, TIME_STOP_MS, RISK_PCT, MAX_LEVERAGE, MAX_POSITIONS } from './executor.mjs';

// [openTime, open, high, low, close, ...] — Binance kline biçimi (test için kısaltılmış)
const bar = (tMs, high, low, close) => [tMs, close, high, low, close];

function seriesFrom(closes) {
  return {
    opens:  closes.map(c => c * 0.999),
    highs:  closes.map(c => c * 1.004),
    lows:   closes.map(c => c * 0.996),
    closes: [...closes],
    times:  closes.map((_, i) => i),
  };
}

// Günlük: 120 bar, istikrarlı yükseliş → fiyat EMA50 üstünde, EMA yükseliyor
function bullDaily() {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 120; i++) { p *= 1.004; closes.push(p); }
  return seriesFrom(closes);
}

// 4s LONG senaryosu: yükseliş → sert geri çekilme (RSI < 42) → EMA21 üstüne kesişim.
// Kesişimin TAM son kapalı mumda olması için toparlanmayı adım adım büyütüp
// sinyal üreten ilk seriyi kullanırız (kesişim anını yakalama).
function longSetupH4(analyzeCoin, daily) {
  for (let rec = 1; rec <= 20; rec++) {
    const closes = [];
    let p = 100;
    for (let i = 0; i < 200; i++) { p *= 1.0015; closes.push(p); }        // trend
    for (let i = 0; i < 25; i++)  { p *= 0.9955; closes.push(p); }        // geri çekilme
    for (let i = 0; i < rec; i++) { p *= 1.0065; closes.push(p); }        // toparlanma
    closes.push(p);                                                        // oluşmakta olan mum
    const a = analyzeCoin('TST', daily, seriesFrom(closes));
    if (a.signal) return { series: seriesFrom(closes), rec };
  }
  return { series: null, rec: -1 };
}

// 4s nötr senaryo: geri çekilme yok (RSI hep yüksek) → sinyal olmamalı
function noPullbackH4() {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 240; i++) { p *= 1.002; closes.push(p); }
  closes.push(p);
  return seriesFrom(closes);
}

function bearDaily() {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 120; i++) { p *= 0.996; closes.push(p); }
  return seriesFrom(closes);
}

// 4s SHORT senaryosu: düşüş → tepki (RSI > 58) → EMA21 altına kesişim (adaptif)
function shortSetupH4(analyzeCoin, daily) {
  for (let rec = 1; rec <= 20; rec++) {
    const closes = [];
    let p = 100;
    for (let i = 0; i < 200; i++) { p *= 0.9985; closes.push(p); }
    for (let i = 0; i < 25; i++)  { p *= 1.0045; closes.push(p); }        // tepki
    for (let i = 0; i < rec; i++) { p *= 0.9935; closes.push(p); }        // düşüş
    closes.push(p);
    const a = analyzeCoin('TST', daily, seriesFrom(closes));
    if (a.signal) return { series: seriesFrom(closes), rec };
  }
  return { series: null, rec: -1 };
}

export function runSelfTest({ analyzeCoin }) {
  let pass = 0, fail = 0;
  const check = (name, cond, info) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name} — ${info}`); }
  };

  console.log('SENTETİK TEST 1: yükseliş trendi + geri çekilme + kesişim → LONG sinyali');
  const bd = bullDaily();
  const l = longSetupH4(analyzeCoin, bd);
  check('kesişim mumu bulundu', l.series !== null, 'hiçbir toparlanma uzunluğu sinyal üretmedi');
  const a1 = l.series ? analyzeCoin('TST', bd, l.series) : { signal: null, status: '-', uptrend: false, hadPullback: false };
  check('uptrend algılandı', a1.uptrend, JSON.stringify({ price: a1.price, ema: a1.dailyEma, rising: a1.rising }));
  check('geri çekilme kanıtı (RSI<42)', a1.hadPullback, `rsiMin8=${a1.rsiMin8}`);
  check('LONG sinyali üretildi', a1.signal?.dir === 'LONG', `status=${a1.status} signal=${JSON.stringify(a1.signal)}`);
  if (a1.signal) {
    check('stop girişin altında', a1.signal.stop < a1.signal.entry, '');
    check('hedef = giriş + 2,5R', Math.abs((a1.signal.target - a1.signal.entry) / (a1.signal.entry - a1.signal.stop) - 2.5) < 1e-9, '');
  }

  console.log('SENTETİK TEST 2: geri çekilme yoksa sinyal yok');
  const a2 = analyzeCoin('TST', bullDaily(), noPullbackH4());
  check('sinyal üretilmedi', a2.signal === null, `status=${a2.status}`);
  check('durum LONG ADAYI', a2.status === 'LONG ADAYI', `status=${a2.status}`);

  console.log('SENTETİK TEST 3: düşüş trendi + tepki + aşağı kesişim → SHORT sinyali');
  const bd3 = bearDaily();
  const s = shortSetupH4(analyzeCoin, bd3);
  check('kesişim mumu bulundu', s.series !== null, 'hiçbir düşüş uzunluğu sinyal üretmedi');
  const a3 = s.series ? analyzeCoin('TST', bd3, s.series) : { signal: null, status: '-', downtrend: false, hadBounce: false };
  check('downtrend algılandı', a3.downtrend, JSON.stringify({ price: a3.price, ema: a3.dailyEma, falling: a3.falling }));
  check('tepki kanıtı (RSI>58)', a3.hadBounce, `rsiMax8=${a3.rsiMax8}`);
  check('SHORT sinyali üretildi', a3.signal?.dir === 'SHORT', `status=${a3.status} signal=${JSON.stringify(a3.signal)}`);
  if (a3.signal) check('stop girişin üstünde', a3.signal.stop > a3.signal.entry, '');

  console.log('SENTETİK TEST 4: mum taraması — stop/hedef/süre stopu');
  const T0 = 1_700_000_000_000;   // sabit başlangıç (saat başı)
  const HR = 3_600_000;
  const long = { dir: 'LONG', stop: 90, target: 120, startMs: T0 };

  const hitStop = scanBars(
    [bar(T0, 105, 100, 102), bar(T0 + HR, 104, 89, 91)],
    { ...long, nowMs: T0 + 2 * HR }
  );
  check('LONG stop dokunuşu yakalanır', hitStop.outcome === 'STOP ✗' && hitStop.exit === 90, JSON.stringify(hitStop));

  const hitTarget = scanBars(
    [bar(T0, 105, 100, 102), bar(T0 + HR, 121, 110, 120)],
    { ...long, nowMs: T0 + 2 * HR }
  );
  check('LONG hedef dokunuşu yakalanır', hitTarget.outcome === 'HEDEF ✓' && hitTarget.exit === 120, JSON.stringify(hitTarget));

  const both = scanBars(
    [bar(T0, 125, 85, 100)],   // aynı mumda hem stop hem hedef
    { ...long, nowMs: T0 + HR }
  );
  check('aynı mumda ikisi de → tutucu: STOP', both.outcome === 'STOP ✗', JSON.stringify(both));

  const short = { dir: 'SHORT', stop: 110, target: 80, startMs: T0 };
  const shortStop = scanBars(
    [bar(T0, 111, 99, 110)],
    { ...short, nowMs: T0 + HR }
  );
  check('SHORT stop dokunuşu yakalanır', shortStop.outcome === 'STOP ✗' && shortStop.exit === 110, JSON.stringify(shortStop));

  // Süre stopu: 7 gün doldu, dokunuş yok → süre dolduğu andaki kapanıştan çıkılır
  const timeStop = scanBars(
    [bar(T0, 105, 95, 100), bar(T0 + TIME_STOP_MS - HR, 106, 96, 103)],
    { ...long, nowMs: T0 + TIME_STOP_MS + HR }
  );
  check('süre stopu son kapanıştan uygular', timeStop.outcome === 'SÜRE ⏱' && timeStop.exit === 103, JSON.stringify(timeStop));

  // Motor günlerce durursa: süre stopundan SONRAKİ dokunuş geriye dönük işlenmez
  const lateTouch = scanBars(
    [bar(T0, 105, 95, 100),
     bar(T0 + TIME_STOP_MS - HR, 106, 96, 103),
     bar(T0 + TIME_STOP_MS + 5 * HR, 130, 60, 70)],   // gecikmiş tur: hem stop hem hedef bölgesi
    { ...long, nowMs: T0 + TIME_STOP_MS + 48 * HR }
  );
  check('süre stopu sonrası dokunuş sayılmaz', lateTouch.outcome === 'SÜRE ⏱' && lateTouch.exit === 103, JSON.stringify(lateTouch));

  // Süre dolmadan sonuç yoksa pozisyon açık kalır
  const stillOpen = scanBars(
    [bar(T0, 105, 95, 100)],
    { ...long, nowMs: T0 + 3 * HR }
  );
  check('sonuç yoksa pozisyon açık kalır', stillOpen.outcome === null, JSON.stringify(stillOpen));

  console.log('SENTETİK TEST 5: boyutlama — risk sabit, adet stoptan türer');
  const B = 1000;
  const wide = sizeTrade({ balance: B, entry: 100, stop: 95 });    // %5 stop
  const tight = sizeTrade({ balance: B, entry: 100, stop: 99 });   // %1 stop
  check('geniş stopta risk = bakiyenin %2si', Math.abs(wide.riskUsd - B * RISK_PCT) < 0.01, JSON.stringify(wide));
  check('dar stopta da risk aynı', Math.abs(tight.riskUsd - B * RISK_PCT) < 0.01, JSON.stringify(tight));
  check('dar stopta pozisyon daha büyük', tight.notional > wide.notional, `${tight.notional} vs ${wide.notional}`);
  check('geniş stopta adet daha az', wide.qty < tight.qty, `${wide.qty} vs ${tight.qty}`);
  check('teminat = nominal / kaldıraç', Math.abs(wide.marginUsd - wide.notional / MAX_LEVERAGE) < 0.01, JSON.stringify(wide));
  check('stop yüzdesi kaydediliyor', wide.stopPct === 5 && tight.stopPct === 1, `${wide.stopPct} / ${tight.stopPct}`);

  // Çok dar stopta teminat kontenjanı devreye girer: tek işlem bakiyenin
  // 1/MAX_POSITIONS'ından fazla teminat tutamaz.
  const veryTight = sizeTrade({ balance: B, entry: 100, stop: 99.9 }); // %0,1 stop
  check('teminat kontenjanı sınırlıyor', veryTight.capped === true, JSON.stringify(veryTight));
  check('teminat kontenjanı aşılmıyor', veryTight.marginUsd <= B / MAX_POSITIONS + 0.01, JSON.stringify(veryTight));
  check('kontenjana takılınca risk azalır (artmaz)', veryTight.riskUsd <= B * RISK_PCT + 0.01, JSON.stringify(veryTight));

  check('SHORT yönü de aynı boyutlanır', Math.abs(sizeTrade({ balance: B, entry: 100, stop: 105 }).riskUsd - B * RISK_PCT) < 0.01, '');
  check('geçersiz stop null döner', sizeTrade({ balance: B, entry: 100, stop: 100 }) === null, '');

  console.log('SENTETİK TEST 6: MFE/MAE ölçümü');
  // giriş 100, stop 90, hedef 125 → R = 10
  const mLong = { dir: 'LONG', stop: 90, target: 125, entry: 100, startMs: T0 };
  const journey = scanBars(
    [bar(T0, 115, 97, 110),                    // lehe 1,5R · aleyhe 0,3R
     bar(T0 + HR, 118, 94, 96),                // lehe 1,8R · aleyhe 0,6R
     bar(T0 + 2 * HR, 105, 89, 90)],           // stop
    { ...mLong, nowMs: T0 + 3 * HR }
  );
  check('stop sonucu doğru', journey.outcome === 'STOP ✗', JSON.stringify(journey));
  check('MFE en iyi anı yakalar (1,8R)', journey.mfeR === 1.8, `mfeR=${journey.mfeR}`);
  check('MAE stop mumunu da sayar (1,1R)', journey.maeR === 1.1, `maeR=${journey.maeR}`);
  check('tutulan mum sayısı', journey.bars === 3, `bars=${journey.bars}`);

  const shortJourney = scanBars(
    [bar(T0, 103, 88, 90)],                    // SHORT: giriş 100, lehe 1,2R, aleyhe 0,3R
    { dir: 'SHORT', stop: 110, target: 75, entry: 100, startMs: T0, nowMs: T0 + HR }
  );
  check('SHORT MFE doğru yönde', shortJourney.mfeR === 1.2, `mfeR=${shortJourney.mfeR}`);
  check('SHORT MAE doğru yönde', shortJourney.maeR === 0.3, `maeR=${shortJourney.maeR}`);

  const noEntry = scanBars([bar(T0, 115, 97, 110)], { dir: 'LONG', stop: 90, target: 125, startMs: T0, nowMs: T0 + HR });
  check('entry yoksa MFE/MAE null', noEntry.mfeR === null && noEntry.maeR === null, JSON.stringify(noEntry));

  console.log('SENTETİK TEST 7: sicil özeti');
  const sum = summarize([
    { outcome: 'HEDEF ✓', mfeR: 2.6, maeR: 0.4, bars: 30, pnl: 50 },
    { outcome: 'STOP ✗',  mfeR: 0.8, maeR: 1.1, bars: 12, pnl: -20 },
    { outcome: 'SÜRE ⏱',  mfeR: 1.4, maeR: 0.9, bars: 42, pnl: 3 },
  ]);
  check('işlem sayısı', sum.trades === 3, JSON.stringify(sum));
  check('isabet oranı %33,3', sum.winRate === 33.3, `winRate=${sum.winRate}`);
  check('toplam PnL', sum.pnlSum === 33, `pnlSum=${sum.pnlSum}`);
  check('hedefe ulaşamayanların ortalama MFE (1,1R)', sum.missAvgMfeR === 1.1, `missAvgMfeR=${sum.missAvgMfeR}`);
  check('hedefe ulaşamayanların en iyisi (1,4R)', sum.missMaxMfeR === 1.4, `missMaxMfeR=${sum.missMaxMfeR}`);
  check('boş sicil çökmeden özetlenir', summarize([]).trades === 0, JSON.stringify(summarize([])));

  console.log(`\nSONUÇ: ${pass} geçti, ${fail} kaldı`);
  process.exit(fail ? 1 : 0);
}
