/* ============================================================================
 * Rupeeruchana — Ajan Katı
 * Sistemin modüllerini bir piksel ofisi olarak çizer. Her masa gerçek bir script,
 * her karakter o scriptin SON TURDA ne yaptığını gösterir; sahte hareket yok:
 *   - veri state.json / dipradar.json / takvim.json / gercek.json'dan gelir,
 *   - aktif sinyal varsa masanın üstünde "CANLI" tabelası yanar,
 *   - son tur 5 saatten eskiyse herkes hayalet olur ve "tur gecikti" yazar.
 * Fikir: pixel-grokbots (MIT, Davidgon8) ve Pixel Agents. Çizim ve kod özgün.
 * Bağımlılık yok: düz canvas. Sayfa RupeeKat.feed(kaynak, veri) ile besler.
 * ========================================================================== */
(function (root) {
  'use strict';

  var TILE = 28, COLS = 28, ROWS = 15;   // 784×420: sayfada hafif büyütülür, piksel görünümü böyle çıkar
  // GitHub'ın zamanlanmış işleri gecikmeli çalışır: 4 saatlik cron pratikte 5,5-6 saat
  // arayla geliyor (ölçüldü, 29-30 Eyl 2026). 5 saat yanlış alarm verirdi; 7 saat =
  // bir tur atlanmış demek. Üst çubuk zaten "kaç saat önce" yazar, etiket değil sayı konuşur.
  var GECIKME_SAAT = 7;
  var CRON_DAKIKA = 17;              // .github/workflows/update.yml: '17 */4 * * *' (UTC)

  // ---- roller: her biri gerçek bir modül --------------------------------------
  // desk: masa karosu (2 karo genişlik). Karakter masanın altındaki karoda oturur.
  var ROLLER = [
    { id: 'tarama', ad: 'Tarayıcı',       kisa: 'TARAMA', renk: '#3ee0a8', sac: '#1b1b1b', ten: '#e7c7a4', desk: { x: 2,  y: 4 },
      dosya: 'scripts/update.mjs · analyzeCoin', gorev: 'Her 4 saatte çekirdek + radar coinlerini v3 kurallarıyla tarar; kurulum ve sinyal üretir.' },
    { id: 'trend',  ad: 'Trend Ajanı',    kisa: 'TREND',  renk: '#6ee7ff', sac: '#3d2a18', ten: '#f0d0b0', desk: { x: 7,  y: 4 },
      dosya: 'scripts/update.mjs · trendComment', gorev: 'BTC\'nin günlük EMA50 rejimini okur ve akışa tek satırlık yön yorumu yazar.' },
    { id: 'radar',  ad: 'Altcoin Radarı', kisa: 'RADAR',  renk: '#f2d27a', sac: '#5a3a22', ten: '#d9a078', desk: { x: 12, y: 4 },
      dosya: 'scripts/update.mjs · ALTS', gorev: '21 altcoini aynı kurallarla izler, sicil tutar, işlem AÇMAZ.' },
    { id: 'dip',    ad: 'Dip Radarı',     kisa: 'DİP',    renk: '#c58aff', sac: '#111111', ten: '#b57a52', desk: { x: 17, y: 4 },
      dosya: 'scripts/dipradar.mjs', gorev: 'Binance\'teki tüm USDT çiftlerini tarar, EMA50\'nin çok altındaki adayları listeler, 30 gün takip eder.' },
    { id: 'risk',   ad: 'Risk Bekçisi',   kisa: 'RİSK',   renk: '#ff6b74', sac: '#4a2c14', ten: '#e2b48a', desk: { x: 2,  y: 11 },
      dosya: 'scripts/update.mjs · sinyal takibi', gorev: 'Açık sinyalleri mum mum tarar: stop mu, hedef mi, süre mi? Tetiksiz kurulumu yayınlatmaz.' },
    { id: 'takvim', ad: 'Takvim',         kisa: 'TAKVİM', renk: '#f5b455', sac: '#2a1c12', ten: '#c58a62', desk: { x: 7,  y: 11 },
      dosya: 'scripts/takvim.mjs', gorev: 'Yeni listeleme, delist ve token kilit açılışlarını izler.' },
    { id: 'cuzdan', ad: 'Gerçek Cüzdan',  kisa: 'CÜZDAN', renk: '#8fd3ff', sac: '#1b1b1b', ten: '#e7c7a4', desk: { x: 12, y: 11 },
      dosya: 'scripts/gercek.mjs · data/gercek.json', gorev: '50$ gerçek para, aynı kurallar: işlem başına %2 risk, en fazla 3 pozisyon, BTC yok. Emirleri insan girer, defteri bu masa tutar. Hedef 20 işlemlik sicil.' },
    { id: 'sef',    ad: 'Şef',            kisa: 'ŞEF',    renk: '#e6ebe9', sac: '#2a2a2a', ten: '#e7c7a4', desk: { x: 23, y: 7 }, patron: true,
      dosya: 'scripts/notify.mjs · tur özeti', gorev: 'İşlem yapmaz. Turun sonunda herkesin raporunu toplar ve sana Telegram\'dan yollar.' }
  ];

  var RACK = { x: 17, y: 10, w: 3, h: 3 };   // GitHub Actions "sunucusu"
  var CAM_X = 21;                               // patron odasının cam duvarı

  // ---- durum -----------------------------------------------------------------
  var veri = { state: null, dip: null, takvim: null, cuzdan: null };
  var model = {};            // rol id -> { satir, canli, bekle, feed: [] }
  var botlar = [];
  var canvas, ctx, tick = 0, bloklar = {}, secili = null, odak = 0, odakZaman = 0;
  var hazir = false, gecikti = false, sonTur = null;

  function blokla(x, y) { bloklar[x + ',' + y] = 1; }
  function bloklu(x, y) {
    if (x < 1 || y < 2 || x > COLS - 2 || y > ROWS - 2) return true;
    return !!bloklar[x + ',' + y];
  }

  // ---- kur -------------------------------------------------------------------
  function kur() {
    canvas = document.getElementById('katCanvas');
    if (!canvas || hazir) return;
    ctx = canvas.getContext('2d');
    canvas.width = COLS * TILE; canvas.height = ROWS * TILE;

    ROLLER.forEach(function (r) {
      blokla(r.desk.x, r.desk.y); blokla(r.desk.x + 1, r.desk.y);
      botlar.push({
        rol: r, x: r.desk.x, y: r.desk.y + 1, evX: r.desk.x, evY: r.desk.y + 1,
        yol: [], durum: 'type', bakis: 1, kare: Math.floor(Math.random() * 40), bekle: 200 + Math.floor(Math.random() * 300)
      });
    });
    for (var x = RACK.x; x < RACK.x + RACK.w; x++) for (var y = RACK.y; y < RACK.y + RACK.h; y++) blokla(x, y);
    for (var yy = 2; yy < ROWS - 1; yy++) if (yy !== 8 && yy !== 9) blokla(CAM_X, yy); // camda kapı: y=8-9

    canvas.addEventListener('click', tikla);
    hazir = true;
    modelKur();
    rosterCiz();
    requestAnimationFrame(dongu);
  }

  // ---- veri -> model ---------------------------------------------------------
  function kirp(s, n) { s = String(s || '').replace(/<[^>]+>/g, ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function feedSatirlari(who) {
    var st = veri.state; if (!st || !st.feed) return [];
    return st.feed.filter(function (f) { return (f.who || '').indexOf(who) === 0; }).slice(0, 3)
      .map(function (f) { return kirp(f.body || (f.candidate ? f.candidate.dir + ' ' + f.candidate.pair + ' · ' + f.candidate.trigger : ''), 110); });
  }
  function nf(n, d) { return Number(n).toLocaleString('tr-TR', { maximumFractionDigits: d == null ? 2 : d }); }
  function saat(iso) { try { return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } }

  // Bir sonraki tur: cron '17 */4 * * *' UTC -> son turdan sonraki ilk 4 saatlik :17
  function sonrakiTur(sonIso) {
    var t = new Date(sonIso || Date.now());
    var n = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), Math.floor(t.getUTCHours() / 4) * 4 + 4, CRON_DAKIKA));
    return n;
  }

  function modelKur() {
    var st = veri.state, dp = veri.dip, tk = veri.takvim, cz = veri.cuzdan;
    model = {};
    sonTur = st && st.updated ? new Date(st.updated) : null;
    gecikti = !!(sonTur && (Date.now() - sonTur.getTime()) > GECIKME_SAAT * 3600e3);

    var wl = (st && st.watchlist) || [];
    var aktif = ((st && st.signals) || []).filter(function (s) { return s.state === 'AKTİF'; });
    var kurulum = wl.filter(function (w) { return w.status === 'KURULUM'; }).length;
    var sinyalli = wl.filter(function (w) { return w.status === 'SİNYAL'; });
    var alts = (st && st.alts) || [];
    var altHot = alts.filter(function (a) { return a.star; });
    var altAktif = ((st && st.altSignals) || []).filter(function (s) { return s.state === 'AKTİF'; });
    var trendSon = feedSatirlari('Trend Ajanı')[0];
    var riskSon = feedSatirlari('Risk Bekçisi')[0];

    model.tarama = { canli: sinyalli.length > 0,
      satir: st ? wl.length + ' çekirdek coin tarandı · ' + kurulum + ' kurulum · ' + sinyalli.length + ' yeni sinyal' : 'veri bekleniyor',
      feed: feedSatirlari('Tarayıcı') };
    model.trend = { satir: trendSon || 'BTC rejimi okunuyor', feed: feedSatirlari('Trend Ajanı') };
    model.radar = { canli: altAktif.length > 0,
      satir: alts.length ? alts.length + ' coin · ' + altHot.length + ' öne çıkan · ' + altAktif.length + ' radar sinyali' : 'radar bekliyor',
      feed: feedSatirlari('Altcoin Radarı') };
    model.dip = { satir: dp ? ((dp.active || []).length + ' aday · rejim ' + (dp.rejim || '?').toUpperCase() + ' · ' + (dp.scanned || '?') + ' coin tarandı') : 'tarama bekleniyor',
      feed: dp && dp.note ? [kirp(dp.note, 110)] : [] };
    model.risk = { canli: aktif.length > 0, bekle: aktif.length > 0,
      satir: aktif.length ? aktif.length + ' açık sinyal mum mum izleniyor: ' + aktif.map(function (s) { return s.coin + ' ' + s.dir; }).join(', ') : (riskSon || 'açık sinyal yok'),
      feed: feedSatirlari('Risk Bekçisi') };
    model.takvim = { satir: tk ? ((tk.olaylar || []).length + ' olay · ' + (tk.yakinKilitler || []).length + ' yakın kilit · ' + (tk.symbolCount || 0) + ' sembol') : 'takvim bekleniyor',
      feed: tk && tk.note ? [kirp(tk.note, 110)] : [] };
    // Gerçek cüzdan (data/gercek.json, scripts/gercek.mjs yazar). Kapanan işlemler 'closed',
    // atlanan sinyaller 'skipped'; alan adları sanal cüzdanla aynı tutuldu.
    model.cuzdan = { canli: !!(cz && (cz.open || []).length),
      satir: cz ? (nf(cz.balance, 2) + '$ gerçek · ' + (cz.open || []).length + ' açık · sicil ' + ((cz.stats || {}).hedef || 0) + '✓/' + ((cz.stats || {}).trades || 0) + ' · hedef 20 işlem') : 'defter bekleniyor',
      feed: cz && cz.open && cz.open.length ? cz.open.slice(0, 3).map(function (o) { return (o.coin || o.symbol) + ' ' + o.dir + ' (' + (o.kaynak || '?') + ') · giriş ' + nf(o.entry, 4) + ' · risk ' + nf(o.riskUsd, 2) + '$'; })
          : ['Açık işlem yok. İlk sinyal gelince insan açar, defter buraya yazar.'] };
    model.sef = { bekle: aktif.length > 0,
      satir: sonTur ? ('son tur ' + saat(sonTur) + ' · sonraki ~' + saat(sonrakiTur(sonTur)) + (gecikti ? ' · TUR GECİKTİ' : '')) : 'ilk tur bekleniyor',
      feed: [aktif.length ? aktif.length + ' aktif sinyal Telegram\'a bildirildi' : 'Bu tur bildirilecek yeni sinyal yok', 'Tur özeti her 4 saatte bir Telegram\'a gider'] };

    // hareketi veriye bağla: sinyal varsa Şef, Risk masasına yürür (rapor alır)
    botlar.forEach(function (b) {
      var m = model[b.rol.id] || {};
      b.durum = gecikti ? 'idle' : (m.bekle ? 'wait' : 'type');
    });
    if (!gecikti && aktif.length) {
      var sef = botlar[botlar.length - 1], risk = botlar[4];
      if (sef.yol.length === 0 && !(sef.x === risk.evX + 2 && sef.y === risk.evY)) sef.yol = yolBul(sef.x, sef.y, risk.evX + 2, risk.evY);
    }
    rosterCiz();
    ustBilgiCiz();
  }

  // ---- yol bulma (BFS) --------------------------------------------------------
  function yolBul(sx, sy, tx, ty) {
    var k = function (x, y) { return x + ',' + y; };
    var q = [[sx, sy]], gor = {}, onceki = {}; gor[k(sx, sy)] = 1;
    var yon = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
      var c = q.shift(), x = c[0], y = c[1];
      if (x === tx && y === ty) {
        var yol = [], cur = k(x, y);
        while (onceki[cur]) { var p = cur.split(',').map(Number); yol.push({ x: p[0], y: p[1] }); cur = onceki[cur]; }
        return yol.reverse();
      }
      for (var i = 0; i < 4; i++) {
        var nx = x + yon[i][0], ny = y + yon[i][1], kk = k(nx, ny);
        if (gor[kk]) continue;
        if (bloklu(nx, ny) && !(nx === tx && ny === ty)) continue;
        gor[kk] = 1; onceki[kk] = k(x, y); q.push([nx, ny]);
      }
    }
    return [];
  }

  // ---- animasyon adımı ---------------------------------------------------------
  var adimSayac = 0;
  function adim() {
    botlar.forEach(function (b) {
      b.kare++;
      if (b.yol.length) {
        if (b.kare % 3 === 0) {
          var n = b.yol.shift();
          b.bakis = n.x >= b.x ? 1 : -1; b.x = n.x; b.y = n.y;
          if (!b.yol.length) b.bekle = 250 + Math.floor(Math.random() * 250);
        }
        return;
      }
      b.bekle--;
      if (b.bekle <= 0 && !gecikti) {
        // ara sıra sunucuya gidip veri çek, sonra masana dön (sahte iş değil: her tur gerçekten Binance'e gidiyorlar)
        var evde = b.x === b.evX && b.y === b.evY;
        if (evde && !b.rol.patron && Math.random() < 0.35) b.yol = yolBul(b.x, b.y, RACK.x - 1, RACK.y + 1);
        else if (!evde) b.yol = yolBul(b.x, b.y, b.evX, b.evY);
        b.bekle = 300 + Math.floor(Math.random() * 400);
      }
    });
    // odak baloncuğu 4 saniyede bir sonraki masaya geçer
    if (++adimSayac % 240 === 0) { odak = (odak + 1) % botlar.length; }
  }

  // ---- çizim -------------------------------------------------------------------
  function pix(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function yazi(t, x, y, c, boy, hiza) {
    ctx.fillStyle = c; ctx.font = (boy || 9) + 'px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = hiza || 'left'; ctx.fillText(t, x, y); ctx.textAlign = 'left';
  }

  function zeminCiz() {
    for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
      pix(x * TILE, y * TILE, TILE, TILE, (x + y) % 2 ? '#10161b' : '#0e1317');
    }
    // duvar + pencere şeridi
    pix(0, 0, COLS * TILE, TILE * 2, '#0a0f12');
    pix(0, TILE * 2 - 3, COLS * TILE, 3, '#1e2a30');
    for (var i = 0; i < 7; i++) { pix(2 * TILE + i * 3.4 * TILE, 18, TILE * 2.2, TILE * 1.2, '#0d1a24'); pix(2 * TILE + i * 3.4 * TILE + 4, 22, TILE * 2.2 - 8, TILE * 1.2 - 8, '#122634'); }
    // yıldızlar (fiyat şeridinin altında kalsın)
    ctx.fillStyle = '#6ee7ff'; for (var s = 0; s < 18; s++) ctx.fillRect(30 + s * 40, 24 + (s * 7) % 16, 2, 2);
    // kenar duvarlar
    pix(0, 0, TILE, ROWS * TILE, '#0a0f12'); pix((COLS - 1) * TILE, 0, TILE, ROWS * TILE, '#0a0f12'); pix(0, (ROWS - 1) * TILE, COLS * TILE, TILE, '#0a0f12');

    // patron odası: halı + cam duvar (kapı y=8-9)
    pix((CAM_X + 1) * TILE, 2 * TILE, (COLS - CAM_X - 2) * TILE, (ROWS - 3) * TILE, '#111a1b');
    for (var yy = 2; yy < ROWS - 1; yy++) {
      if (yy === 8 || yy === 9) continue;
      pix(CAM_X * TILE + 10, yy * TILE, 8, TILE, 'rgba(110,231,255,.18)');
      pix(CAM_X * TILE + 12, yy * TILE, 2, TILE, 'rgba(110,231,255,.45)');
    }
    yazi('ŞEF ODASI', (CAM_X + 3.5) * TILE, 3 * TILE - 8, '#5f6a66', 9, 'center');
    yazi('· yönlendirme · risk · rapor ·', (CAM_X + 3.5) * TILE, 3 * TILE + 4, '#3a4542', 8, 'center');

    // bitkiler
    bitki(19 * TILE + 8, 6 * TILE); bitki(2 * TILE + 4, 8 * TILE + 2); bitki((COLS - 3) * TILE + 4, 11 * TILE + 6);

    // sunucu rafı = GitHub Actions
    var rx = RACK.x * TILE, ry = RACK.y * TILE;
    pix(rx - 6, ry - 6, RACK.w * TILE + 12, RACK.h * TILE + 12, '#141c21');
    pix(rx + 4, ry + 2, RACK.w * TILE - 8, RACK.h * TILE - 4, '#070b0d');
    for (var r = 0; r < 5; r++) {
      pix(rx + 10, ry + 8 + r * 14, RACK.w * TILE - 20, 9, '#0f171b');
      var on = (tick + r * 7) % 40 < 20;
      pix(rx + RACK.w * TILE - 20, ry + 10 + r * 14, 5, 5, on ? '#3ee0a8' : '#173029');
      pix(rx + RACK.w * TILE - 28, ry + 10 + r * 14, 5, 5, (tick + r * 11) % 60 < 8 ? '#6ee7ff' : '#12262c');
    }
    yazi('GITHUB ACTIONS', rx + RACK.w * TILE / 2, ry + RACK.h * TILE + 14, '#9aa5a1', 8, 'center');
    yazi('cron · her 4 saat', rx + RACK.w * TILE / 2, ry + RACK.h * TILE + 24, '#5f6a66', 8, 'center');
  }
  function bitki(x, y) { pix(x + 4, y + 14, 12, 12, '#2a1d12'); pix(x + 2, y + 2, 16, 12, '#1f3d28'); pix(x + 6, y - 4, 8, 10, '#3f7a48'); pix(x, y + 6, 6, 6, '#3f7a48'); pix(x + 14, y + 4, 6, 6, '#3f7a48'); }

  function masaCiz(b) {
    var d = b.rol.desk, x = d.x * TILE, y = d.y * TILE, m = model[b.rol.id] || {};
    var canli = !!m.canli && !gecikti;
    // masa
    pix(x, y + 6, TILE * 2, TILE - 6, '#4a3421'); pix(x, y + 6, TILE * 2, 3, '#6b4b2e'); pix(x + 2, y + TILE - 2, TILE * 2 - 4, 4, '#2c1e12');
    // monitör + mini grafik (her masa kendi renginde)
    pix(x + 3, y - 13, 28, 20, '#0a0f12'); pix(x + 5, y - 11, 24, 16, '#0f1a1f');
    ctx.strokeStyle = b.rol.renk; ctx.lineWidth = 1.5; ctx.beginPath();
    for (var i = 0; i < 11; i++) { var px = x + 7 + i * 2, py = y - 3 + Math.sin((tick / 9 + i + d.x) * 0.9) * 4; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
    ctx.stroke();
    pix(x + 34, y - 8, 19, 15, '#0a0f12'); pix(x + 36, y - 6, 15, 11, canli ? '#173029' : '#0f1a1f');
    if (canli) { pix(x + 38, y - 4, 11, 2, '#3ee0a8'); pix(x + 38, y, 7, 2, '#3ee0a8'); }
    // klavye
    pix(x + 12, y + 12, 26, 6, '#1c2529'); pix(x + 14, y + 14, 22, 2, '#2a353b');
    // CANLI tabelası
    if (canli) {
      var yan = (tick % 30) < 22;
      pix(x - 4, y - 32, TILE * 2 + 8, 15, yan ? '#3ee0a8' : '#1f6b52');
      yazi('● CANLI', x + TILE, y - 21, '#06120d', 9, 'center');
    }
  }

  function karakterCiz(b) {
    // 18 px genişlik, 30 px boy: karo başına bir kişi, kafa masanın alt kenarına biner (masada oturuyor hissi)
    var cx = b.x * TILE + 5, cy = b.y * TILE - 6, r = b.rol;
    var hayalet = gecikti;
    ctx.globalAlpha = hayalet ? 0.4 : 1;
    // sandalye
    pix(cx - 4, cy + 9, 26, 22, '#1c2529'); pix(cx - 2, cy + 11, 22, 18, '#222d33');
    // bacaklar
    pix(cx + 3, cy + 27, 5, 7, '#1c2529'); pix(cx + 10, cy + 27, 5, 7, '#1c2529');
    // gövde (rol rengi), patronda takım + kravat
    pix(cx, cy + 13, 18, 15, r.patron ? '#2b2f33' : r.renk);
    if (r.patron) pix(cx + 8, cy + 13, 2, 10, '#ff6b74'); else pix(cx + 6, cy + 16, 6, 2, 'rgba(0,0,0,.25)');
    // kollar: yazarken hafif oynar, beklerken kalkık
    var yaz = b.durum === 'type' && !b.yol.length && (b.kare % 10) < 5;
    var kolY = b.durum === 'wait' ? cy + 9 : (yaz ? cy + 19 : cy + 18);
    pix(cx - 4, kolY, 4, 7, r.ten); pix(cx + 18, kolY, 4, 7, r.ten);
    // kafa
    pix(cx + 2, cy, 14, 13, r.ten);
    pix(cx + 2, cy - 3, 14, 5, r.sac); pix(cx + (b.bakis > 0 ? 2 : 12), cy, 4, 5, r.sac);
    // gözler (arada göz kırpar)
    var kirp = (b.kare % 90) > 86;
    if (!kirp) { pix(cx + (b.bakis > 0 ? 6 : 4), cy + 5, 2, 3, '#0a0f12'); pix(cx + (b.bakis > 0 ? 11 : 9), cy + 5, 2, 3, '#0a0f12'); }
    else { pix(cx + 4, cy + 6, 10, 1, '#0a0f12'); }
    // patron kulaklık
    if (r.patron) { pix(cx, cy + 3, 2, 6, '#e6ebe9'); pix(cx + 16, cy + 3, 2, 6, '#e6ebe9'); pix(cx + 2, cy - 4, 14, 2, '#e6ebe9'); }
    ctx.globalAlpha = 1;
    // bekleme işareti (rapor bekleyen / bildirim yollayan)
    if (b.durum === 'wait' && !hayalet && (tick % 40) < 28) {
      pix(cx + 4, cy - 21, 10, 13, '#ff6b74'); yazi('!', cx + 9, cy - 11, '#0a0f12', 10, 'center');
    }
  }

  function baloncukCiz(b, metin, vurgu) {
    if (!metin) return;
    ctx.font = '9px "JetBrains Mono", Consolas, monospace';
    var satirlar = sar(metin, 30), w = 0;
    satirlar.forEach(function (s) { w = Math.max(w, ctx.measureText(s).width); });
    w += 14; var h = satirlar.length * 12 + 8;
    var bx = b.x * TILE + 14 - w / 2, by = b.y * TILE - 30 - h;
    bx = Math.max(4, Math.min(COLS * TILE - w - 4, bx)); by = Math.max(TILE * 2 + 2, by);
    pix(bx, by, w, h, vurgu ? '#e6ebe9' : '#0a0f12'); pix(bx + 1, by + 1, w - 2, h - 2, vurgu ? '#f4f7f5' : '#141c21');
    pix(b.x * TILE + 11, by + h, 6, 4, vurgu ? '#f4f7f5' : '#141c21');
    satirlar.forEach(function (s, i) { yazi(s, bx + 7, by + 13 + i * 12, vurgu ? '#0a0f12' : '#e6ebe9', 9); });
  }
  function sar(t, n) {
    var k = String(t).split(' '), out = [], cur = '';
    k.forEach(function (w) { if ((cur + ' ' + w).trim().length > n) { out.push(cur.trim()); cur = w; } else cur += ' ' + w; });
    if (cur.trim()) out.push(cur.trim()); return out.slice(0, 3);
  }

  function tickerCiz() {
    var st = veri.state, t = (st && st.ticker) || [];
    pix(0, 0, COLS * TILE, 14, '#070909');
    if (!t.length) { yazi('RUPEERUCHANA · ajan katı', 8, 10, '#5f6a66', 8); return; }
    var metin = t.map(function (x) { return x.s + ' ' + nf(x.p, x.p >= 100 ? 0 : 4) + ' ' + (x.c >= 0 ? '▲' : '▼') + Math.abs(x.c).toFixed(2) + '%'; }).join('   ·   ');
    ctx.font = '8px "JetBrains Mono", Consolas, monospace';
    var w = ctx.measureText(metin).width + 60, off = (tick * 0.6) % w;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, COLS * TILE, 14); ctx.clip();
    for (var i = -1; i < 3; i++) {
      var x0 = i * w - off;
      t.forEach(function (x, j) {
        var parca = x.s + ' ' + nf(x.p, x.p >= 100 ? 0 : 4), degisim = (x.c >= 0 ? '▲' : '▼') + Math.abs(x.c).toFixed(2) + '%';
        var pw = ctx.measureText(parca + ' ').width, dw = ctx.measureText(degisim + '   ·   ').width;
        yazi(parca, x0 + 8, 10, '#9aa5a1', 8); yazi(degisim, x0 + 8 + pw, 10, x.c >= 0 ? '#3ee0a8' : '#ff6b74', 8);
        x0 += pw + dw;
      });
    }
    ctx.restore();
  }

  function ciz() {
    zeminCiz();
    botlar.forEach(masaCiz);
    // y'ye göre sırala ki öndeki karakter arkadakini örtsün
    botlar.slice().sort(function (a, b) { return a.y - b.y; }).forEach(karakterCiz);
    // isim plakaları karakterlerden SONRA ve sandalyenin altına: bacaklar üstüne binmesin
    botlar.forEach(function (b) {
      var x = b.rol.desk.x * TILE, y = b.rol.desk.y * TILE + TILE * 2 + 3;
      pix(x + TILE - 24, y, 48, 11, '#0a0f12'); yazi(b.rol.kisa, x + TILE, y + 8, b.rol.renk, 8, 'center');
    });
    // baloncuk: seçili varsa o, yoksa odak sırayla dolaşır
    var b = secili || botlar[odak], m = model[b.rol.id] || {};
    if (!gecikti || secili) baloncukCiz(b, m.satir, !!secili);
    if (gecikti) {
      pix(COLS * TILE / 2 - 150, ROWS * TILE / 2 - 14, 300, 28, 'rgba(10,15,18,.92)');
      yazi('TUR GECİKTİ — son veri ' + (sonTur ? saat(sonTur) : '?') + ' · Actions çalışmadı ya da askıda', COLS * TILE / 2, ROWS * TILE / 2 + 4, '#f5b455', 9, 'center');
    }
    tickerCiz();
  }

  var sonKare = 0;
  function dongu(ts) {
    if (ts - sonKare > 33) { sonKare = ts; tick++; adim(); ciz(); }
    requestAnimationFrame(dongu);
  }

  // ---- etkileşim ------------------------------------------------------------------
  function tikla(ev) {
    var r = canvas.getBoundingClientRect(), sx = canvas.width / r.width, sy = canvas.height / r.height;
    var mx = (ev.clientX - r.left) * sx, my = (ev.clientY - r.top) * sy;
    var vur = null;
    botlar.forEach(function (b) {
      var d = b.rol.desk;
      var masaIci = mx >= d.x * TILE - 4 && mx <= (d.x + 2) * TILE + 4 && my >= d.y * TILE - 30 && my <= (d.y + 2) * TILE + 26;
      var karakterIci = mx >= b.x * TILE && mx <= (b.x + 1) * TILE && my >= b.y * TILE - 12 && my <= (b.y + 1) * TILE + 6;
      if (masaIci || karakterIci) vur = b;
    });
    secili = (vur && secili !== vur) ? vur : null;
    rosterCiz();
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function rosterCiz() {
    var el = document.getElementById('katRoster'); if (!el) return;
    var html = botlar.map(function (b) {
      var m = model[b.rol.id] || {}, on = secili === b;
      var nokta = gecikti ? '#5f6a66' : (m.canli ? '#3ee0a8' : (m.bekle ? '#ff6b74' : '#9aa5a1'));
      return '<div class="katbot' + (on ? ' on' : '') + '" data-id="' + b.rol.id + '">' +
        '<span class="kdot" style="background:' + nokta + '"></span>' +
        '<span class="kname" style="color:' + b.rol.renk + '">' + esc(b.rol.ad) + '</span>' +
        '<span class="kline">' + esc(m.satir || '') + '</span></div>';
    }).join('');
    var b = secili;
    if (b) {
      var m = model[b.rol.id] || {};
      html += '<div class="katpin"><div class="kp-h" style="color:' + b.rol.renk + '">' + esc(b.rol.ad) + ' <span class="kp-f">' + esc(b.rol.dosya) + '</span></div>' +
        '<div class="kp-g">' + esc(b.rol.gorev) + '</div>' +
        (m.feed && m.feed.length ? '<div class="kp-l">Son tur:</div>' + m.feed.map(function (s) { return '<div class="kp-i">· ' + esc(s) + '</div>'; }).join('') : '<div class="kp-i">Bu tur akışa satır yazmadı.</div>') +
        '</div>';
    } else {
      html += '<div class="katpin muted">Bir masaya tıkla: hangi script olduğunu ve son turda ne yaptığını gösterir.</div>';
    }
    el.innerHTML = html;
    [].slice.call(el.querySelectorAll('.katbot')).forEach(function (n) {
      n.addEventListener('click', function () {
        var b2 = botlar.filter(function (x) { return x.rol.id === n.getAttribute('data-id'); })[0];
        secili = (b2 && secili !== b2) ? b2 : null; rosterCiz();
      });
    });
  }
  function ustBilgiCiz() {
    var a = document.getElementById('katSon'), n = document.getElementById('katSonraki'), d = document.getElementById('katDurum');
    if (a) {
      var dk = sonTur ? Math.round((Date.now() - sonTur.getTime()) / 6e4) : null;
      var yas = dk == null ? '' : dk < 60 ? ' (' + dk + ' dk önce)' : ' (' + (dk / 60).toFixed(dk < 600 ? 1 : 0).replace('.', ',') + ' sa önce)';
      a.textContent = sonTur ? saat(sonTur) + yas : '—';
    }
    if (n) n.textContent = sonTur ? '~' + saat(sonrakiTur(sonTur)) : '—';
    if (d) { d.textContent = gecikti ? 'TUR GECİKTİ' : 'VARDİYADA'; d.className = 'kat-durum ' + (gecikti ? 'late' : 'ok'); }
  }

  // ---- dış API --------------------------------------------------------------------
  root.RupeeKat = {
    feed: function (kaynak, data) {
      veri[kaynak] = data;
      if (!hazir) kur();
      if (hazir) modelKur();
    },
    kur: kur
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur); else kur();
})(window);
