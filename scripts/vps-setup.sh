#!/usr/bin/env bash
# ============================================================================
# Rupeeruchana VPS kurulumu — tek komutla çalıştırılır (Ubuntu 22.04/24.04):
#   bash <(curl -s https://raw.githubusercontent.com/aLpsuui/rupeeruchana/main/scripts/vps-setup.sh)
# Yaptıkları: Node 20 + git kurar, repoyu /opt/rupeeruchana'ya klonlar,
# saatlik canlı-yürütücü cron'unu hazırlar (live-executor.mjs eklendiğinde
# otomatik devreye girer; öncesinde zararsızca boşta bekler).
# ============================================================================
set -euo pipefail

echo "== Rupeeruchana VPS kurulumu başlıyor =="

# Node 20 + git
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git >/dev/null

# repo
if [ ! -d /opt/rupeeruchana ]; then
  git clone https://github.com/aLpsuui/rupeeruchana.git /opt/rupeeruchana
else
  git -C /opt/rupeeruchana pull -q
fi

# ortam dosyası (API anahtarları buraya girilecek — canlıya geçişte doldurulur)
if [ ! -f /opt/rupeeruchana/.env ]; then
  cat > /opt/rupeeruchana/.env << 'ENV'
# Canlıya geçişte doldurulacak (Claude ile birlikte):
# BINANCE_KEY=
# BINANCE_SECRET=
# RISK_USD=5
# MAX_POSITIONS=4
# LEVERAGE=10
ENV
  chmod 600 /opt/rupeeruchana/.env
fi

# saatlik cron: repo güncelle + canlı yürütücü varsa çalıştır
cat > /etc/cron.d/rupeeruchana << 'CRON'
7 * * * * root cd /opt/rupeeruchana && git pull -q && { [ -f scripts/live-executor.mjs ] && node --env-file=.env scripts/live-executor.mjs >> /var/log/rupeeruchana.log 2>&1; } || true
CRON
chmod 644 /etc/cron.d/rupeeruchana

echo ""
echo "== KURULUM TAMAM =="
echo "Node: $(node -v) · Repo: /opt/rupeeruchana · Cron: saatlik :07'de"
echo "Binance erişim testi:"
curl -s -o /dev/null -w "  api.binance.com HTTP %{http_code}\n" https://api.binance.com/api/v3/ping || true
echo "(200 görüyorsan coğrafi engel YOK — canlı işleme hazır demektir.)"
