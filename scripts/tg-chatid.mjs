// ============================================================================
// Telegram teşhis: token geçerli mi, bot kim, ve DOĞRU chat ID kaç?
// "chat not found" hatasının iki sebebi vardır ve bu betik ikisini ayırt eder:
//   1) Kullanıcı bota hiç /start yazmamıştır  → getUpdates boş döner
//   2) TELEGRAM_CHAT_ID yanlıştır             → getUpdates dolu, ama eşleşmiyor
// Token loga yazılmaz; GitHub zaten gizli değerleri maskeler.
// ============================================================================

import { fetchJson } from './http.mjs';

const token = process.env.TELEGRAM_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const API = 'https://api.telegram.org';

if (!token) {
  console.error('TELEGRAM_TOKEN tanımlı değil — GitHub Secrets kontrol et.');
  process.exit(0);
}

// 1) Token geçerli mi?
try {
  const me = await fetchJson(`${API}/bot${token}/getMe`, 'getMe');
  console.log(`✓ Token geçerli. Bot: @${me.result.username} (${me.result.first_name})`);
} catch (e) {
  console.error(`✗ Token GEÇERSİZ: ${e.message}`);
  console.error('  Çözüm: @BotFather → /mybots → botunu seç → API Token → güncel değeri');
  console.error('  GitHub Secrets içindeki TELEGRAM_TOKEN alanına yapıştır.');
  process.exit(0);
}

// 2) Bota yazılmış mı, hangi chat'ler görünüyor?
let updates = [];
try {
  const u = await fetchJson(`${API}/bot${token}/getUpdates`, 'getUpdates');
  updates = u.result || [];
} catch (e) {
  console.error(`getUpdates başarısız: ${e.message}`);
  process.exit(0);
}

const chats = new Map();
for (const u of updates) {
  const c = u.message?.chat || u.edited_message?.chat || u.channel_post?.chat;
  if (c) chats.set(String(c.id), c);
}

if (!chats.size) {
  console.error('✗ Bot hiç mesaj almamış.');
  console.error('  Sebep: Telegram, kullanıcı botla konuşmayı başlatmadan botun mesaj');
  console.error('  göndermesine izin vermez. "chat not found" hatasının sebebi budur.');
  console.error('  ÇÖZÜM: Telegram\'da kendi botunu aç ve /start yaz, sonra bu testi');
  console.error('  tekrar çalıştır.');
  process.exit(0);
}

console.log(`\nBotla konuşan chat'ler (${chats.size} adet):`);
for (const [id, c] of chats) {
  const ad = [c.first_name, c.last_name, c.username ? '@' + c.username : '', c.title]
    .filter(Boolean).join(' ');
  console.log(`  chat_id = ${id}   (${c.type}${ad ? ' · ' + ad : ''})`);
}

if (!chatId) {
  console.log('\nTELEGRAM_CHAT_ID tanımlı değil. Yukarıdaki chat_id değerini Secrets\'a ekle.');
} else if (chats.has(chatId)) {
  console.log('\n✓ Mevcut TELEGRAM_CHAT_ID yukarıdakilerden biriyle eşleşiyor.');
} else {
  console.error('\n✗ Mevcut TELEGRAM_CHAT_ID yukarıdakilerin HİÇBİRİYLE eşleşmiyor.');
  console.error('  ÇÖZÜM: Secrets → TELEGRAM_CHAT_ID değerini yukarıdaki sayıyla değiştir.');
  console.error('  Sık yapılan hata: token\'ın başındaki sayıyı (ör. 8668803509) chat ID');
  console.error('  sanmak, ya da "Id: 812345678" metnini baştaki "Id: " ile kopyalamak.');
}
