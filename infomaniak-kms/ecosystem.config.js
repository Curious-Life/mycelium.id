export default {
  apps: [{
    name: 'kms-server',
    script: 'src/server.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      KMS_PORT: 8443,
      KMS_CERT_DIR: '/etc/kms/certs',
      KMS_AUDIT_DIR: '/etc/kms/audit',
    },
    // Never persist these to PM2 dump
    filter_env: ['KMS_BACKUP_KEY'],
  }],
};
