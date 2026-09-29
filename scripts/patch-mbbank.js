/**
 * Post-install patch for mbbank library in SayApp Bank Bridge
 * Ensures API endpoints match current MBBank gateway routes.
 */
const fs = require('fs');
const path = require('path');

const candidates = [
  path.join(__dirname, '..', 'node_modules', 'mbbank', 'dist', 'index.js'),
  path.join(__dirname, '..', '..', 'reference', 'MBBank', 'dist', 'index.js')
];

let filePath = candidates.find(p => fs.existsSync(p));

if (!filePath) {
  console.log('[SayApp Bank Bridge] mbbank dist/index.js not found — skipping patch for now.');
  process.exit(0);
}

try {
  let content = fs.readFileSync(filePath, 'utf8');
  let patched = 0;

  const fixes = [
    {
      from: '/api/retail-web-internetbankingms/getCaptchaImage',
      to: '/api/retail-internetbankingms/getCaptchaImage',
      desc: 'Captcha endpoint',
    },
    {
      from: '/api/retail-web-accountms/getBalance',
      to: '/api/retail-accountms/accountms/getBalance',
      desc: 'Balance endpoint',
    },
  ];

  // Fix Node.js 22/24 undici maxRedirections bug in downloadOnnxModel
  const oldDownloadCode = `const model = await (0, import_undici.request)("https://github.com/thedtvn/mbbank-capcha-ocr/raw/refs/heads/master/mb_capcha_ocr/model.onnx", {
        maxRedirections: 10,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      });
      const fileStream = (0, import_fs.createWriteStream)(this.modelPath);
      await new Promise((resolve, reject) => {
        model.body.pipe(fileStream);
        model.body.on("error", (err) => {
          reject(err);
        });
        fileStream.on("finish", () => {
          resolve();
        });
        fileStream.on("error", (err) => {
          reject(err);
        });
      });`;

  const newDownloadCode = `const resp = await fetch("https://raw.githubusercontent.com/thedtvn/mbbank-capcha-ocr/master/mb_capcha_ocr/model.onnx", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (!resp.ok) throw new Error(\`Failed to fetch ONNX model: \${resp.status}\`);
      const buf = Buffer.from(await resp.arrayBuffer());
      (0, import_fs.writeFileSync)(this.modelPath, buf);`;

  if (content.includes('maxRedirections: 10')) {
    content = content.replace(oldDownloadCode, newDownloadCode);
    console.log('[SayApp Bank Bridge] Patched downloadOnnxModel to use native fetch (fixes Node v24 undici error)');
    patched++;
  }

  // Fix modelPath resolution and container permission denied issue
  const oldModelPathCode = 'this.modelPath = modelPath || path.join(dirPath, "/../model.onnx");';
  const newModelPathCode = `const candPaths = [
      process.env.MB_MODEL_PATH,
      path.join(__dirname, "..", "model.onnx"),
      path.join(__dirname, "model.onnx"),
      "/app/model.onnx",
      "/tmp/model.onnx",
      path.join(dirPath, "/../model.onnx")
    ].filter(Boolean);
    const foundModel = candPaths.find(p => (0, import_fs.existsSync)(p));
    this.modelPath = modelPath || foundModel || (process.env.TMPDIR || "/tmp") + "/model.onnx";`;

  if (content.includes(oldModelPathCode)) {
    content = content.replace(oldModelPathCode, newModelPathCode);
    console.log('[SayApp Bank Bridge] Patched modelPath candidate resolution and fallback');
    patched++;
  }

  for (const fix of fixes) {
    if (content.includes(fix.from)) {
      content = content.replaceAll(fix.from, fix.to);
      console.log(`[SayApp Bank Bridge] Patched ${fix.desc}: ${fix.from} -> ${fix.to}`);
      patched++;
    }
  }

  if (patched > 0) {
    fs.writeFileSync(filePath, content);
    console.log(`[SayApp Bank Bridge] Patch completed. ${patched} endpoint(s) updated.`);
  } else {
    console.log('[SayApp Bank Bridge] Endpoints are up to date.');
  }
} catch (err) {
  console.warn('[SayApp Bank Bridge] Patch warning:', err.message);
}
