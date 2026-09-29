/**
 * SayApp Bank Bridge — Configuration
 * Loads environment variables and provides structured defaults.
 */
require('dotenv').config();

const nodeEnv = (process.env.NODE_ENV || 'production').toLowerCase();
const isTestEnv = nodeEnv === 'test' || Boolean(process.env.VITEST) || process.argv.some(a => a.includes('test'));
const bridgeSecret = process.env.BRIDGE_SECRET_KEY || (isTestEnv ? 'sayapp_bridge_secret_test_2026' : '');

const config = {
  // Service Port (Koyeb uses PORT=8080 by default)
  PORT: parseInt(process.env.PORT || '8080', 10),

  // Shared Secret Key between Koyeb Bridge and Cloudflare Gateway
  BRIDGE_SECRET_KEY: bridgeSecret,

  // Cloudflare Gateway Webhook, Status & Distributed Lease Lock Endpoints
  GATEWAY_WEBHOOK_URL: process.env.GATEWAY_WEBHOOK_URL || 'https://api.sayapp.top/api/v1/billing/webhook/bank-bridge',
  GATEWAY_STATUS_URL: process.env.GATEWAY_STATUS_URL || 'https://api.sayapp.top/api/v1/billing/bridge/status',
  GATEWAY_LEASE_ACQUIRE_URL: process.env.GATEWAY_LEASE_ACQUIRE_URL || 'https://api.sayapp.top/api/v1/billing/bridge/lease/acquire',
  GATEWAY_LEASE_RELEASE_URL: process.env.GATEWAY_LEASE_RELEASE_URL || 'https://api.sayapp.top/api/v1/billing/bridge/lease/release',

  // Worker Provider Identity ('koyeb' for primary, 'render' for standby, 'pc' for manual)
  WORKER_PROVIDER: (process.env.WORKER_PROVIDER || 'koyeb').toLowerCase(),
  WORKER_ID: process.env.WORKER_ID || `${(process.env.WORKER_PROVIDER || 'koyeb').toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`,
  LEASE_TTL_SECONDS: parseInt(process.env.LEASE_TTL_SECONDS || '30', 10),

  // MB Bank Credentials
  MB_USERNAME: process.env.MB_USERNAME || '',
  MB_PASSWORD: process.env.MB_PASSWORD || '',
  MB_ACCOUNT_NUMBER: process.env.MB_ACCOUNT_NUMBER || '',

  // Polling Intervals
  // Active: when there is at least 1 pending checkout session (default 10s)
  POLL_INTERVAL_ACTIVE_MS: parseInt(process.env.POLL_INTERVAL_ACTIVE_MS || '10000', 10),
  // Idle: when there are 0 pending checkout sessions (default 60s to save CPU and bank requests)
  POLL_INTERVAL_IDLE_MS: parseInt(process.env.POLL_INTERVAL_IDLE_MS || '60000', 10),

  // Session Keep-Alive: Ping getBalance() every 4 minutes (default 240,000ms)
  KEEP_ALIVE_INTERVAL_MS: parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '240000', 10),
  MAX_KEEP_ALIVE_FAILURES: parseInt(process.env.MAX_KEEP_ALIVE_FAILURES || '3', 10),

  // Auto-polling enabled by default in production
  ENABLE_AUTO_POLL: process.env.ENABLE_AUTO_POLL !== 'false',

  // Node Environment
  NODE_ENV: process.env.NODE_ENV || 'production',
};

module.exports = config;
