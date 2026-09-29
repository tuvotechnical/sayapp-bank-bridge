const path = require('path');
const fs = require('fs');

// Read .env manually to avoid dotenv dependency
const envFile = path.resolve(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf8');
  for (const l of content.split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx > 0) {
      const k = t.slice(0, idx).trim();
      let v = t.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const BankClient = require('../src/services/bankClient.js');
const config = require('../src/config.js');

function formatDateDDMMYYYY(date) {
  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

async function main() {
  console.log('=== SayApp Bank Sync Execution ===');
  console.log('Account:', config.MB_ACCOUNT_NUMBER);
  console.log('Secret configured:', Boolean(config.BRIDGE_SECRET_KEY));

  const client = new BankClient(config);

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fromDate = formatDateDDMMYYYY(yesterday);
  const toDate = formatDateDDMMYYYY(now);

  console.log(`Fetching MBBank transactions from ${fromDate} to ${toDate}...`);
  const rawList = await client.getTransactionsHistory(fromDate, toDate);
  console.log(`Total transactions returned by MBBank: ${rawList?.length || 0}`);

  const credits = (rawList || [])
    .filter(tx => parseFloat(tx.creditAmount || '0') > 0)
    .map(tx => ({
      refNo: tx.refNo || tx.transactionId || `MB_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      creditAmount: parseFloat(tx.creditAmount),
      transactionDesc: tx.transactionDesc || tx.description || '',
      postDate: tx.postDate || tx.postingDate || tx.transactionDate || '',
      accountNumber: tx.accountNumber || tx.accountNo || config.MB_ACCOUNT_NUMBER || '',
    }));

  console.log(`Credit transactions found: ${credits.length}`);
  for (const c of credits) {
    console.log(` -> +${c.creditAmount} VND | Desc: ${c.transactionDesc} | Ref: ${c.refNo}`);
  }

  if (credits.length === 0) {
    console.log('No credit transactions to dispatch.');
    return;
  }

  const endpoints = [
    'http://127.0.0.1:1420/api/v1/billing/webhook/bank-bridge',
    'https://api.sayapp.top/api/v1/billing/webhook/bank-bridge'
  ];

  for (const ep of endpoints) {
    try {
      console.log(`Posting batch to ${ep}...`);
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SayApp-Bridge-Secret': config.BRIDGE_SECRET_KEY,
          'User-Agent': 'SayApp-BankBridge/1.0',
        },
        body: JSON.stringify({
          provider: 'local',
          transactions: credits,
        }),
      });

      const body = await res.json().catch(() => ({}));
      console.log(`Response from ${ep}: status ${res.status}`, body);
    } catch (err) {
      console.warn(`Error posting to ${ep}: ${err.message}`);
    }
  }

  console.log('=== Bank Sync Finished ===');
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
