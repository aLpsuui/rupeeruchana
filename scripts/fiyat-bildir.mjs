// ============================================================================
// Rupeeruchana — tek seferlik fiyat bildirimi
// Tarama evrenindeki (COINS) coinlerin güncel fiyatını ve 24 saatlik değişimini
// telefona yollar. Analiz YAPMAZ, sinyal üretmez, state.json'a dokunmaz.
//
// Kullanım:
//   node scripts/fiyat-bildir.mjs                      → ntfy yedek kanalına
//   TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/fiyat-bildir.mjs
//                                                      → Telegram'a
//   RUPEE_NO_NOTIFY=1 node scripts/fiyat-bildir.mjs    → sadece ekrana yaz
// ============================================================================

import { COINS } from './update.mjs';
import { fetchJson } from './http.mjs';
import { notify, channel } from './notify.mjs';

const API = 'https://data-api.binance.vision/api/v3';

// Türkçe biçim: binlik ayırıcı nokta, ondalık virgül.
function px(n) {
  const v = Number(n);
  const basamak = v >= 1000 ? 0 : v >= 10 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString('tr-TR', { minimumFractionDigits: basamak, maximumFractionDigits: basamak });
}

const q = encodeURIComponent(JSON.stringify(COINS.map(c => c + 'USDT')));
const veri = await fetchJson(`${API}/ticker/24hr?symbols=${q}`, 'fiyat bildirimi');

const satirlar = veri.map(d => {
  const coin = d.symbol.replace('USDT', '');
  const chg = Number(d.priceChangePercent);
  const ok = chg >= 0 ? '▲' : '▼';
  return `${coin}  $${px(d.lastPrice)}  ${ok} ${Math.abs(chg).toFixed(2).replace('.', ',')}%  (24s ▲ ${px(d.highPrice)} · ▼ ${px(d.lowPrice)})`;
});

const saat = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'short' });
const baslik = `💱 ${COINS.join(' · ')} — güncel fiyatlar`;
const govde = `${satirlar.join('\n')}\n\n${saat} (TR) · Binance spot · yalnızca fiyat bilgisidir, sinyal değildir.`;

console.log(`kanal: ${channel()}`);
console.log(baslik);
console.log(govde);
await notify(baslik, govde, 'moneybag');
console.log('bildirim gönderildi.');
