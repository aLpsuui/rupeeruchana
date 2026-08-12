// ============================================================================
// Rupeeruchana — bildirim katmanı
// Öncelik: Telegram (özel kanal) → ntfy (yedek).
// Telegram anahtarları tanımlıysa oraya gider; tanımlı değilse ya da Telegram
// isteği başarısız olursa ntfy'a düşer. Böylece kurulum yarım kalsa bile
// bildirimler kesilmez.
//
// Kurulum (GitHub → Settings → Secrets and variables → Actions):
//   TELEGRAM_TOKEN    @BotFather'ın verdiği bot token'ı
//   TELEGRAM_CHAT_ID  @userinfobot'un verdiği sayı
// Anahtarlar depoda değil, yalnızca Actions ortamında bulunur.
// ============================================================================

import { httpFetch } from './http.mjs';

const NTFY_TOPIC = 'rupeeruchana-sinyal-f28db1';
const TG_API = 'https://api.telegram.org';

const tgToken = () => process.env.TELEGRAM_TOKEN || '';
const tgChat  = () => process.env.TELEGRAM_CHAT_ID || '';

// Hangi kanal etkin? (log ve test için)
export function channel() {
  if (process.env.RUPEE_NO_NOTIFY === '1') return 'kapalı';
  return (tgToken() && tgChat()) ? 'telegram' : 'ntfy';
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(title, body) {
  const r = await httpFetch(`${TG_API}/bot${tgToken()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: tgChat(),
      text: `<b>${esc(title)}</b>\n${esc(body)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }, { timeoutMs: 8_000, retries: 1 });
  if (!r.ok) {
    // Telegram hata gövdesi teşhis için değerlidir (yanlış chat_id, /start
    // atılmamış bot, geçersiz token hepsi buradan anlaşılır).
    let detay = '';
    try { detay = JSON.stringify(await r.json()).slice(0, 200); } catch {}
    throw new Error(`telegram HTTP ${r.status} ${detay}`);
  }
}

// ntfy'ın JSON ucu kullanılır, başlık ucu DEĞİL.
// Gerekçe (12 Ağu 2026'da bulunan sessiz arıza): başlıklar HTTP header'ına
// yazıldığında emoji ve Türkçe karakterler ByteString'e sığmıyor ve fetch
// isteği daha kurulurken hata veriyordu. Tüm başlıklar emoji ile başladığı
// için pratikte hiçbir bildirim gitmiyordu, hata da yutulduğu için sessizdi.
async function sendNtfy(title, body, tags) {
  const r = await httpFetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message: body,
      tags: tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : [],
      priority: 4,
    }),
  }, { timeoutMs: 8_000, retries: 0 });
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
}

// Bildirim asla turu bloke etmemeli: kısa zaman aşımı, hata yutulur.
export async function notify(title, body, tags = 'chart_with_upwards_trend') {
  if (process.env.RUPEE_NO_NOTIFY === '1') {
    console.log(`[bildirim atlandı] ${title} — ${body}`);
    return;
  }
  if (tgToken() && tgChat()) {
    try { await sendTelegram(title, body); return; }
    catch (e) { console.error('telegram gönderilemedi, ntfy denenecek:', e.message); }
  }
  try { await sendNtfy(title, body, tags); }
  catch (e) { console.error('bildirim gönderilemedi:', e.message); }
}
