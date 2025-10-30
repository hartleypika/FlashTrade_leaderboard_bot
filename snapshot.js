// snapshot.js — Full page-text → 改良パーサ → 画像生成（スクショも保存）
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// ========= ヘルパ =========
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const timeStampUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const toNum = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || 0;
const fmtUSD = (n) => '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const fixed = (str, max) => {
  str = String(str ?? '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
};

// ========= 改良版「超しつこい」行抽出ロジック =========
function parseOCR(ocrText) {
  const lines = ocrText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];

  for (const raw of lines) {
    const line = raw.replace(/\s{2,}/g, ' ');

    // <01> ～ <20>
    const rM = line.match(/<\s*0?([1-9]|1\d|20)\s*>/);
    if (!rM) continue;
    const rank = Number(rM[1]);

    // アドレス（…/…/… 省略表現含む）
    const aM = line.match(/[A-Za-z0-9]{2,}\s?(?:\.{3,}|…)\s?[A-Za-z0-9]{2,}/);
    if (!aM) continue;
    const address = aM[0].replace(/\s+/g, '');

    // LVL
    const lM = line.match(/LVL\s?\d+/i);
    const level = lM ? lM[0].replace(/\s+/g, '').toUpperCase() : '';

    // FAF（数字 + "FAF" のゆるい検出）
    const fM = line.match(/([\d,.\s]{3,})\s*FAF/i);
    const faf = fM ? fM[1].replace(/[^\d,]/g, '') : '';

    // VP: 行中の “カンマ区切りの大きい数値” の最後
    const nums = [...line.matchAll(/[\d,]{1,3}(?:,\d{3})+/g)].map((m) => m[0]);
    let vpText = '';
    if (nums.length) {
      vpText = nums[nums.length - 1];
      if (faf && vpText === faf && nums.length >= 2) vpText = nums[nums.length - 2];
    }
    const vpNum = toNum(vpText);

    rows.push({ rank, address, level, faf, vpText, vpNum });
  }

  rows.sort((a, b) => a.rank - b.rank || b.vpNum - a.vpNum);

  // 1～20の穴埋め
  const top = [];
  for (let r = 1; r <= 20; r++) {
    const hit = rows.find((x) => x.rank === r);
    top.push(hit || { rank: r, address: '', level: '', faf: '', vpText: '', vpNum: 0 });
  }
  return top;
}

// ヘッダー “Epoch #x Volume Traded $xxx” → なければ Top20 合計
function parseHeaderTotal(ocrText, rows) {
  const m = ocrText.match(/Epoch\s*#?\s*\d+\s*Volume\s*Traded\s*\$([\d,\.]+)/i);
  if (m) return fmtUSD(toNum(m[1]));
  const sum = rows.reduce((a, b) => a + (b.vpNum || 0), 0);
  return fmtUSD(sum);
}

// ========= メイン =========
;(async () => {
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 2500 },
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  const page = await ctx.newPage();

  // ロードをしつこく待つ
  for (let i = 1; i <= 3; i++) {
    await page.goto(`${URL}?_=${Date.now()}_${i}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}
    for (let k = 0; k < 6; k++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(400);
    }
    const ok = await page
      .evaluate(() => /[A-Za-z0-9]{2,}\.{3,}[A-Za-z0-9]{2,}/.test(document.body.innerText))
      .catch(() => false);
    if (ok) break;
    await page.waitForTimeout(1200);
  }

  // 証跡スクショ
  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // 全選択テキスト
  const ocrText = await page.evaluate(() => document.body.innerText);
  await fs.writeFile(path.join('data', 'last_ocr.txt'), ocrText, 'utf8');

  // 解析
  const rows = parseOCR(ocrText);
  const totalStr = parseHeaderTotal(ocrText, rows);
  await fs.writeFile(path.join('data', 'last_rows.json'), JSON.stringify(rows, null, 2), 'utf8');

  // ===== 画像用 HTML（ここで vpNum を直接使用して NaN を根絶）=====
  const rowsHtml = rows
    .map((r) => {
      const vpCell = r.vpNum > 0 ? fmtUSD(r.vpNum) : '—';
      return `
      <tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
        <td title="${r.address}">${fixed(r.address, 46)}</td>
        <td>${r.level || ''}</td>
        <td>${r.faf || '—'}</td>
        <td style="text-align:right">${vpCell}</td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7;}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px}
    .title{font-size:24px;font-weight:700}
    .total{margin-left:auto;font-weight:700}
    .total small{color:var(--muted);font-weight:500;margin-right:10px}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:120px}
    th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:110px}
    th:nth-child(4),td:nth-child(4){width:160px}
    th:nth-child(5),td:nth-child(5){width:170px;text-align:right}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style></head>
  <body><div class="wrap">
    <div class="head">
      <div class="title">FlashTrade VP Leaderboard — Top 20</div>
      <div class="total"><small>Total VP (Today):</small>${totalStr}</div>
    </div>
    <table>
      <thead><tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>VP Today</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: raw_page.png / data/last_ocr.txt / data/last_rows.json / leaderboard_card.png');
})();