/* snapshot.js */
const { chromium } = require('playwright');

const TARGET_URL = 'https://www.flash.trade/leaderboard';
const OUT_FILE   = 'leaderboard_snapshot.png';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1700 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();

  // キャッシュを殺して最新描画を促す
  await page.route('**/*', (route) => {
    const headers = {
      ...route.request().headers(),
      'cache-control': 'no-cache',
      'pragma': 'no-cache'
    };
    route.continue({ headers });
  });

  // ページへ（キャッシュバスター付き）
  await page.goto(`${TARGET_URL}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 少し人間っぽい待機
  await page.waitForTimeout(1200);

  // ---- ランキング行の頑健な取得 ----
  async function grabRows() {
    // 1) 通常の table > tbody > tr
    const v1 = await page.$$eval('table tbody tr', trs =>
      trs.slice(0, 30).map(tr => Array.from(tr.querySelectorAll('td'))
        .map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()))
    ).catch(() => []);

    if (v1?.length >= 5) return v1;

    // 2) ARIA ロールの行/セル
    const v2 = await page.$$eval('[role="row"]', rows =>
      rows.map(row =>
        Array.from(row.querySelectorAll('[role="cell"]'))
          .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
      ).filter(arr => arr.length >= 3).slice(0, 30)
    ).catch(() => []);

    if (v2?.length >= 5) return v2;

    // 3) 最終フォールバック：ページ全体テキストからの粗抽出
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    // 住所っぽいBase58・金額っぽい$… を頼りに雑に寄せる
    const addrRe = /[1-9A-HJ-NP-Za-km-z]{16,}/;
    const usdRe  = /\$\d{1,3}(,\d{3})*(\.\d+)?/;

    const rough = [];
    for (let i = 0; i < lines.length - 6 && rough.length < 30; i++) {
      const seg = lines.slice(i, i + 6);
      if (addrRe.test(seg.join(' ')) && usdRe.test(seg.join(' '))) {
        const address = (seg.find(s => addrRe.test(s)) || '').slice(0, 20);
        const volume  = seg.find(s => usdRe.test(s)) || '';
        rough.push(['', address, '', '', volume]);
      }
    }
    return rough;
  }

  // リトライで新鮮な rows を掴む
  let rows = [];
  for (let i = 0; i < 6; i++) {
    rows = await grabRows();
    if (rows.length >= 5) break;
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  if (!rows || rows.length < 5) {
    console.error('No rows captured.');
    await browser.close();
    process.exit(1);
  }

  // ---- 正規化（[rank,address,level,faf,volume] を揃える）----
  const normalize = (cols, idx) => {
    const get = (k) => (cols[k] ?? '').toString();
    let rank   = get(0).replace(/[^\d]/g, '') || String(idx + 1);
    let addr   = get(1);
    let level  = get(2);
    let faf    = get(3);
    let volume = get(4);

    if (!/\$\d/.test(volume)) {
      const f = cols.find(s => /\$\d/.test(s));
      if (f) volume = f;
    }
    const num = (s) => s.replace(/[^\d.,\-]/g, '');
    return {
      rank,
      address: addr,
      level: num(level),
      faf: num(faf),
      volume
    };
  };

  const top20 = rows
    .map((r, i) => normalize(r, i))
    .filter(r => r.address)
    .slice(0, 20);

  // ---- 自前HTMLで綺麗に描画してスクショ ----
  const utcTs = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const total = top20.reduce((sum, r) => {
    const m = r.volume.match(/\$([\d,\.]+)/);
    if (!m) return sum;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return sum + (isFinite(v) ? v : 0);
  }, 0);

  const medal = (n) => (n===1?'🥇':n===2?'🥈':n===3?'🥉':'');
  const esc = (s='') => s.replace(/[&<>"']/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const rowsHtml = top20.map(r => `
    <tr>
      <td class="rank">${medal(+r.rank)} <span>&lt; ${String(r.rank).padStart(2,'0')} &gt;</span></td>
      <td class="addr">${esc(r.address)}</td>
      <td class="level">${esc(r.level || '')}</td>
      <td class="faf">${esc(r.faf || '')}</td>
      <td class="vol">${esc(r.volume || '')}</td>
    </tr>`).join('');

  const totalFmt = `$${total.toLocaleString('en-US')}`;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    --bg:#0c1117; --panel:#0f1621; --row:#0d131c; --text:#dbe4ee; --muted:#95a1b3; --accent:#22d3ee;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{width:980px;margin:28px auto;padding:20px 24px;background:var(--panel);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
  h1{font-size:28px;margin:0 0 8px;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .total{font-size:18px;margin-bottom:14px}
  .total b{color:var(--accent)}
  table{width:100%;border-collapse:separate;border-spacing:0 8px;font-size:14px}
  thead th{color:#9fb1c6;font-weight:600;text-align:left;padding:8px 14px}
  tbody tr{background:var(--row)}
  tbody td{padding:12px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rank{width:160px;color:#cbd7e6}
  .rank span{opacity:.9}
  .addr{max-width:360px;font-family:ui-monospace,Menlo,Consolas,monospace}
  .level{width:90px;text-align:right;color:#cbd7e6}
  .faf{width:120px;text-align:right;color:#cbd7e6}
  .vol{width:160px;text-align:right;font-weight:700}
  tbody tr:hover{outline:1px solid rgba(255,255,255,.08)}
</style>
</head>
<body>
  <div class="wrap">
    <h1>⚡ FlashTrade Leaderboard — Top 20</h1>
    <div class="sub">Snapshot (UTC): ${utcTs}</div>
    <div class="total">Total Volume Traded (Today): <b>${totalFmt}</b> (– vs Yesterday)</div>
    <table>
      <thead>
        <tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th></tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  // 2nd pageにレンダリングして撮影
  const painter = await context.newPage();
  await painter.setViewportSize({ width: 1024, height: 1700 });
  await painter.setContent(html, { waitUntil: 'load' });
  await painter.screenshot({ path: OUT_FILE, fullPage: true });

  await browser.close();
  console.log(`Saved: ${OUT_FILE}`);
})();
