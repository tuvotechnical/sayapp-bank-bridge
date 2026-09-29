/**
 * SayApp Bank Bridge — Session Keeper
 * Periodically pings MBBank to prevent session expiration (GW200).
 * Automatically triggers re-login with OCR when ping failures occur.
 */

class SessionKeeper {
  constructor(bankClient, config, leaseManager = null) {
    this.bankClient = bankClient;
    this.config = config;
    this.leaseManager = leaseManager;
    this.timer = null;
    this.failCount = 0;
    this.lastPingAt = null;
    this.lastPingStatus = 'idle';
  }

  /**
   * Start the periodic keep-alive loop
   */
  start() {
    if (this.timer) {
      return;
    }

    const interval = this.config.KEEP_ALIVE_INTERVAL_MS || 240000;
    const maxFails = this.config.MAX_KEEP_ALIVE_FAILURES || 3;

    console.log(`[SessionKeeper] Started periodic ping (every ${interval / 1000}s, max failures: ${maxFails}).`);

    // Perform initial warm-up ping after 3s to establish bank session early
    if (this.config.NODE_ENV !== 'test') {
      setTimeout(async () => {
        await this.ping();
      }, 3000);
    }

    this.timer = setInterval(async () => {
      await this.ping();
    }, interval);
  }

  /**
   * Execute a single ping check
   */
  async ping() {
    // Only ping bank if holding active valid lease (standby or expired container must stay silent)
    if (this.leaseManager && (!this.leaseManager.isHoldingLease || this.leaseManager.leaseUntil < Date.now())) {
      this.lastPingStatus = 'skipped_standby_or_expired_lease';
      return;
    }

    const maxFails = this.config.MAX_KEEP_ALIVE_FAILURES || 3;

    try {
      this.lastPingAt = new Date();
      await this.bankClient.getBalance();
      this.failCount = 0;
      this.lastPingStatus = 'success';
    } catch (err) {
      this.failCount++;
      this.lastPingStatus = `failed: ${err.message}`;
      console.warn(`[SessionKeeper] Ping failed (${this.failCount}/${maxFails}): ${err.message}`);

      if (this.failCount >= maxFails) {
        if (this.leaseManager && (!this.leaseManager.isHoldingLease || this.leaseManager.leaseUntil < Date.now())) {
          this.lastPingStatus = 'relogin_skipped_lost_lease';
          console.warn('[SessionKeeper] Skipping auto re-login: lease lost or expired.');
          return;
        }
        console.warn('[SessionKeeper] Max failures reached, forcing automatic re-login...');
        this.failCount = 0;
        try {
          await this.bankClient.login();
          this.lastPingStatus = 'recovered_after_relogin';
          console.log('[SessionKeeper] Auto re-login successful.');
        } catch (loginErr) {
          this.lastPingStatus = `relogin_failed: ${loginErr.message}`;
          console.error(`[SessionKeeper] Auto re-login failed: ${loginErr.message}`);
        }
      }
    }
  }

  /**
   * Stop the keep-alive loop
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[SessionKeeper] Stopped keep-alive loop.');
    }
  }

  getStatus() {
    return {
      running: Boolean(this.timer),
      failCount: this.failCount,
      lastPingAt: this.lastPingAt ? this.lastPingAt.toISOString() : null,
      lastPingStatus: this.lastPingStatus,
    };
  }
}

module.exports = SessionKeeper;
