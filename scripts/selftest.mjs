// Sentetik veriyle kural mantığı testi — ağ gerektirmez.
// node scripts/update.mjs --selftest

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

  console.log(`\nSONUÇ: ${pass} geçti, ${fail} kaldı`);
  process.exit(fail ? 1 : 0);
}
