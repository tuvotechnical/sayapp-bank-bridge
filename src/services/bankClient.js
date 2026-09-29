/**
 * SayApp Bank Bridge — Bank Client Service
 * Encapsulates MBBank authentication, automatic ONNX CAPTCHA resolution,
 * session handling, and transaction history retrieval.
 */

let MBClass = null;

try {
  // First attempt: standard npm package
  const mbbankModule = require('mbbank');
  MBClass = mbbankModule.MB || mbbankModule.default || mbbankModule;
} catch (e1) {
  try {
    // Second attempt: local reference build if npm package not yet installed in local dev
    const path = require('path');
    const localRef = path.join(__dirname, '..', '..', 'reference', 'MBBank', 'dist', 'index.js');
    const mbbankRef = require(localRef);
    MBClass = mbbankRef.MB || mbbankRef.default || mbbankRef;
  } catch (e2) {
    // Will run in mock mode if in test or if library is missing
    MBClass = null;
  }
}

class BankClient {
  constructor(config, customDriver = null) {
    this.config = config;
    this.client = customDriver;
    this.isLoggedIn = false;
    this.lastLoginAt = null;
    this.loginPromise = null;
    this.lastError = null;
    this.errorCount = 0;
    this.consecutiveLoginFailures = 0;
    this.circuitBreakerUntil = 0;
  }

  /**
   * Check if client is properly configured with credentials
   */
  isConfigured() {
    return Boolean(this.config.MB_USERNAME && this.config.MB_PASSWORD && this.config.MB_ACCOUNT_NUMBER);
  }

  /**
   * Log in to MBBank Internet Banking
   */
  async login() {
    const now = Date.now();
    if (this.circuitBreakerUntil > now) {
      const waitMinutes = Math.ceil((this.circuitBreakerUntil - now) / 60000);
      throw new Error(`Circuit breaker active: MBBank logins paused for ${waitMinutes}m after 3 consecutive failures`);
    }

    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this._doLogin();
    try {
      const result = await this.loginPromise;
      this.consecutiveLoginFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveLoginFailures++;
      if (this.consecutiveLoginFailures >= 3) {
        this.circuitBreakerUntil = Date.now() + 15 * 60 * 1000; // 15 phút
        console.error('[BankClient] Circuit breaker triggered! Pausing MBBank logins for 15 minutes.');
      }
      throw err;
    } finally {
      this.loginPromise = null;
    }
  }

  async _doLogin() {
    if (!this.isConfigured() && this.config.NODE_ENV !== 'test') {
      const err = new Error('MBBank credentials not configured in environment variables');
      this.lastError = err.message;
      throw err;
    }

    // In test environment or when custom driver is supplied
    if (this.client && typeof this.client.login === 'function') {
      try {
        await this.client.login();
        this.isLoggedIn = true;
        this.lastLoginAt = new Date();
        this.lastError = null;
        return { success: true };
      } catch (err) {
        this.isLoggedIn = false;
        this.lastError = err.message;
        this.errorCount++;
        throw err;
      }
    }

    if (!MBClass) {
      if (this.config.NODE_ENV === 'test') {
        // Mock fallback in test mode
        this.isLoggedIn = true;
        this.lastLoginAt = new Date();
        return { success: true, mock: true };
      }
      throw new Error('MBBank library not available. Please run npm install.');
    }

    try {
      console.log(`[BankClient] Authenticating with MBBank account ${this.config.MB_USERNAME}...`);
      this.client = new MBClass({
        username: this.config.MB_USERNAME,
        password: this.config.MB_PASSWORD,
        preferredOCRMethod: 'default',
        saveWasm: false,
      });

      await this.client.login();
      this.isLoggedIn = true;
      this.lastLoginAt = new Date();
      this.lastError = null;
      console.log('[BankClient] MBBank authentication successful.');
      return { success: true };
    } catch (err) {
      this.isLoggedIn = false;
      this.lastError = err.message;
      this.errorCount++;
      console.error(`[BankClient] MBBank login failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Lightweight ping using getBalance()
   */
  async getBalance() {
    if (!this.isLoggedIn || !this.client) {
      await this.login();
    }

    try {
      if (this.client && typeof this.client.getBalance === 'function') {
        return await this.client.getBalance();
      }
      // Mock fallback for testing
      return { totalBalance: '10000000', currency: 'VND' };
    } catch (err) {
      if (this._isSessionExpired(err)) {
        console.warn('[BankClient] Session expired during getBalance (GW200), re-logging in...');
        this.isLoggedIn = false;
        await this.login();
        if (this.client && typeof this.client.getBalance === 'function') {
          return await this.client.getBalance();
        }
      }
      this.lastError = err.message;
      throw err;
    }
  }

  /**
   * Retrieve transaction history
   * @param {string} fromDate - DD/MM/YYYY
   * @param {string} toDate - DD/MM/YYYY
   */
  async getTransactionsHistory(fromDate, toDate) {
    if (!this.isLoggedIn || !this.client) {
      await this.login();
    }

    try {
      if (this.client && typeof this.client.getTransactionsHistory === 'function') {
        const result = await this.client.getTransactionsHistory({
          accountNumber: this.config.MB_ACCOUNT_NUMBER,
          fromDate,
          toDate,
        });
        return Array.isArray(result) ? result : (result?.transactionHistoryList || []);
      }

      // Mock fallback for test environment
      return [];
    } catch (err) {
      if (this._isSessionExpired(err)) {
        console.warn('[BankClient] Session expired during getTransactionsHistory (GW200), re-logging in...');
        this.isLoggedIn = false;
        await this.login();
        if (this.client && typeof this.client.getTransactionsHistory === 'function') {
          const retryResult = await this.client.getTransactionsHistory({
            accountNumber: this.config.MB_ACCOUNT_NUMBER,
            fromDate,
            toDate,
          });
          return Array.isArray(retryResult) ? retryResult : (retryResult?.transactionHistoryList || []);
        }
      }
      this.lastError = err.message;
      throw err;
    }
  }

  _isSessionExpired(err) {
    const msg = (err?.message || '').toUpperCase();
    return msg.includes('GW200') || msg.includes('SESSION') || msg.includes('UNAUTHORIZED');
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      isLoggedIn: this.isLoggedIn,
      lastLoginAt: this.lastLoginAt ? this.lastLoginAt.toISOString() : null,
      accountNumber: this.config.MB_ACCOUNT_NUMBER
        ? `***${this.config.MB_ACCOUNT_NUMBER.slice(-4)}`
        : null,
      lastError: this.lastError,
      errorCount: this.errorCount,
      consecutiveLoginFailures: this.consecutiveLoginFailures,
      circuitBreakerUntil: this.circuitBreakerUntil ? new Date(this.circuitBreakerUntil).toISOString() : null,
      circuitBreakerActive: this.circuitBreakerUntil > Date.now(),
    };
  }
}

module.exports = BankClient;
