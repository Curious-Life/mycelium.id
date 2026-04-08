#!/bin/bash
# Mycelium KMS Server Hardening — Infomaniak VPS (Switzerland)
#
# Run as root on a fresh Ubuntu 24.04 VPS:
#   bash setup.sh <allowed_vps_ip1> [<allowed_vps_ip2> ...]
#
# Creates 'kms' user, installs Node.js, configures firewall,
# disables swap, hardens kernel, installs PM2.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash setup.sh <vps_ip1> [vps_ip2 ...]"
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: bash setup.sh <allowed_vps_ip1> [<allowed_vps_ip2> ...]"
  echo "  Provide the IP addresses of customer VPSes that should connect to the KMS."
  exit 1
fi

echo "=== Mycelium KMS Server Hardening ==="
echo ""

# ── 1. Create kms user ──
echo "→ Creating kms user..."
if ! id -u kms &>/dev/null; then
  useradd -m -s /bin/bash kms
  echo "  ✓ User 'kms' created"
else
  echo "  ✓ User 'kms' already exists"
fi

# ── 2. Install Node.js 22 ──
echo "→ Installing Node.js 22..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "  ✓ Node.js $(node -v)"

# ── 3. Install PM2 ──
echo "→ Installing PM2..."
npm install -g pm2 2>/dev/null || true
echo "  ✓ PM2 $(pm2 -v 2>/dev/null || echo 'installed')"

# ── 4. Disable swap ──
echo "→ Disabling swap (keys must NEVER touch disk)..."
swapoff -a 2>/dev/null || true
sed -i '/swap/d' /etc/fstab
echo "  ✓ Swap disabled"

# ── 5. Kernel hardening ──
echo "→ Applying kernel hardening..."
cat > /etc/sysctl.d/99-kms-security.conf <<EOF
# Core dumps disabled — prevent key material from reaching disk
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0

# ptrace fully restricted — even parent processes cannot inspect memory
kernel.yama.ptrace_scope=2
EOF
sysctl -p /etc/sysctl.d/99-kms-security.conf 2>/dev/null

# Disable core dumps via limits
cat >> /etc/security/limits.conf <<EOF
* hard core 0
* soft core 0
EOF
echo "  ✓ Core dumps disabled, ptrace=2"

# ── 6. Firewall ──
echo "→ Configuring firewall..."
apt-get install -y ufw 2>/dev/null
ufw --force reset 2>/dev/null || true
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh

# Allow KMS port from specified VPS IPs only
for VPS_IP in "$@"; do
  echo "  Allowing ${VPS_IP} → port 8443"
  ufw allow from "${VPS_IP}/32" to any port 8443
done

ufw --force enable
echo "  ✓ Firewall configured (SSH + KMS port 8443 from specified IPs)"

# ── 7. SSH hardening ──
echo "→ Hardening SSH..."
sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart sshd
echo "  ✓ Password auth disabled, root login restricted"

# ── 8. Fail2ban ──
echo "→ Installing fail2ban..."
apt-get install -y fail2ban 2>/dev/null
systemctl enable fail2ban
systemctl start fail2ban
echo "  ✓ Fail2ban active"

# ── 9. Unattended upgrades ──
echo "→ Configuring unattended security upgrades..."
apt-get install -y unattended-upgrades 2>/dev/null
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51mycelium-no-reboot
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null || true
echo "  ✓ Unattended upgrades (no auto-reboot)"

# ── 10. Create directories ──
echo "→ Creating KMS directories..."
mkdir -p /etc/kms/certs /etc/kms/audit /home/kms/kms
chown kms:kms /etc/kms /etc/kms/certs /etc/kms/audit /home/kms/kms
chmod 700 /etc/kms/certs
chmod 700 /etc/kms/audit
echo "  ✓ /etc/kms/certs (certs), /etc/kms/audit (audit log)"

# ── 11. PM2 startup ──
echo "→ Configuring PM2 startup for kms user..."
env PATH=$PATH:/usr/bin pm2 startup systemd -u kms --hp /home/kms 2>/dev/null || true
echo "  ✓ PM2 auto-start configured"

echo ""
echo "=== KMS Hardening Complete ==="
echo ""
echo "Next steps:"
echo "  1. Deploy KMS code:  scp -r infomaniak-kms/* kms@<this-ip>:~/kms/"
echo "  2. Generate certs:   bash certs/cert-gen.sh init && bash certs/cert-gen.sh admin"
echo "  3. Deploy certs:     cp certs/{ca.crt,server.crt,server.key} /etc/kms/certs/"
echo "  4. Install deps:     cd ~/kms && npm install"
echo "  5. Start:            pm2 start ecosystem.config.js && pm2 save"
echo "  6. To add a VPS:     ufw allow from <new-vps-ip>/32 to any port 8443"
