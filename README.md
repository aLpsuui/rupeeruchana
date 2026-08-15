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

### İşlem maliyetleri

Her kapanışta brütten iki maliyet düşülür ve ikisi de kayda ayrı yazılır
(`pnlGross`, `feeUsd`, `fundingUsd`, `pnl` = net):

| | Oran | Nasıl işler |
|---|---|---|
| Komisyon | %0,05 tek yön | Giriş ve çıkış piyasa emri sayılır, gidiş dönüş 2× |
| Fonlama | %0,01 / 8 saat | 00:00, 08:00, 16:00 UTC sınırları geçildikçe |

Örnek: 937$ nominal, 2 gün tutulan bir işlemde komisyon 0,94$ + fonlama 0,56$ =
1,50$. Hedefe giden bir işlemin brüt 50$ kârı net 48,50$'a iner. Süre stopuna kadar
(7 gün) tutulan bir işlemde fonlama tek başına komisyonun iki katını geçer.

> **13 Ağustos 2026'da neden eklendi.** Simülasyon o güne kadar hiçbir maliyet
> saymıyordu, yani sonuçlar gerçekte olduğundan iyi görünüyordu. Backtest'in kâr
> faktörü 1,17 gibi ince bir avantaj gösteriyor; böyle bir sistemde komisyon ve
> fonlama sonucu belirleyebilir. Canlıya geçme kararı maliyetsiz veriye dayanamaz.

Fonlama tutucu modellenir: gerçek oran değişkendir ve bazen lehimize olur, ama
vadeli fonlama verisi (`fapi.binance.com`) GitHub sunucularından coğrafi engelli.
Bu yüzden her periyotta tipik oran kadar **aleyhe** ödeme yapıldığı varsayılır.
Gerçek veriye erişim sağlanırsa (ör. VPS'te canlı yürütücü) bu varsayım
`executor.tradeCosts` içinde tek yerden değiştirilebilir.

### MFE/MAE ölçümü

Her kapanan kayda üç alan yazılır: `mfeR` (kapanana kadar **lehe** en fazla kaç R
gidildi), `maeR` (**aleyhe** en fazla kaç R) ve `bars` (kaç saatlik mum tutuldu).
Ölçüm `executor.scanBars` içinde, çıkış mumu da dahil edilerek yapılır.

Bunun tek bir amacı var: "hedefe niye ulaşılamıyor" sorusunu tahminle değil veriyle
cevaplamak. `executor.summarize` sicilden şu teşhis satırını üretir: **hedefe
ulaşamayan işlemler ortalama kaç R'ye kadar gitti.** Bu sayı 2,5R'ye yakınsa sorun
sabırda veya süre stopundadır (hedefin kılpayı kaçırılıyor). 1R civarındaysa hedef
fazla iddialıdır, 1,5R'ye çekmek ya da iz süren stop koymak gerekir. 0,5R'nin
altındaysa sorun hedefte değil girişte demektir.

Özetler `data/autotrade.json` içinde `stats`, radar için `data/state.json` içinde
`altStats` olarak durur ve sitede teşhis satırı olarak gösterilir. Radar 20 coinle
çalıştığı için bu veri sanal cüzdandan çok daha hızlı birikir.

Radar sinyalleri `data/state.json` içinde `altSignals` olarak kalıcı tutulur: tetik
geldiğinde açılır, sonraki turlarda mum taramasıyla stop/hedef kontrol edilir, kapanır.
Böylece "bu kurallar altcoinlerde işe yarıyor mu" sorusu sicille cevaplanabilir. Bu
kayıtlar bildirim yollamaz ve sanal cüzdana dokunmaz.

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
4. **Bildirimler:** aşağıdaki "Bildirimler" bölümüne bak. Telegram (özel) veya ntfy
   (hesapsız) kullanılabilir; ikisi de ücretsizdir.
5. Actions'ı doğrula: repo → Actions → "Rupeeruchana 4 saatlik analiz" →
   **Run workflow** ile ilk analizi elle tetikle. Yeşil ✓ görünce sistem tam otonomdur.

## Dip Radarı (`scripts/dipradar.mjs`)

Binance'teki **tüm** USDT çiftlerini (~415 coin) tarar ve tek bir koşulu arar:

> fiyat günlük EMA50'nin **%35+ altında** VE **son 60 günün en düşük kapanışı**

Sinyal üretmez, işlem açmaz, bildirim dışında hiçbir şeye dokunmaz. Bulduğu adayı
30 gün takip eder ve kendi isabetini `data/dipradar.json` içinde ölçer.

**Koşul neden bu (15 Ağu 2026, 404 coin / 117.872 örnekle ölçüldü):**

| | Rastgele giriş | Dip koşulu |
|---|---|---|
| 30 gün ortalama getiri | −%8,8 | −%1,8 |
| 30 günde artıda biten | %27 | %36 |
| 30 günde +%50 gören | %11,5 | **%20,2** |
| 30 günde +%100 gören | %3,7 | **%6,5** |

İkiye katlama ihtimali yaklaşık iki katına çıkıyor. **Ama medyan hâlâ −%7,3:** bu bir
piyango dağılımıdır, çoğu aday kanar, 15'te biri patlar. Küçük ve eşit pozisyonlar,
hızlı zarar kesme ve iz süren çıkış olmadan bu dağılım para kazandırmaz.

**Test edilip elenen varyantlar** (kayda değer, çünkü sezgiye aykırılar):

| Varyant | Örnek | +%100 gören | Karar |
|---|---|---|---|
| Sadece dip koşulu | 1.925 | %6,5 | **kullanılıyor** |
| Dip + hacim 2x filtresi | 349 | %6,3 | elendi, iyileştirmedi |
| Dip sonrası tepe kırılımı teyidi | 622 | %7,2 ama ortalama −%6,0 | elendi |
| "Sessiz yüksek hacim = birikim" hipotezi | 131 | — | **çürütüldü**, üç mum tipi de aynı |

Ölçüm uyarısı: tarama yalnızca hâlâ listede olan coinleri görür, sıfırlanıp delist
olanlar dışarıdadır. Yani mutlak rakamlar iyimser; göreli üstünlük geçerlidir.

Motor turuyla aynı workflow'da ama ayrı adımda çalışır ve `continue-on-error: true`
ile korunur: radar düşerse analiz motoru etkilenmez.

## Takvim (`scripts/takvim.mjs`)

Üç kaynak, güvenilirlik sırasına göre:

1. **Sembol farkı (asıl kaynak).** Her turda `exchangeInfo`'daki USDT çiftleri bir
   öncekiyle karşılaştırılır. Yeni çift = yeni listeleme, kaybolan çift = delist.
   Tamamen mekanik, hiçbir duyuruya bağlı değil, motorla aynı uçtan (
   `data-api.binance.vision`) çalışır, yani coğrafi engel riski yok.
2. **Duyurular.** Binance CMS duyuru listesi. Daha erken haber verir ama
   `www.binance.com` GitHub sunucularından engellenebilir; erişilemezse sessizce
   atlanır ve 1. kaynak işi görmeye devam eder. Durum `takvim.json` içinde
   `duyuruDurum` alanında ve sitede görünür.
3. **Token kilitleri.** `data/unlocks.json` içinde **elle** tutulur. Ücretsiz ve
   güvenilir bir kilit takvimi API'si yok: DefiLlama'nın emisyon ucu 15 Ağustos
   2026'da ücretli oldu (HTTP 402). İlgilenilen coinler tokenomics.com veya
   cryptorank.io'dan bakılıp bu dosyaya eklenir. 14 gün içindeki kilitler uyarı
   olarak gösterilir.

> **Beklenti ayarı.** Takvim büyük ihtimalle pump BULDURMAZ, tuzaktan KAÇIRTIR.
> ACE örneğinde takvimdeki tek olay 18 Ağustos token kilidiydi ve aşağı yönlüydü:
> kilit açılınca arz artar. Bu modülün değeri kazandırmakta değil, kaybettirmemekte.

## Bildirimler

`scripts/notify.mjs` iki kanalı sırayla dener: **Telegram varsa oraya**, yoksa (ya da
Telegram isteği başarısız olursa) **ntfy'a**. Böylece kurulum yarım kalsa bile
bildirimler kesilmez. İkisi de ücretsizdir.

**Telegram kurulumu** (özel kanal, sadece sen görürsün):

1. Telegram'da `@BotFather` → `/newbot` → isim ve `_bot` ile biten kullanıcı adı ver
   → sana bir token verir.
2. Oluşan botu aç ve `/start` yaz. Bu şart: Telegram, botun ilk mesajı kullanıcıya
   göndermesine izin vermez.
3. `@userinfobot`'a yaz, verdiği `Id` senin chat ID'ndir.
4. GitHub → Settings → Secrets and variables → Actions → New repository secret:
   `TELEGRAM_TOKEN` ve `TELEGRAM_CHAT_ID`. Depoda hiçbir yerde durmaz.
5. Doğrula: Actions → Run workflow → `test_notify: true`.

**ntfy** (yedek, hesapsız): telefona ntfy uygulamasını kur → Subscribe to topic →
`rupeeruchana-sinyal-f28db1`. Not: ntfy konuları herkese açıktır, konu adını bilen
okuyabilir ve yazabilir. Gizlilik istiyorsan Telegram'ı kullan.

**Radar (altcoin) bildirimleri açıktır** (`update.yml` → `RUPEE_RADAR_NOTIFY: '1'`).
Radar mesajları "📡 RADAR" başlığıyla gelir, hem açılışta hem kapanışta; kapanışta
sonucu, MFE/MAE'yi ve radar sicilini yazar. Bu sinyaller sanal cüzdana pozisyon
açmaz. Çok fazla bildirim gelirse değeri `'0'` yapmak yeterli.

> **12 Ağustos 2026'da bulunan sessiz arıza.** Bildirimler ntfy'ın başlık ucuna
> (HTTP header) yazılıyordu. Tüm başlıklar emoji ile başladığı için istek daha
> kurulurken "Cannot convert argument to a ByteString" hatası veriyordu; hata da
> yutulduğu için pratikte **hiçbir bildirim gitmiyordu ve bu hiçbir yerde
> görünmüyordu.** Çözüm: ntfy'ın JSON ucu kullanılıyor, başlık gövdede gidiyor.
> Ders: sessizce yutulan her `catch` bloğu bir arızayı gizleyebilir; bu yüzden
> `--test-notify` modu eklendi.

## Geliştirme / yerel çalıştırma

Bağımlılık yok, kurulum gerekmez. Node 20+ yeterli (`AbortSignal.timeout` kullanılıyor).

```bash
node scripts/update.mjs --selftest        # ağsız kural testleri (44 test)
node scripts/update.mjs --test-notify     # bildirim kanalını dene (tek mesaj yollar)
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

Motor, kendi içinde **1.000$'lık sanal bir cüzdan** işletir (borsa yok, anahtar yok):
sinyal doğduğunda sanal pozisyon açar, her turda gerçek piyasa verisiyle stop/hedefi
kontrol eder, kapanışta PnL'i hesaplayıp ntfy'a bildirir. LONG ve SHORT ikisi de
desteklenir. Sicil: `data/autotrade.json`.

### Boyutlama: sabit risk

`executor.sizeTrade` her işlemde **bakiyenin %2'sini** riske eder ve adedi stop
mesafesinden türetir: `adet = risk$ / |giriş − stop|`. Kaldıraç yalnızca teminat
mekaniğidir, risk birimi değildir. Tek fren teminat kontenjanıdır: 4 pozisyonluk
sistemde tek işlem bakiyenin dörtte birinden fazla teminat tutamaz, gerekirse
pozisyon orantılı küçülür.

> **12 Ağustos 2026'da neden değişti.** Önceki mod her işlemde sabit 10$ teminat ×
> 10x = 100$ nominal açıyordu. Bu modda gerçek risk stop mesafesiyle değişiyordu:
> dar stopta ~2$, geniş stopta ~5$. 48$'lık bir bakiyede bu işlem başına %4-10 risk
> ve 4 pozisyon açıkken hesabın beşte biriyle yarısı arası maruziyet demekti. İnce
> avantajlı bir sistemde değişken risk beklentiyi ölçülemez kılar. Aynı tarihte
> başlangıç sermayesi 1.000$ yapıldı: sonuçlar sabit yüzdeli riskle zaten ölçekten
> bağımsız, ama 50$'lık bakiyede pozisyonlar gerçek borsanın minimum emir
> büyüklüğünün altında kalıyor ve komisyon/fonlama modellemesi anlamsızlaşıyordu.
> Eski kayıtlar `legacyClosed` altında saklanıyor; farklı boyutlamayla açıldıkları
> için yeni sicille birlikte istatistiğe katılmazlar.

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
