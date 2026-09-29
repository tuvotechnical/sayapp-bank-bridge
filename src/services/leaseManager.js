/**
 * SayApp Bank Bridge — Distributed Lease Lock Manager
 * Ensures that only one active worker (Koyeb Primary or Render Standby)
 * queries MBBank at any given time, preventing IP bans and token collisions.
 */

class LeaseManager {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.isHoldingLease = false;
    this.leaseUntil = 0;
    this.fencingToken = 0;
    this.lastAcquireAt = null;
    this.lastAcquireResult = null;
  }

  /**
   * Attempt to acquire or extend the distributed lease from Cloudflare Gateway
   */
  async tryAcquireLease(ttlSeconds = this.config.LEASE_TTL_SECONDS || 30) {
    try {
      const acquireUrl = this.config.GATEWAY_LEASE_ACQUIRE_URL || 'https://api.sayapp.top/api/v1/billing/bridge/lease/acquire';
      const res = await this.fetch(acquireUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SayApp-Bridge-Secret': this.config.BRIDGE_SECRET_KEY,
          'User-Agent': `SayApp-BankBridge/${this.config.WORKER_PROVIDER || 'koyeb'}`,
        },
        body: JSON.stringify({
          provider: this.config.WORKER_PROVIDER || 'koyeb',
          worker_id: this.config.WORKER_ID || 'koyeb_default',
          ttl_seconds: ttlSeconds,
        }),
      });

      if (!res.ok) {
        throw new Error(`Lease acquire returned HTTP ${res.status}`);
      }

      const data = await res.json();
      this.lastAcquireAt = new Date();
      this.lastAcquireResult = data;

      if (data.acquired === true) {
        this.isHoldingLease = true;
        this.leaseUntil = Number(data.lease_until || Date.now() + ttlSeconds * 1000);
        this.fencingToken = Number(data.fencing_token || 0);
        return {
          acquired: true,
          worker_id: this.config.WORKER_ID,
          lease_until: this.leaseUntil,
          fencing_token: this.fencingToken,
        };
      }

      this.isHoldingLease = false;
      this.leaseUntil = 0;
      return {
        acquired: false,
        held_by: data.held_by,
        expires_in_ms: data.expires_in_ms,
      };
    } catch (err) {
      console.warn(`[LeaseManager] Lease acquire error: ${err.message}`);
      // In offline/isolated testing without gateway lease endpoint, allow if not explicitly blocked
      return {
        acquired: this.config.NODE_ENV === 'test' ? true : false,
        error: err.message,
      };
    }
  }

  /**
   * Explicitly release lease upon graceful container shutdown
   */
  async releaseLease() {
    if (!this.isHoldingLease) return { released: true };

    try {
      const releaseUrl = this.config.GATEWAY_LEASE_RELEASE_URL || 'https://api.sayapp.top/api/v1/billing/bridge/lease/release';
      const res = await this.fetch(releaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SayApp-Bridge-Secret': this.config.BRIDGE_SECRET_KEY,
          'User-Agent': `SayApp-BankBridge/${this.config.WORKER_PROVIDER || 'koyeb'}`,
        },
        body: JSON.stringify({
          worker_id: this.config.WORKER_ID || 'koyeb_default',
        }),
      });

      this.isHoldingLease = false;
      this.leaseUntil = 0;
      return { released: res.ok };
    } catch (err) {
      console.warn(`[LeaseManager] Release error: ${err.message}`);
      this.isHoldingLease = false;
      return { released: false, error: err.message };
    }
  }

  /**
   * Check if current worker can proceed with MBBank queries
   */
  async canExecuteSync() {
    const now = Date.now();
    // If lease has > 5 seconds remaining, renew in background or allow
    if (this.isHoldingLease && this.leaseUntil > now + 5000) {
      return true;
    }

    const result = await this.tryAcquireLease();
    return Boolean(result.acquired);
  }

  getStatus() {
    return {
      provider: this.config.WORKER_PROVIDER,
      worker_id: this.config.WORKER_ID,
      isHoldingLease: this.isHoldingLease,
      fencingToken: this.fencingToken,
      leaseUntil: this.leaseUntil ? new Date(this.leaseUntil).toISOString() : null,
      lastAcquireAt: this.lastAcquireAt ? this.lastAcquireAt.toISOString() : null,
      lastAcquireResult: this.lastAcquireResult,
    };
  }
}

module.exports = LeaseManager;
