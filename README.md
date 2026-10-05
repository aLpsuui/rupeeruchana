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
- **`index.html`** — site. `state.json`'ı okur; üstte canlı fiyat marquee'si
  (ziyaretçinin tarayıcısı 30 sn'de bir Binance'den tazeler).
- **`js/kat.js`** — "Ajan Katı": modülleri bir piksel ofisi olarak çizen canvas.
  Her masa gerçek bir script (Tarayıcı, Trend Ajanı, Altcoin Radarı, Dip Radarı,
  Risk Bekçisi, Takvim, Gerçek Cüzdan + cam odada Şef = bildirim katmanı). Karakterler
  `state.json` / `dipradar.json` / `takvim.json` / `gercek.json` ile hareket eder:
  aktif sinyal varsa masada "CANLI" tabelası yanar, son tur 7 saatten eskiyse herkes
  hayalet olur ve "tur gecikti" yazar (eşik 7 saat, çünkü GitHub'ın 4 saatlik cron'u
  pratikte 5,5-6 saat arayla çalışıyor; 5 saat yanlış alarm veriyordu). Bir masaya tıklamak hangi script olduğunu ve
  son turda ne yaptığını gösterir. Bağımlılık yok. Fikir: pixel-grokbots (MIT).

## Tarama evreni

| | Coinler | Sinyal üretir | Sanal cüzdan |
|---|---|---|---|
| **Ana liste** | BTC · ETH · XRP · TRUMP | evet | evet (gerçek cüzdan) |
| **Altcoinler** | BNB · SOL · LINK · DOGE · AVAX · ADA · POL · DOT · ATOM · NEAR · APT · ARB · OP · INJ · SUI · TIA · SEI · LTC · BCH · UNI · AAVE · FIL · RENDER | evet | evet (gerçek cüzdan) |

Radar, aynı v3 kurallarıyla 21 altcoinin durumunu (sinyal / kurulum / aday) hesaplar,
sitede ayrı bir tabloda gösterir ve kendi sicilini tutar, ama sinyal listesine girmez
ve pozisyon açmaz. Gerekçe: 4 pozisyonluk kontenjan düşük likiditeli alt sinyalleriyle
dolarsa çekirdek coinlerin sinyalleri kaçar ve sicil kıyaslanamaz hale gelir. Radardaki
bir coini gerçekten işleme dahil etmek istersen `scripts/update.mjs` içinde `ALTS`'tan
çıkarıp `COINS` ve `WATCH` listelerine ekle, sonra `index.html` içindeki `PAIRS`
marquee listesini aynı sıraya getir.

### Neden evren geniş tutuluyor (29 Eylül 2026'da ölçüldü)

Evren bir gün boyunca BTC + XRP + TRUMP'a indirildi, sonra aynı gün geri açıldı.
Sebep sayısal: sanal sicildeki 18 işlemde işlem başına **+0,315R** var, ama işlemlerin
standart sapması 1,76R olduğu için standart hata **0,414R**, yani **t = 0,76**. Edge
istatistiksel olarak sıfırdan ayırt edilemiyor; anlamlılık için yaklaşık **125 işlem**
gerekiyor. 5 çekirdek coinle mevcut hız ayda ~12 işlem, yani ~11 ay. Üç coinle bu süre
~25 aya çıkıyordu. Evreni daraltmak odağı değil, **öğrenme hızını** kesiyordu.

Karar: sicil 100+ işleme ulaşana kadar evren geniş kalır. TRUMP radara eklendi, böylece
kendi sicilini biriktirir ama çekirdeğin pozisyon kontenjanını tüketmez.

Not: dip radarı (`scripts/dipradar.mjs`) bu evrenin dışında, Binance'teki tüm USDT
çiftlerini tarar. İşi sinyal üretmek değil, dipteki adayları listelemek.

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

## Backtest (`scripts/backtest.mjs`) ve TradingView karşılığı

Backtest motorun **kendi** fonksiyonlarını çağırır (`update.mjs → analyzeCoin`,
`executor.mjs → scanBars / sizeTrade / tradeCosts`); kuralların kopyası yoktur, motor
değişirse backtest de onunla değişir. Geçmişi 4 saatlik kapanış kapanış yeniden oynatır
ve her kapanışta motorun o anda göreceği pencereyi kurar (119 kapanmış gün + 259 kapanmış
4s mum). Komisyon, fonlama ve sanal cüzdanın 4 pozisyon kontenjanı dahildir.

```bash
node scripts/backtest.mjs                                   # çekirdek 5 coin, 2022 → bugün
node scripts/backtest.mjs --coins all                       # çekirdek + radar (25 coin)
node scripts/backtest.mjs --coins BTC,ETH --from 2025-01-01 --to 2026-01-01
```

Çıktı: `research/backtest-<etiket>.json` ve `-trades.csv`. Mum verisi `research/cache/`
altında tutulur (git dışı). `data/` klasörüne ve bildirimlere dokunmaz. `update.mjs`
yalnızca doğrudan çalıştırıldığında tur yapar; içe aktarılınca hiçbir şey çalıştırmaz.

> **14 Eylül 2026: canlı motorla doğrulandı.** Canlı sicildeki 19 çekirdek kaydın 19'u da
> (17 kapanmış + 2 açık) backtest'te aynı giriş, stop ve sonuçla çıkıyor. Backtest'te olup
> canlıda olmayan 3 işlemin üçü de motorun çalışmadığı turlara denk geliyor: 10 Ağustos
> kilitlenmesi, 27 Ağustos 12:17–20:17 ve 9 Eylül 08:17 turları (GitHub cron'u zamanlanmış
> turları atlayabiliyor). Yani backtest, canlı motorun o dönemde yapacağı işlemleri gösterir.
> Ders: atlanan bir tur, o 4s mumunda oluşan sinyali kalıcı olarak kaçırtır.

> **14 Eylül 2026: ilk uzun dönem ölçümü** (5 çekirdek coin, Ocak 2022 → Eylül 2026, 703
> işlem). Maliyetler sonrası kâr faktörü **1,00**, isabet %19,5. Sanal cüzdan 1.000$ → 679$,
> en büyük düşüş %62. Yıllara göre net R: 2022 +15,8 · 2023 −6,1 · 2024 +15,6 · 2025 +12,5 ·
> **2026 −37,4 (PF 0,56)**. Sitedeki KPI kutuları (29 işlem, PF 1,17) bu tabloyu temsil
> etmiyor. Hedefe ulaşamayan işlemler ortalama yalnızca 0,86R lehe gidiyor; MFE/MAE
> bölümündeki teşhise göre bu "hedef fazla iddialı" bölgesi. Ama bu bir hipotezdir: bir
> değişiklik ancak ayar yapılan dönemden ayrı bir test döneminde de iyileşme gösterirse
> canlıya alınır, yoksa geçmişe uydurulmuş olur.

> **16 Eylül 2026: varyant taraması — sorun parametrelerde değil.** 17 varyant (hedef
> 1,5/2/3R, stop 1,5–3×ATR, RSI eşikleri 38/62 ve 45/55, RSI penceresi 4/12 mum, süre
> stopu 3/14 gün, başa baş stopu +1R/+1,5R, BTC rejim filtresi) ayar dönemi 2022–2024 ve
> test dönemi 2025–bugün ayrımıyla denendi: `node scripts/research.mjs`, sonuçlar
> `research/varyantlar-2026-09-16.json`. **Hiçbiri test döneminde artıya geçmedi.**
> MFE teşhisinin işaret ettiği "hedefi 1,5R'ye çek" fikri en kötülerden biri çıktı
> (test −54,9R; temel −29,1R): erken alınan küçük kârlar kaybedenleri karşılamıyor.
> Teşhis satırı bir hipotez üretir, cevabı ancak bu tarama verir.
>
> İstatistik daha da net. 703 işlemde işlem başına ortalama **0,000R** (t = 0,01). Ayar
> dönemi +0,06R (t = 0,87), test dönemi −0,09R (t = −1,06): ikisi de gürültüden ayırt
> edilemez. Anlamlı tek sayı 2026: −0,32R (t = −2,85). Yani v3'ün ölçülebilir bir
> avantajı hiçbir dönemde olmadı; 2022 ve 2024'teki artılar da tesadüf aralığında.
> Sıradaki adım parametre oynatmak değil, kuralın kendisini değiştirmektir — ve yeni
> kural da aynı ayar/test ayrımından geçmeden canlıya alınmaz.

**TradingView karşılığı:** `strategy/rupeeruchana-v3.pine` aynı kuralların Pine v6
hâlidir; `BINANCE:<COIN>USDT` 4 saatlik grafikte çalışır. Günlük EMA50 motorun 119 günlük,
SMA ile tohumlanan penceresiyle hesaplanır ve "kapanmış gün" 4s mumunun kapanış anına
göre seçilir. İkisi de `ta.ema` veya sabit `[1]` kaydırmasıyla birebir tutmaz. Strateji
Testçisi'nin işlem listesi aynı dönemin `-trades.csv` dosyasıyla karşılaştırılır.
Kapatılamayan küçük farklar dosyanın başında yazılıdır (aynı saatte stop + hedef, süre
stopunun çıkış fiyatı, fonlama).

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

## Gerçek Cüzdan (2 Ekim 2026'dan beri)

Sanal cüzdan **kaldırıldı**; tek cüzdan var, gerçek: **50$**. Emirleri insan girer, defteri
`scripts/gercek.mjs` tutar (`data/gercek.json`), site ve tur özeti oradan okur. Kurallar
sanal cüzdanla aynı maliyet modelini kullanır (`executor.tradeCosts`): işlem başına %2 risk
(1$), izole 2x, aynı anda en fazla 3 pozisyon, **BTC istisnası** (borsa minimumu 0,001 BTC ≈ 85$ olduğu için BTC işleminde risk ~%5,6, izole 5x), çekirdek + radar sinyallerinin **hepsi geliş sırasıyla** (seçmece yok;
kontenjan doluysa `atla` ile kaydedilir), 7 gün süre stopu, ekleme ve stop taşıma yok, kasa
35$'a inerse dur. Tur özetinde yalnızca kullanıcının açık işlemleri listelenir; sistemin izlediği sinyaller mesajda gösterilmez, sonuçları "Sinyal sicili" satırında sayılır.

```
node scripts/gercek.mjs oner  GİRİŞ STOP                      # %2 risk için pozisyon büyüklüğü
node scripts/gercek.mjs ac    LTC LONG 95.2 92.1 103.0 31 radar  # açılış (pozisyon $, kaynak)
node scripts/gercek.mjs kapat LTC 103.0 hedef                 # kapanış (sebep: hedef|stop|sure|elle)
node scripts/gercek.mjs atla  ARB LONG kontenjan dolu          # alınmayan sinyal de veridir
node scripts/gercek.mjs durum
```

Sistemin kendi performansı sanal cüzdan olmadan da ölçülüyor: `state.json` içindeki sinyal
sicili (HEDEF ✓ / STOP ✗ / SÜRE ⏱) otomatik birikir, tur özetinde "Sinyal sicili" satırı olarak gider.

## Canlı yürütücü (VPS) — otomatik işlem + sürekli izleme

`scripts/live-executor.mjs` VPS'te tek süreç olarak çalışır (systemd, `vps-setup.sh` kurar):

- **Her 4 saatlik mum kapanışında** (00/04/08/12/16/20 UTC + 1 dk) motoru çalıştırır,
  `data/`'yı GitHub'a push eder (site oradan yayınlanır; GitHub cron kapatıldı, workflow
  push'ta yalnızca yayınlar, elle tetiklemede yedek motor), yeni SİNYAL'leri (çekirdek +
  radar, geliş sırasıyla) Binance USDⓈ-M vadeli hesabına yansıtır: piyasa giriş + stop-market
  + take-profit (closePosition), izole 2x. Kurallar `gercek.mjs` içindeki `KURAL`'dan gelir.
- **Her dakika:** stop/hedef dolumlarını borsadan okur ve `gercek.json`'a gerçek komisyonla
  yazar, 7 günlük süre stopunu uygular, canlı panoyu üretir (`data/canli.json` + `127.0.0.1:8787`,
  Caddy arkasında HTTPS), Telegram'a yalnızca değişim olunca yazar (emir doldu, atlandı,
  "kapanışa ≤ 30 dk kala mum şimdi kapansa sinyal olur").
- **Modlar** (`RUPEE_MODE`): `dry` emir yok, "açardım" raporu; `testnet` sahte para, gerçek emir
  akışı; `live`. Önce 3 tur `dry`, sonra canlı. **Durdurma:** repo kökünde `DUR` dosyası →
  yeni giriş yok (açıklar borsadaki emirleriyle kapanır).
- **Sinyal 4 saatte bir, izleme sürekli.** Kural kapalı 4s mum üstüne tanımlıdır; pano
  "şimdi kapansa ne olurdu"yu gösterir, bu ısınma göstergesidir, sinyal değildir.
- **Güvenlik:** API anahtarı yalnızca Futures yetkili, para çekme kapalı, IP kısıtı VPS;
  `.env` sunucuda, git'te değil. Stop/hedef konamazsa pozisyon anında kapatılır.
- Sinyalden %1'den fazla uzaklaşmış fiyatta giriş yapılmaz, "atlandı" yazılır. Borsa minimumu
  riski kuralın %60 üstüne çıkarıyorsa atlanır. BTC her zaman atlanır.

## Sanal Cüzdan — Otomatik İşlem Simülasyonu (ARŞİV, 2 Ekim 2026'da kaldırıldı)

> 12 Ağustos - 2 Ekim 2026 arasında çalıştı: 18 kapanan işlem, 7 hedef / 11 stop, +93,58$
> (1.000$ başlangıç). Kayıt `data/autotrade.json` içinde duruyor, motor artık yazmıyor.
> Aşağısı tarihçe için saklandı.


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
