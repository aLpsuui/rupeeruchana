// ============================================================================
// Rupeeruchana — ağ katmanı
// Her dış istek zaman aşımlı ve sınırlı tekrar denemelidir.
// Gerekçe: 10 Ağustos 2026'daki kilitlenmede tek bir takılı istek turu saatlerce
// astı; zaman aşımı olmayan fetch, runner'ı süresiz meşgul edebiliyor.
// ============================================================================

export const FETCH_TIMEOUT_MS = 25_000; // tek istek için üst sınır
export const RETRIES = 2;               // toplam 3 deneme

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Zaman aşımlı fetch. Geçici hatalarda (ağ, 429, 5xx) artan bekleme ile tekrar dener.
export async function httpFetch(url, opts = {}, cfg = {}) {
  const timeoutMs = cfg.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retries = cfg.retries ?? RETRIES;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1)); // 1 sn, 2 sn
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRY_STATUS.has(r.status) && attempt < retries) {
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      return r;
    } catch (e) {
      // AbortSignal.timeout → TimeoutError; ağ kopması → TypeError
      lastErr = e?.name === 'TimeoutError'
        ? new Error(`zaman aşımı (${timeoutMs} ms)`)
        : e;
    }
  }
  throw lastErr ?? new Error('istek başarısız');
}

// JSON bekleyen çağrılar için kısayol: durum kodu kötüyse anlamlı hata fırlatır.
export async function fetchJson(url, label = 'istek', cfg = {}) {
  const r = await httpFetch(url, {}, cfg);
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return r.json();
}
