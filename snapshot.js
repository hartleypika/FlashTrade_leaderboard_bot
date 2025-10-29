// snapshot.js — FlashTrade Leaderboard card generator (stable DOM selectors)
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

// ===== helpers =====
const toInt = (s) => {
  if (typeof s === 'number') return Math.round(s);
  const m = String(s ?? '').match(/[\d,]+(\.\d+)?/);
  return m ? Math.round(Number(m[0].replace(/,/g, ''))) : 0;
};
const fmtNum = (n) => n.toLocaleString('en-US');
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 16);

// ===== main =====
(async () => {
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 2200 },
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  // 1) ページ到達 & テーブル描画待ち（ARIA Grid 前提）
  const URL = 'https://www.flash.trade/leaderboard';
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // スクロールで遅延描画を促す
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(400);
  }
  await page.waitForSelector('[role="grid"] [role="rowgroup"] [role="row"]', {
    timeout: 20_000,
  });

  // 2) ヘッダの Today 合計（右上の "Total Volume Traded (Today)"）を取得
  const totalToday = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('div,span'));
    const head = all.find((el) =>
      /Total\s+Volume\s+Traded\s*\(Today\)/i.test(el.textContent || '')
    );
    if (!head) return null;
    const num = (head.textContent || '').match(/\$?\s*([\d,]+)/);
    return num ? Number(num[1].replace(/,/g, '')) : null;
  });

  // 3) 表の Top20 を ARIA で確実に取る
  const rawRows = await page.$$eval(
    '[role="grid"] [role="rowgroup"] [role="row"]',
    (rows) =>
      rows.map((r) =>
        Array.from(r.querySelectorAll('[role="cell"], td, div'))
          .map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
  );

  // 先頭はヘッダ行のことがあるので、rank が取れる行のみ抽出
  const parsed = rawRows
    .map((cells) => {
      // 列想定: Rank | Address | Level/FAF | Voltage Points | Action
      const rank = Number(String(cells[0] || '').replace(/[^\d]/g, '')) || null;
      const address = (cells[1] || '').slice(0, 44); // 表示幅用に短縮（フルは title に載せます）
      const lvlFaf = cells[2] || '';
      const level = (lvlFaf.match(/LVL\s*\d+/i) || [''])[0].replace(/\s+/g, ' ').toUpperCase();
      const faf = (lvlFaf.match(/([\d,]+)\s*FAF/i) || [,''])[1] || '';
      const vp = toInt(cells[3]); // Voltage Points 列
      return { rank, address, level, faf, vp, fullAddress: cells[1] || '' };
    })
    .filter((r) => r.rank && r.address && r.vp)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);

  // 4) 昨日差分（ΔVP, ΔRank）
  let last = { totalToday: null, rows: [] };
  try {
    last = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}
  const lastMap = new Map((last.rows || []).map((r) => [r.fullAddress, r]));
  const withDiff = parsed.map((r, i) => {
    const y = lastMap.get(r.fullAddress);
    return {
      ...r,
      deltaVP: y ? r.vp - (y.vp || 0) : null,
      deltaRank: y ? r.rank - (y.rank || 0) : null,
    };
  });

  // 保存（次回差分用）
  await fs.writeFile(
    'data/last.json',
    JSON.stringify({ totalToday, rows: parsed }, null, 2),
    'utf8'
  );

  // 5) カード HTML をレンダリング
  const yesterdayTotal = last.totalToday;
  const totalDelta =
    totalToday != null && yesterdayTotal != null ? totalToday - yesterdayTotal : null;
  const totalLine =
    totalToday == null
      ? '—'
      : `$${fmtNum(totalToday)}${
          totalDelta == null ? '' : ` ( ${totalDelta >= 0 ? '+' : '−'}$${fmtNum(Math.abs(totalDelta))} vs Yesterday )`
        }`;

  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td></td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>`;
      }
      const dVP =
        r.deltaVP == null ? '—' : `${r.deltaVP >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.deltaVP))}`;
      const dR =
        r.deltaRank == null
          ? '—'
          : r.deltaRank < 0
          ? `▲${Math.abs(r.deltaRank)}`
          : r.deltaRank > 0
          ? `▼${r.deltaRank}`
          : '＝';
      const dRColor =
        r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

      return `<tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
        <td title="${r.fullAddress}">${r.address}</td>
        <td>${r.level}</td>
        <td class="num" title="${r.faf || ''}">${r.faf || '—'}</td>
        <td class="num">${fmtNum(r.vp)}</td>
        <td class="num">${dVP}</td>
        <td class="num" style="color:${dRColor}">${dR}</td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html><meta charset="utf-8"><style>
  :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
  .head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline}
  .title{font-size:22px;font-weight:700}
  .total{margin-left:auto;color:#cde7ff;font-weight:700}
  .total small{color:var(--muted);font-weight:600;margin-right:8px}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th,td{padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
  tr:nth-child(even){background:#0e151b}
  /* 列幅：住所を詰め、数値列を広めに。 */
  th:nth-child(1),td:nth-child(1){width:110px}
  th:nth-child(2),td:nth-child(2){width:330px;font-family:ui-monospace,Consolas,Menlo,monospace}
  th:nth-child(3),td:nth-child(3){width:110px}
  th:nth-child(4),td:nth-child(4){width:140px;text-align:right}
  th:nth-child(5),td:nth-child(5){width:180px;text-align:right}
  th:nth-child(6),td:nth-child(6){width:170px;text-align:right}
  th:nth-child(7),td:nth-child(7){width:110px;text-align:right}
  .num{text-align:right}
  .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style>
  <div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total"><small>Total Volume Traded (Today)</small>${totalLine}</div>
    </div>
    <table>
      <thead><tr>
        <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Voltage Points</th><th>ΔVP</th><th>ΔRank</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${utcNow()} ・ Source: flash.trade/leaderboard</div>
  </div>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  // 参考用に元ページのフルスクショも保存
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(() => {});

  await browser.close();
  console.log('✅ generated: leaderboard_card.png  (and raw_page.png for reference)');
})();
