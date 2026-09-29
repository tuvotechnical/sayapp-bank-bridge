/**
 * SayApp Bank Bridge — Sync Engine
 * Orchestrates O(1) Batch Polling reconciliation between MBBank and Cloudflare Gateway.
 */

const crypto = require('crypto');

function formatDateDDMMYYYY(date) {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function generateDeterministicRefNo(tx, defaultAcc) {
  if (tx.refNo || tx.transactionId) return String(tx.refNo || tx.transactionId).trim();
  const acc = String(tx.accountNumber || tx.accountNo || defaultAcc || '').trim();
  const amt = String(tx.creditAmount || '').trim();
  const date = String(tx.postDate || tx.postingDate || tx.transactionDate || '').trim();
  const desc = String(tx.transactionDesc || tx.description || '').trim();
  const rawKey = `${acc}|${amt}|${date}|${desc}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
  return `MB_DET_${hash.toUpperCase()}`;
}

class SyncEngine {
  constructor(bankClient, config, fetchImpl = globalThis.fetch, leaseManager = null) {
    this.bankClient = bankClient;
    this.config = config;
    this.fetch = fetchImpl;
    this.leaseManager = leaseManager;
    this.isRunning = false;
    this.timeoutHandle = null;
    this.lastSyncAt = null;
    this.lastMatchedCount = 0;
    this.totalBatchesSent = 0;
    this.consecutiveErrors = 0;
    this.lastError = null;
    this._syncPromise = null;
  }

  /**
   * Check Gateway for pending checkout sessions
   */
  async checkGatewayPendingStatus() {
    try {
      const res = await this.fetch(this.config.GATEWAY_STATUS_URL, {
        method: 'GET',
        headers: {
          'X-SayApp-Bridge-Secret': this.config.BRIDGE_SECRET_KEY,
          'User-Agent': 'SayApp-BankBridge/1.0',
        },
      });

      if (!res.ok) {
        throw new Error(`Gateway returned HTTP ${res.status}`);
      }

      const data = await res.json();
      return {
        has_pending: Boolean(data.has_pending),
        pending_count: Number(data.pending_count || 0),
      };
    } catch (err) {
      console.warn(`[SyncEngine] Gateway status check warning: ${err.message}`);
      // Default to true in case of status check error so transactions aren't dropped
      return { has_pending: true, pending_count: 1, error: err.message };
    }
  }

  /**
   * Run one sync iteration with single-flight mutex protection
   */
  async syncOnce() {
    if (this._syncPromise) {
      return this._syncPromise;
    }
    this._syncPromise = this._doSyncOnce();
    try {
      return await this._syncPromise;
    } finally {
      this._syncPromise = null;
    }
  }

  async _doSyncOnce() {
    try {
      // 1. Check if there are active pending orders, but allow periodic catchup so bank events are ingested into D1
      const pendingStatus = await this.checkGatewayPendingStatus();
      const isPeriodicCatchup = Boolean(this.lastSyncAt && (Date.now() - this.lastSyncAt.getTime() > 60000));
      if (!pendingStatus.has_pending && !isPeriodicCatchup) {
        return {
          synced: false,
          reason: 'no_pending_orders',
          pending_count: 0,
        };
      }

      // 1.5. Ensure this worker holds the distributed lease lock
      if (this.leaseManager && typeof this.leaseManager.canExecuteSync === 'function') {
        const canSync = await this.leaseManager.canExecuteSync();
        if (!canSync) {
          return {
            synced: false,
            reason: 'standby_lease_held_by_other_worker',
            held_by: this.leaseManager.lastAcquireResult?.held_by,
            pending_count: pendingStatus.pending_count,
          };
        }
      }

      // 2. Query MBBank for transactions in Vietnam timezone (UTC+7)
      // Look back 3 days and forward 1 day to cover evening bank accounting cut-offs (banks post transactions after 21:00 to next day)
      const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const vnFrom = new Date(vnNow.getTime() - 3 * 24 * 60 * 60 * 1000);
      const vnTo = new Date(vnNow.getTime() + 1 * 24 * 60 * 60 * 1000);
      const fromDate = `${vnFrom.getUTCDate().toString().padStart(2, '0')}/${(vnFrom.getUTCMonth() + 1).toString().padStart(2, '0')}/${vnFrom.getUTCFullYear()}`;
      const toDate = `${vnTo.getUTCDate().toString().padStart(2, '0')}/${(vnTo.getUTCMonth() + 1).toString().padStart(2, '0')}/${vnTo.getUTCFullYear()}`;

      const rawTransactions = await this.bankClient.getTransactionsHistory(fromDate, toDate);

      // 3. Filter positive credits and map to standardized batch schema
      const creditTransactions = (rawTransactions || [])
        .filter(tx => {
          const amt = parseFloat(tx.creditAmount || '0');
          return amt > 0;
        })
        .map(tx => ({
          refNo: generateDeterministicRefNo(tx, this.config.MB_ACCOUNT_NUMBER),
          creditAmount: parseFloat(tx.creditAmount),
          transactionDesc: tx.transactionDesc || tx.description || '',
          postDate: tx.postDate || tx.postingDate || tx.transactionDate || '',
          accountNumber: tx.accountNumber || tx.accountNo || this.config.MB_ACCOUNT_NUMBER || '',
        }));

      if (creditTransactions.length === 0) {
        this.lastSyncAt = new Date();
        return {
          synced: true,
          total_sent: 0,
          matched_count: 0,
          pending_count: pendingStatus.pending_count,
        };
      }

      // Ensure fencing token is valid and fresh before webhook dispatch
      let fencingToken = this.leaseManager ? Number(this.leaseManager.fencingToken || 0) : 0;
      if (this.leaseManager && (!fencingToken || fencingToken === 0)) {
        await this.leaseManager.tryAcquireLease();
        fencingToken = Number(this.leaseManager.fencingToken || 1);
      }

      const activeWorkerId = this.config.WORKER_ID || `${this.config.WORKER_PROVIDER || 'render'}_default`;

      // 4. Send O(1) batch payload to Gateway webhook
      const webhookRes = await this.fetch(this.config.GATEWAY_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SayApp-Bridge-Secret': this.config.BRIDGE_SECRET_KEY,
          'User-Agent': `SayApp-BankBridge/${this.config.WORKER_PROVIDER || 'render'}`,
        },
        body: JSON.stringify({
          provider: this.config.WORKER_PROVIDER || 'render',
          worker_id: activeWorkerId,
          lease_token: activeWorkerId,
          fencing_token: fencingToken || 1,
          transactions: creditTransactions,
        }),
      });

      if (!webhookRes.ok) {
        const errorText = await webhookRes.text();
        throw new Error(`Webhook rejected with HTTP ${webhookRes.status}: ${errorText}`);
      }

      const webhookData = await webhookRes.json();
      const matched = Number(webhookData.matched_count || 0);
      const eventResults = Array.isArray(webhookData.event_results) ? webhookData.event_results : [];
      const errorEvents = eventResults.filter(e => e.status === 'error');

      this.lastSyncAt = new Date();
      this.lastMatchedCount = matched;
      this.totalBatchesSent++;

      if (errorEvents.length > 0) {
        this.consecutiveErrors++;
        this.lastError = `Gateway reported errors for ${errorEvents.length} transactions: ${errorEvents.map(e => `${e.refNo}(${e.reason})`).join(', ')}`;
        console.warn(`[SyncEngine] Partial event errors in batch: ${this.lastError}`);
      } else {
        this.consecutiveErrors = 0;
        this.lastError = null;
      }

      if (matched > 0) {
        console.log(`[SyncEngine] Successfully matched and activated ${matched} order(s)!`);
      }

      return {
        synced: true,
        total_sent: creditTransactions.length,
        matched_count: matched,
        pending_count: pendingStatus.pending_count,
        error_events_count: errorEvents.length,
      };
    } catch (err) {
      this.consecutiveErrors++;
      this.lastError = err.message;
      console.error(`[SyncEngine] Sync error: ${err.message}`);
      return {
        synced: false,
        error: err.message,
      };
    }
  }

  /**
   * Internal scheduler that guarantees continuous looping
   */
  _scheduleLoop(nextDelay = null) {
    if (!this.isRunning) return;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    const runLoop = async () => {
      if (!this.isRunning) return;
      const result = await this.syncOnce();
      const delay = (result && result.pending_count > 0)
        ? (this.config.POLL_INTERVAL_ACTIVE_MS || 5000)
        : (this.leaseManager && this.leaseManager.isHoldingLease ? 15000 : (this.config.POLL_INTERVAL_IDLE_MS || 15000));

      if (this.isRunning) {
        this.timeoutHandle = setTimeout(runLoop, delay);
      }
    };

    if (typeof nextDelay === 'number') {
      this.timeoutHandle = setTimeout(runLoop, nextDelay);
    } else {
      runLoop();
    }
  }

  /**
   * Start the continuous adaptive polling loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[SyncEngine] Started adaptive O(1) batch polling loop.');

    // Proactively acquire distributed lease on server start
    if (this.leaseManager && typeof this.leaseManager.tryAcquireLease === 'function') {
      this.leaseManager.tryAcquireLease().catch((err) => {
        console.warn(`[SyncEngine] Initial lease acquire notice: ${err.message}`);
      });
    }

    this._scheduleLoop();
  }

  /**
   * Force an immediate sync (called by /api/v1/bridge/sync-now or /prepare)
   */
  async syncNow() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    const result = await this.syncOnce();

    if (this.isRunning) {
      const delay = (result && result.pending_count > 0)
        ? (this.config.POLL_INTERVAL_ACTIVE_MS || 5000)
        : (this.config.POLL_INTERVAL_IDLE_MS || 15000);

      this._scheduleLoop(delay);
    }

    return result;
  }

  /**
   * Stop the loop
   */
  stop() {
    this.isRunning = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    console.log('[SyncEngine] Stopped adaptive polling loop.');
  }

  getStatus() {
    return {
      running: this.isRunning,
      lastSyncAt: this.lastSyncAt ? this.lastSyncAt.toISOString() : null,
      lastMatchedCount: this.lastMatchedCount,
      totalBatchesSent: this.totalBatchesSent,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
    };
  }
}

module.exports = SyncEngine;
