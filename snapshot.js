const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// メダル
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US');

// =====================
// ✅ OCR 行パーサ（改良版）
// =====================
function parseOCR(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // < 01 > ～ < 20 >
  const rankRe = /<\s*0?(?:[1-9]|1\d|20)\s*>/;
  const idx = [];
  for (let i = 0; i < lines.length; i++) if (rankRe.test(lines[i])) idx.push(i);
  if (!idx.length) return [];

  // rank ブロック切り出し
  const blocks = [];
  for (let i = 0; i < idx.length; i++) {
    const chunk = lines.slice(idx[i], idx[i + 1] ?? lines.length).join(' ');
    blocks.push(chunk.replace(/\s{2,}/g, ' '));
  }

  const out = [];
  for (const b of blocks) {
    const rm = b.match(/<\s*0?([1-9]|1\d|20)\s*>/);
    if (!rm) continue;
    const rank = Number(rm[1]);

    const am = b.match(/[A-Za-z0-9]{2,}\s?(?:\.{3,}|…)\s?[A-Za-z0-9]{2,}/);
    const address = am ? am[0].replace(/\s+/g, '') : '';

    const lm = b.match(/LVL\s*\d+/i);
    const level = lm ? lm[0].replace(/\s+/g, '').toUpperCase() : '';

    const fm = b.match(/([\d,.\s]{3,})\s*FAF\s*staked/i) || b.match(/([\d,.\s]{3,})\s*FAF/i);
    const faf = fm ? fm[1].replace(/[^\d,]/g, '') : '';

    const nums = [...b.matchAll(/[\d,]{1,3}(?:,\d{3})+/g)].map(m => m[0]);
    let vpText = '';
    if (nums.length) {
      vpText = nums[nums.length - 1];
      if (faf && vpText === faf && nums.length > 1) vpText = nums[nums.length - 2];
    }
    const vpNum = Number((vpText || '').replace(/[^\d]/g, '')) || 0;

    out.push({ rank, address, level, faf, vpNum });
  }

  out.sort((a, b) => a.rank - b.rank || b.vpNum - a.vpNum);

  const top = [];
  for (let r = 1; r <= 20; r++) {
    const row = out.find(x => x.rank === r);
    top.push(row || { rank: r, address: '', level: '', faf: '', vpNum: 0 });
  }
  return top;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 2200 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(4000);

  // スクショ保存
  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // ページテキスト取得
  const txt = await page.evaluate(() => document.body.innerText);
  await fs.writeFile('data/last_ocr.txt', txt);

  const rows = parseOCR(txt);

  // =====================
  // ✅ HTMLカードへ
  // =====================
  const total = (() => {
    const m = txt.match(/Volume\s*Traded[^$]*\$\s*([\d,]+)/i);
    return m ? '$' + m[1] : '—';
  })();

  const html = `
  <html><head><meta charset="utf-8"/>
  <style>
  body{margin:0;background:#0b1217;color:#e6f0f7;font:16px/1.4 system-ui}
  .wrap{width:1200px;margin:24px auto;background:#0f151a;border-radius:12px;overflow:hidden}
  .head{padding:18px 22px;border-bottom:1px solid #15202b;display:flex;gap:16px}
  .title{font-size:24px;font-weight:700}
  .total{margin-left:auto;font-weight:700}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px 14px;border-bottom:1px solid #15202b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{color:#8aa1b1;font-weight:600;background:#0e151b}
  tr:nth-child(even){background:#0e151b}
  </style></head><body>

  <div class="wrap">
    <div class="head">
      <div class="title">FlashTrade VP Leaderboard — Top 20</div>
      <div class="total">Total VP (Today): ${total}</div>
    </div>
    <table>
    <tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>VP Today</th></tr>
    ${rows.map(r=>`
      <tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2,'0')}</td>
        <td>${r.address}</td>
        <td>${r.level}</td>
        <td>${r.faf?Number(r.faf).toLocaleString():''}</td>
        <td>${fmt(r.vpNum)}</td>
      </tr>`).join('')}
    </table>
    <div style="padding:10px 14px;color:#8aa1b1;font-size:12px">
      Snapshot ${new Date().toISOString().slice(0,16).replace('T',' ')}
    </div>
  </div>
  </body></html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });
  await browser.close();

  console.log('✅ Done → raw_page.png & leaderboard_card.png');
})();