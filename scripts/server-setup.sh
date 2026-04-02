#!/usr/bin/env bash
set -euo pipefail

# server-setup.sh — Fresh VPS setup for Mycelium Agent Framework
#
# Run as root on a fresh Ubuntu 24.04 VPS:
#   curl -fsSL https://raw.githubusercontent.com/your-org/mycelium/main/scripts/server-setup.sh | bash
#   — or —
#   bash scripts/server-setup.sh
#
# What this script does:
#   1. Creates 'claude' user with sudo + SSH access
#   2. Installs Node.js 22, PM2, Claude CLI, Caddy
#   3. Configures UFW firewall (SSH + HTTP/S only)
#   4. Sets up log directories
#   5. Clones the repo and installs dependencies

REPO_URL="https://github.com/your-org/mycelium.git"
INSTALL_DIR="/home/claude/mycelium"
LOG_DIR="/var/log/mycelium"
USERNAME="claude"

echo "═══════════════════════════════════════════════════════"
echo "  Mycelium — Server Setup"
echo "═══════════════════════════════════════════════════════"
echo ""

# Must run as root
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root."
  echo "Usage: sudo bash scripts/server-setup.sh"
  exit 1
fi

# ── Phase 1: Create user ────────────────────────────────────

echo "→ Phase 1: Creating '${USERNAME}' user..."

if id "$USERNAME" &>/dev/null; then
  echo "  User '${USERNAME}' already exists, skipping."
else
  adduser --disabled-password --gecos "Mycelium Agent Runner" "$USERNAME"
  usermod -aG sudo "$USERNAME"
  # Allow passwordless sudo for deploy scripts
  echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME}
  chmod 0440 /etc/sudoers.d/${USERNAME}
  echo "  ✓ User '${USERNAME}' created with sudo access."
fi

# Copy SSH keys from root to claude user
if [[ -f /root/.ssh/authorized_keys ]]; then
  mkdir -p /home/${USERNAME}/.ssh
  cp /root/.ssh/authorized_keys /home/${USERNAME}/.ssh/authorized_keys
  chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.ssh
  chmod 700 /home/${USERNAME}/.ssh
  chmod 600 /home/${USERNAME}/.ssh/authorized_keys
  echo "  ✓ SSH keys copied to '${USERNAME}' user."
fi
echo ""

# ── Phase 2: System packages ────────────────────────────────

echo "→ Phase 2: Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  git curl wget build-essential \
  ufw fail2ban \
  unzip jq htop \
  > /dev/null 2>&1
echo "  ✓ System packages installed."
echo ""

# ── Phase 3: Node.js 22 ─────────────────────────────────────

echo "→ Phase 3: Installing Node.js 22..."
if command -v node &>/dev/null && [[ "$(node --version)" == v22* ]]; then
  echo "  Node.js $(node --version) already installed, skipping."
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  echo "  ✓ Node.js $(node --version) installed."
fi
echo ""

# ── Phase 4: PM2 + Claude CLI ───────────────────────────────

echo "→ Phase 4: Installing global npm packages..."
npm install -g pm2@latest > /dev/null 2>&1
echo "  ✓ PM2 $(pm2 --version) installed."

npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
echo "  ✓ Claude CLI $(claude --version 2>/dev/null || echo 'installed') installed."
echo ""

# ── Phase 5: Caddy (reverse proxy) ──────────────────────────

echo "→ Phase 5: Installing Caddy..."
if command -v caddy &>/dev/null; then
  echo "  Caddy already installed, skipping."
else
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https > /dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq > /dev/null 2>&1
  apt-get install -y -qq caddy > /dev/null 2>&1
  echo "  ✓ Caddy installed."
fi
echo ""

# ── Phase 6: Firewall ───────────────────────────────────────

echo "→ Phase 6: Configuring firewall..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
echo "  ✓ UFW enabled: SSH (22), HTTP (80), HTTPS (443) allowed."
echo ""

# ── Phase 7: SSH hardening ──────────────────────────────────

echo "→ Phase 7: Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
# Disable password auth (key-only)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null
echo "  ✓ SSH hardened: password auth disabled, root login key-only."
echo ""

# ── Phase 8: Log directory ──────────────────────────────────

echo "→ Phase 8: Setting up log directory..."
mkdir -p "$LOG_DIR"
chown ${USERNAME}:${USERNAME} "$LOG_DIR"
echo "  ✓ Log directory created at ${LOG_DIR}"
echo ""

# ── Phase 9: Clone repo & install deps ──────────────────────

echo "→ Phase 9: Cloning repository..."
if [[ -d "$INSTALL_DIR" ]]; then
  echo "  Directory ${INSTALL_DIR} already exists, pulling latest..."
  su - ${USERNAME} -c "cd ${INSTALL_DIR} && git pull --ff-only"
else
  su - ${USERNAME} -c "git clone ${REPO_URL} ${INSTALL_DIR}"
  echo "  ✓ Repository cloned to ${INSTALL_DIR}"
fi
echo ""

echo "→ Installing npm dependencies..."
su - ${USERNAME} -c "cd ${INSTALL_DIR} && npm install"
echo ""

echo "→ Building portal..."
su - ${USERNAME} -c "cd ${INSTALL_DIR}/portal && npm install && npm run build"
echo ""

# ── Phase 10: PM2 startup ───────────────────────────────────

echo "→ Phase 10: Configuring PM2 startup..."
# Generate startup script as claude user, then execute as root
env PATH=$PATH:/usr/bin pm2 startup systemd -u ${USERNAME} --hp /home/${USERNAME} > /dev/null 2>&1
echo "  ✓ PM2 configured to start on boot."
echo ""

# ── Summary ──────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════"
echo "  ✓ Server setup complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Installed:"
echo "    Node.js:    $(node --version)"
echo "    npm:        $(npm --version)"
echo "    PM2:        $(pm2 --version)"
echo "    Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
echo "    Caddy:      $(caddy version 2>/dev/null || echo 'installed')"
echo ""
echo "  Next steps:"
echo "    1. Switch to claude user:  su - claude"
echo "    2. Configure environment:  cd ~/mycelium && cp .env.example .env && nano .env"
echo "    3. Authenticate Claude:    claude auth login"
echo "    4. Configure Caddy:        sudo nano /etc/caddy/Caddyfile"
echo "    5. Start services:         cd ~/mycelium && pm2 start ecosystem.config.cjs"
echo "    6. Save PM2 state:         pm2 save"
echo ""
