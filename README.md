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
- **`scripts/selftest.mjs`** — sentetik veriyle kural mantığı testi (`node scripts/update.mjs --selftest`).
  Workflow her koşuda önce bu testi çalıştırır; test geçmezse yayın yapılmaz.
- **`index.html`** — tek dosyalık site. `state.json`'ı okur; üstte canlı fiyat
  marquee'si (ziyaretçinin tarayıcısı 30 sn'de bir Binance'den tazeler).

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

## Notlar

- Cron UTC'dedir; `17 */4 * * *` ≈ günde 6 analiz.
- `data/state.json` elle de düzenlenebilir (ör. özel bir ajan yorumu eklemek için) —
  bir sonraki otomatik tur feed'in üstüne yenilerini ekler, eskiyi silmez (son 40 kayıt tutulur).
- KPI kutuları TradingView Strateji Testçisi'ndeki backtest sonuçlarıdır; canlı sicil
  sinyaller biriktikçe bu sayfada oluşur.

## Testnet Otomatik İşlem (sahte para)

Motor, Binance **Spot Testnet** üzerinde LONG sinyallerini otomatik işler:
market alış + borsada OCO (stop + hedef). Gerçek para SÖZ KONUSU DEĞİLDİR.

Kurulum (bir kez):
1. https://testnet.binance.vision → GitHub ile giriş → **Generate HMAC_SHA256 Key**
   → API Key + Secret'ı kopyala.
2. Repo → Settings → Secrets and variables → Actions → **New repository secret**:
   - `BINANCE_TESTNET_KEY` = API Key
   - `BINANCE_TESTNET_SECRET` = Secret
3. Zincir testi: Actions → "Rupeeruchana 4 saatlik analiz" → Run workflow →
   `test_trade: true` → minik bir BTC testnet işlemi açılır, ntfy bildirimi gelir.

Notlar: Secret'lar yoksa modül tamamen devre dışıdır. Spot testnet short
desteklemez — SHORT sinyaller yalnızca bildirim olarak kalır. Sicil:
`data/autotrade.json`.
