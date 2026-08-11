# Rupeeruchana 📈

Kural tabanlı swing trade sinyallerini ve 4 saatte bir yapay zekâ ajan analizlerini
**açıkça** yayınlayan, ücretsiz bir ajan sitesi. Kara kutu yok: strateji, backtest
sonuçları ve tüm sinyal sicili halka açıktır.

> ⚠️ Eğitim ve şeffaflık projesidir — yatırım tavsiyesi değildir.

## Nasıl çalışır?

```
┌─────────────────────┐   her 4 saatte bir   ┌──────────────────┐
│ GitHub Actions cron │ ───────────────────► │ scripts/update.mjs│
└─────────────────────┘                      │  Binance verisi   │
                                             │  EMA50/RSI/EMA21  │
                                             │  ATR stop + 2,5R  │
                                             └────────┬─────────┘
                                                      ▼
                                             data/state.json ──► index.html (site)
```

- **Strateji (v3):** LONG = fiyat günlük EMA50 üstünde + EMA yükseliyor + 4s RSI(14)
  son 8 mumda <42'ye inmiş + 4s mumu EMA21 üstüne kesişti. SHORT = ayna görüntüsü.
  Stop = 2×ATR(14), hedef = 2,5R.
- **`scripts/update.mjs`** — analiz motoru. Binance halka açık API'sinden mum verisi
  çeker, kuralları hesaplar, sinyalleri/izleme listesini/ajan yorumlarını
  `data/state.json`'a yazar. Aktif sinyalleri sonraki turlarda stop/hedefe göre kapatır.
- **`scripts/selftest.mjs`** — sentetik veriyle 20 kural testi (`node scripts/update.mjs --selftest`).
  Workflow her koşuda önce bu testi çalıştırır; test geçmezse yayın yapılmaz.
- **`scripts/http.mjs`** — ağ katmanı: her dış istek 25 sn zaman aşımlı ve 2 tekrar
  denemeli. Zaman aşımı olmayan tek bir istek turu saatlerce asabilir (bkz. Bakım notları).
- **`index.html`** — tek dosyalık site. `state.json`'ı okur; üstte canlı fiyat
  marquee'si (ziyaretçinin tarayıcısı 30 sn'de bir Binance'den tazeler).

## Tarama evreni

| | Coinler | Sinyal üretir | Sanal cüzdan |
|---|---|---|---|
| **Çekirdek** | BTC · ETH · SOL · LINK · DOGE | evet | evet |
| **Altcoin radarı** | XRP · AVAX · ADA · POL · DOT · ATOM · NEAR · APT · ARB · OP · INJ · SUI · TIA · SEI · LTC · BCH · UNI · AAVE · FIL · RENDER | hayır | hayır |

Radar, aynı v3 kurallarıyla 20 altcoinin durumunu (sinyal / kurulum / aday) hesaplar
ve sitede ayrı bir tabloda gösterir, ama sinyal listesine girmez ve pozisyon açmaz.
Gerekçe: 4 pozisyonluk kontenjan düşük likiditeli alt sinyalleriyle dolarsa çekirdek
coinlerin sinyalleri kaçar ve sicil kıyaslanamaz hale gelir. Radardaki bir coini
gerçekten işleme dahil etmek istersen `scripts/update.mjs` içinde `ALTS`'tan çıkarıp
`COINS` ve `WATCH` listelerine ekle.

Sembol notu: MATIC artık **POL**, RNDR artık **RENDER**. Listeye coin eklerken
sembolün Binance'te `TRADING` durumunda olduğunu doğrula, yoksa o coin radardan
sessizce düşer (tur çökmez, konsola uyarı yazılır).

## Kurulum (bir kez)

1. GitHub'da `rupeeruchana` adında boş bir repo aç.
2. Bu klasörü push et:
   ```bash
   git init && git add -A && git commit -m "ilk yayın"
   git branch -M main
   git remote add origin https://github.com/<KULLANICI>/rupeeruchana.git
   git push -u origin main
   ```
3. Yayın — iki seçenekten biri:
   - **GitHub Pages:** repo → Settings → Pages → Source: `main` / root. Site:
     `https://<KULLANICI>.github.io/rupeeruchana/`
   - **Vercel:** vercel.com → Import repo → framework: *Other*, build komutu boş,
     output: root. (Her push'ta otomatik yayınlar.)
4. **Bildirimler:** telefonuna ücretsiz **ntfy** uygulamasını kur (App Store / Google Play), aç → Subscribe to topic → `rupeeruchana-sinyal-f28db1` yaz. Motor her yeni sinyalde ve her sinyal kapanışında (hedef/stop) anında bildirim yollar. Hesap gerekmez.
5. Actions'ı doğrula: repo → Actions → "Rupeeruchana 4 saatlik analiz" →
   **Run workflow** ile ilk analizi elle tetikle. Yeşil ✓ görünce sistem tam otonomdur.

## Geliştirme / yerel çalıştırma

Bağımlılık yok, kurulum gerekmez. Node 20+ yeterli (`AbortSignal.timeout` kullanılıyor).

```bash
node scripts/update.mjs --selftest        # ağsız kural testleri (20 test)
RUPEE_NO_NOTIFY=1 node scripts/update.mjs # gerçek turu telefona bildirim atmadan dene
git checkout -- data/                     # deneme turunun yazdığı veriyi geri al
```

## Notlar

- Cron UTC'dedir; `17 */4 * * *` ≈ günde 6 analiz. Tayland saatiyle (UTC+7)
  yaklaşık 03:17, 07:17, 11:17, 15:17, 19:17, 23:17.
- `data/state.json` elle de düzenlenebilir (ör. özel bir ajan yorumu eklemek için) —
  bir sonraki otomatik tur feed'in üstüne yenilerini ekler, eskiyi silmez (son 40 kayıt tutulur).
- KPI kutuları TradingView Strateji Testçisi'ndeki backtest sonuçlarıdır; canlı sicil
  sinyaller biriktikçe bu sayfada oluşur.

## Sanal Cüzdan — Otomatik İşlem Simülasyonu

Motor, kendi içinde **50$'lık sanal bir cüzdan** işletir (borsa yok, anahtar yok):
sinyal doğduğunda sanal pozisyon açar (işlem başına %2 = 1$ risk), her turda
gerçek piyasa verisiyle stop/hedefi kontrol eder, kapanışta PnL'i hesaplayıp
ntfy'a bildirir. LONG ve SHORT ikisi de desteklenir. Sicil: `data/autotrade.json`.

- Zincir testi: Actions → "Rupeeruchana 4 saatlik analiz" → Run workflow →
  `test_trade: true` → dar bantlı minik bir sanal BTC işlemi açılır; birkaç saat
  içinde doğal olarak kapanır ve iki bildirimi de (açılış + kapanış) doğrular.
- Aynı mumda hem stop hem hedef dokunursa tutucu varsayım uygulanır: STOP sayılır.
- Not: Binance testnet'i GitHub sunucularından coğrafi engelli (HTTP 451)
  olduğu için gerçek-borsa simülasyonu yerine bu yerleşik sanal cüzdan kullanılır.
  Canlı paraya geçiş, ayrı bir konum çözümü (ör. VPS) gerektirir.

## Bakım notları

**10 Ağustos 2026 kilitlenmesi ve alınan önlemler.** Motor 9 Ağustos 20:51'den 11
Ağustos'a kadar durdu. Zincir şöyleydi: `analyze` job'ı `environment: github-pages`
kullanıyordu; 10 Ağustos 02:34'te oluşan Pages deployment kaydı hiçbir durum almadan
askıda kaldı, ortam kilidi açılmadığı için job hiç başlayamadı ("queued"), ve
`concurrency: cancel-in-progress: false` yüzünden sonraki 8 tur sırada bekleyip
"higher priority waiting request" ile iptal oldu.

Kalıcı önlemler:

1. **Veri ile yayın ayrıldı.** `analyze` job'ında artık `environment:` yok; Pages
   yayınını ayrı bir `deploy` job'ı yapar. Ortam bir daha kilitlenirse site
   güncellenmez ama analiz ve commit çalışmaya devam eder.
2. **`cancel-in-progress: true`.** Yeni tur her zaman eski turu devirir. 4 saatte bir
   çalışan bir motorda taze veri, biten tur'dan önemlidir.
3. **Zaman aşımları.** Job'lara `timeout-minutes` (analiz 15, yayın 10), kritik
   adımlara ayrı sınırlar. Dikkat: `timeout-minutes` yalnızca job **başladıktan**
   sonra işler, sırada beklerken değil. Sırada takılmaya karşı koruyan şey
   `cancel-in-progress: true`'dur.
4. **Ağ zaman aşımı.** `scripts/http.mjs`: her istek 25 sn sınırlı, 429/5xx ve ağ
   hatalarında artan beklemeyle 2 kez tekrar denenir. Bildirimler 8 sn / tekrarsız.
5. **Süre stopu geçmişe doğru işlenir.** Motor günlerce durursa, süre stopu anından
   (giriş + 7 gün) sonraki stop/hedef dokunuşları artık sayılmaz; pozisyon süre
   dolduğu andaki kapanıştan kapatılır (`executor.scanBars`, testleri selftest'te).

**11 Ağustos 2026: aynı arıza ikinci kez.** Bu kez `pages.yml` çalıştırması (#13)
aynı şekilde askıda kaldı: `github-pages` ortamı için oluşturulan deployment kaydı
hiç durum almadı, job hiç başlamadı. Veri tarafı bu sefer hiç etkilenmedi (1. maddedeki
ayrım işe yaradı), ama site yayını dondu. Alınan ek önlem: **`pages.yml` tamamen
kaldırıldı.** Artık `github-pages` ortamına yalnızca tek bir yer talip: `update.yml`
içindeki `deploy` job'ı. O da zaten her turda tüm siteyi (`path: .`) yayınlıyor, yani
ikinci workflow hiçbir şey eklemiyordu, sadece kilitlenme yüzeyini iki katına çıkarıyordu.

> Elle yaptığın bir değişikliği (ör. `index.html`) hemen yayınlamak istersen:
> Actions → "Rupeeruchana 4 saatlik analiz" → **Run workflow**. Beklersen bir sonraki
> 4 saatlik tur zaten yayınlar.

**Motor durdu mu, nasıl anlarım?** `data/state.json` içindeki `updated` alanı 4-5
saatten eskiyse tur atlanmış demektir. Actions sekmesinde "queued" durumda asılı bir
çalıştırma varsa iptal et; ayrıca Settings → Environments → github-pages altında
askıda deployment kalmadığını kontrol et.
