#!/usr/bin/env bash
# ============================================================================
# Rupeeruchana VPS kurulumu — Ubuntu 22.04 / 24.04, root ile tek komut:
#   bash <(curl -s https://raw.githubusercontent.com/aLpsuui/rupeeruchana/main/scripts/vps-setup.sh)
#
# Kurar: Node 22, git, repo (/opt/rupeeruchana), .env iskeleti, canlı yürütücü
# systemd servisi (scripts/live-executor.mjs, dakikada bir tik, 4 saatte bir tur),
# isteğe bağlı Caddy (canlı pano için HTTPS; CANLI_HOST verilirse).
#
# Yeniden çalıştırmak güvenlidir: var olanı günceller, .env'e dokunmaz.
# ============================================================================
set -euo pipefail
REPO=/opt/rupeeruchana

echo "== Rupeeruchana VPS kurulumu =="

# Node 22 + git
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git >/dev/null

# repo
if [ ! -d $REPO ]; then git clone https://github.com/aLpsuui/rupeeruchana.git $REPO; else git -C $REPO pull -q --rebase; fi

# .env: anahtarlar buraya, asla git'e değil
if [ ! -f $REPO/.env ]; then
  cat > $REPO/.env << 'ENV'
# ---- Rupeeruchana canlı yürütücü ----
# Mod: dry (emir yok, rapor) | testnet (sahte para, gerçek emir akışı) | live
RUPEE_MODE=dry
# Binance USDⓈ-M vadeli API anahtarı: SADECE Futures yetkisi, para çekme KAPALI,
# IP kısıtı = bu sunucunun IP'si. testnet için testnet.binancefuture.com anahtarı.
BINANCE_KEY=
BINANCE_SECRET=
# Telegram (motor + yürütücü aynı kanalı kullanır)
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
# Motorun data/ çıktısını GitHub'a push et (site oradan yayınlanır): 1 = evet.
# Gerekli: GITHUB_TOKEN (repo yazma yetkili fine-grained token) — remote URL'ye işlenir.
RUPEE_PUSH=0
GITHUB_TOKEN=
# Radar bildirimleri (motorun kendi ayarı)
RUPEE_RADAR_NOTIFY=1
# Canlı pano HTTP ucu (Caddy arkasında)
CANLI_PORT=8787
# Canlı pano için HTTPS alan adı (ör. canli.alanadin.com → bu sunucunun IP'si). Boşsa Caddy kurulmaz.
CANLI_HOST=
ENV
  chmod 600 $REPO/.env
  echo ">> $REPO/.env oluşturuldu, anahtarları doldur."
fi

# .env'den CANLI_HOST ve GITHUB_TOKEN oku
set +u; source <(grep -E '^(CANLI_HOST|GITHUB_TOKEN|RUPEE_PUSH)=' $REPO/.env | sed 's/^/export /') || true; set -u

# push için remote'a token işle (token varsa)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git -C $REPO remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/aLpsuui/rupeeruchana.git"
  git -C $REPO config pull.rebase true
fi

# systemd servisi: çökerse 30 sn sonra yeniden başlar
cat > /etc/systemd/system/rupeeruchana.service << UNIT
[Unit]
Description=Rupeeruchana canlı yürütücü
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO
ExecStart=/usr/bin/node --env-file=$REPO/.env $REPO/scripts/live-executor.mjs
Restart=always
RestartSec=30
Environment=TZ=UTC
StandardOutput=append:/var/log/rupeeruchana.log
StandardError=append:/var/log/rupeeruchana.log

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rupeeruchana >/dev/null
systemctl restart rupeeruchana

# Caddy: canlı pano için otomatik HTTPS (yalnızca CANLI_HOST verildiyse)
if [ -n "${CANLI_HOST:-}" ]; then
  if ! command -v caddy >/dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q && apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile << CADDY
$CANLI_HOST {
  reverse_proxy 127.0.0.1:${CANLI_PORT:-8787}
}
CADDY
  systemctl restart caddy
  echo ">> Pano: https://$CANLI_HOST/canli.json"
fi

echo ""
echo "== KURULUM TAMAM =="
echo "Node $(node -v) · repo $REPO · servis: systemctl status rupeeruchana · log: tail -f /var/log/rupeeruchana.log"
echo "Durdurmak için yeni giriş kilidi: touch $REPO/DUR   (kaldır: rm $REPO/DUR)"
echo "Binance erişim testi:"
curl -s -o /dev/null -w "  fapi.binance.com HTTP %{http_code}\n" https://fapi.binance.com/fapi/v1/ping || true
echo "(200 görüyorsan coğrafi engel yok. ABD IP'sinde 451 gelir, sunucu konumunu değiştir.)"
