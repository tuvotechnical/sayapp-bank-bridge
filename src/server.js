/**
 * SayApp Bank Bridge — HTTP Server & Controller
 * Microservice providing health monitoring, wake-up preparation,
 * and autonomous O(1) batch polling for MBBank.
 */

const express = require('express');
const config = require('./config');
const BankClient = require('./services/bankClient');
const SessionKeeper = require('./services/sessionKeeper');
const SyncEngine = require('./services/syncEngine');
const LeaseManager = require('./services/leaseManager');

function createBridgeApp(customConfig = config, customClient = null, customFetch = globalThis.fetch) {
  const app = express();
  app.use(express.json());

  const bankClient = new BankClient(customConfig, customClient);
  const leaseManager = new LeaseManager(customConfig, customFetch);
  const sessionKeeper = new SessionKeeper(bankClient, customConfig, leaseManager);
  const syncEngine = new SyncEngine(bankClient, customConfig, customFetch, leaseManager);

  // Security Middleware for protected bridge endpoints
  function requireBridgeSecret(req, res, next) {
    const secret = req.headers['x-sayapp-bridge-secret'];
    if (!secret || secret !== customConfig.BRIDGE_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED_BRIDGE_SECRET',
          message: 'Invalid or missing X-SayApp-Bridge-Secret header',
        },
      });
    }
    next();
  }

  // 1. Public Health Check (Minimal - No internal telemetry leak PAY-13)
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      service: '@sayapp/bank-bridge',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // 2. Prepare Endpoint: Called by Gateway when a user initiates a checkout
  // Wakes container, tests bank connection, and kicks off immediate sync
  app.post('/api/v1/bridge/prepare', requireBridgeSecret, async (req, res) => {
    try {
      console.log('[Bridge Server] Prepare requested by Gateway. Waking up session...');
      const canSync = await leaseManager.canExecuteSync();
      if (!canSync) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'LEASE_NOT_HELD',
            message: 'Cannot prepare: connector lease is held by another worker instance.',
          },
          lease: leaseManager.getStatus(),
        });
      }
      // Ensure session is fresh
      await bankClient.getBalance();
      // Run immediate sync
      const syncResult = await syncEngine.syncNow();

      res.json({
        success: true,
        message: 'Bank bridge container is awake and verified.',
        bank: bankClient.getStatus(),
        sync: syncResult,
      });
    } catch (err) {
      console.error(`[Bridge Server] Prepare error: ${err.message}`);
      res.status(500).json({
        success: false,
        error: {
          code: 'BRIDGE_PREPARE_FAILED',
          message: err.message,
        },
      });
    }
  });

  // 3. Force Sync Now Endpoint: Immediately reconciles with MBBank and Gateway
  app.post('/api/v1/bridge/sync-now', requireBridgeSecret, async (req, res) => {
    try {
      const syncResult = await syncEngine.syncNow();
      res.json({
        success: true,
        sync: syncResult,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_NOW_FAILED',
          message: err.message,
        },
      });
    }
  });

  // 4. Status Diagnostics Endpoint
  app.get('/api/v1/bridge/status', requireBridgeSecret, (req, res) => {
    res.json({
      success: true,
      service: '@sayapp/bank-bridge',
      provider: customConfig.WORKER_PROVIDER,
      bank: bankClient.getStatus(),
      session_keeper: sessionKeeper.getStatus(),
      sync_engine: syncEngine.getStatus(),
      lease: leaseManager.getStatus(),
    });
  });

  return { app, bankClient, sessionKeeper, syncEngine, leaseManager };
}

// Startup function when running as standalone process
function startServer() {
  if (config.NODE_ENV === 'production' && (!config.BRIDGE_SECRET_KEY || config.BRIDGE_SECRET_KEY === 'sayapp_bridge_secret_test_2026')) {
    console.error('[SayApp Bank Bridge] FATAL CONFIG ERROR: BRIDGE_SECRET_KEY must be set securely in production. Startup aborted.');
    process.exit(1);
  }

  const { app, sessionKeeper, syncEngine, leaseManager } = createBridgeApp();

  const server = app.listen(config.PORT, () => {
    console.log(`[SayApp Bank Bridge] Server listening on port ${config.PORT}`);

    if (config.ENABLE_AUTO_POLL && config.NODE_ENV !== 'test') {
      sessionKeeper.start();
      syncEngine.start();
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[SayApp Bank Bridge] Shutting down gracefully...');
    sessionKeeper.stop();
    syncEngine.stop();
    try {
      await leaseManager.releaseLease();
    } catch (e) {
      console.warn('[SayApp Bank Bridge] Error releasing lease:', e.message);
    }
    server.close(() => {
      console.log('[SayApp Bank Bridge] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createBridgeApp,
  startServer,
};
