// ============================================================================
// Rupeeruchana — "bu 4 saatlik mumun turu atıldı mı?" koruması
//
// Neden: GitHub'ın zamanlanmış işleri güvenilmez. 4 saatte bir (17 */4) kurulu
// cron pratikte 5-6 saat arayla çalışıyor ve bazı turları tamamen atlıyor
// (5 Eki 2026: 05:35 UTC'den sonra 8,5 saat tur yok, 08:17 ve 12:17 atlandı).
// Çözüm: workflow SAATTE BİR tetiklenir, bu script son kapanan 4s mum için tur
// atılmış mı diye bakar. Atılmışsa motor çalışmaz (mesaj çoğalmaz); atılmamışsa
// çalışır. Böylece atlanan bir tetik en geç bir sonraki saatte telafi edilir ve
// tur yine MUM BAŞINA BİR KEZ atılır.
//
// Çıktı (GITHUB_OUTPUT): calis=true|false  → motor adımları koşsun mu
//                        yayin=true|false  → site yayınlansın mı
// Elle tetikleme (workflow_dispatch) her zaman tur atar. Push her zaman yayınlar,
// ama motoru yalnızca bu mumun turu eksikse çalıştırır.
// ============================================================================

import { readFileSync, appendFileSync } from 'node:fs';

const H4 = 4 * 3600 * 1000;
const st = JSON.parse(readFileSync(new URL('../data/state.json', import.meta.url), 'utf8'));
const simdi = Date.now();
const mumKapanis = Math.floor(simdi / H4) * H4;          // son kapanan 4s mumun kapanış anı (UTC 00/04/08/...)
const sonTur = Date.parse(st.updated || 0) || 0;
const olay = process.env.GITHUB_EVENT_NAME || 'yerel';

const eksik = sonTur < mumKapanis;                         // bu mum kapandığından beri tur atılmamış
const calis = olay === 'workflow_dispatch' || eksik;
const yayin = calis || olay !== 'schedule';                // zamanlı boş geçişte siteyi yeniden yayınlama

const iso = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
console.log(`olay ${olay} · son tur ${iso(sonTur)} UTC · son mum kapanışı ${iso(mumKapanis)} UTC · ` +
  `${eksik ? 'bu mumun turu ATILMAMIŞ (' + ((simdi - mumKapanis) / 60000).toFixed(0) + ' dk gecikme)' : 'bu mumun turu zaten atılmış'} ` +
  `→ motor ${calis ? 'ÇALIŞACAK' : 'çalışmayacak'}, yayın ${yayin ? 'var' : 'yok'}`);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `calis=${calis}\nyayin=${yayin}\n`);
