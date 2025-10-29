// snapshot.js
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.flash.trade/leaderboard';

function csvNum(s) {
  // "$12,345,678" → 12345678
  const m = String(s || '').match(/[\d,]+(\.\d+)?/);
  if (!m) return 0;
  return Number(m[0].replace(/,/g, ''));
}
const fmtUsd = (n) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '');

function normalizeRow(tds) {
  const safe = (i) => (tds[i] ?? '').toString().trim();
  let rank = safe(0).replace(/[^\d]/g, '');
  let address = safe(1);
  let level = safe(2);
  let faf = safe(3);
  let volume = safe(4);
  if (!/\$\d/.test(volume)) {
    const found = tds.find((s) => /\$\d/.test(String(s)));
    if (found) volume = found;
  }
  const num = (s) => String(s).replace(/[^\d.,\-]/g, '');
  return {
    rank: Number(rank) || 0,
    address,
    level: num(level),
    faf: num(faf),
    volume,
    volumeNum: csvNum(volume),
  };
}

async function fetchTop20() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 2200 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    locale: 'en-US',
  });
  await context.route('**/*', async (route) => {
    const headers = { ...route.request().headers(), 'cache-control': 'no-cache', pragma: 'no-cache' };
    await route.continue({ headers });
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}?nocache=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);

  // DOM抽出
  const rows = await page.evaluate(() => {
    const toRow = (els) =>
      els.slice(0, 25).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td =>
          (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
        )
      );
    const table = document.querySelectorAll('table tbody tr');
    if (table.length >= 5) return toRow(Array.from(table));
    const role = Array.from(document.querySelectorAll('[role="row"]'))
      .map(r => Array.from(r.querySelectorAll('[role="cell"]')).map(c =>
        (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim()
      ))
      .filter(c => c.length >= 4);
    return role.slice(0, 25);
  });

  await browser.close();

  const top = rows.map(normalizeRow).filter(r => r.address).slice(0, 20);
  return top;
}

function computeDiffs(today, yesterday) {
  const mapY = new Map((yesterday || []).map((r, i) => [r.address, { ...r, idx: i + 1 }]));
  return today.map((t, i) => {
    const y = mapY.get(t.address);
    const deltaVP = y ? t.volumeNum - (y.volumeNum || 0) : null;
    const deltaRank = y ? (i + 1) - (y.rank || y.idx) : null; // +は順位下落, -は上昇
    return { ...t, deltaVP, deltaRank };
  });
}

function htmlCard(rows, totalToday, totalYesterday) {
  const deltaTotal = totalYesterday != null ? totalToday - totalYesterday : null;
  const headDelta =
    deltaTotal == null ? '(– vs Yesterday)'
      : `${deltaTotal >= 0 ? '+' : ''}${fmtUsd(Math.abs(deltaTotal))} vs Yesterday`;

  const rowHtml = rows.map(r => {
    const arrow =
      r.deltaRank == null ? '＝'
      : r.deltaRank < 0   ? '▲'
      : r.deltaRank > 0   ? '▼'
      : '＝';
    const arrowColor =
      r.deltaRank == null ? '#aaa'
      : r.deltaRank < 0   ? '#2ecc71' // up
      : r.deltaRank > 0   ? '#e74c3c' // down
      : '#aaa';

    const medalTxt = medal(r.rank);
    const deltaVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${fmtUsd(Math.abs(r.deltaVP))}`;
    const deltaRankTxt = r.deltaRank == null ? '–' : `${arrow} ${Math.abs(r.deltaRank) || 0}`;

    return `
      <tr>
        <td class="rank">${medalTxt ? `<span class="medal">${medalTxt}</span>` : ''}${String(r.rank).padStart(2,'0')}</td>
        <td class="addr">${r.address}</td>
        <td>${r.level || ''}</td>
        <td>${r.faf || ''}</td>
        <td class="num">${r.volume || ''}</td>
        <td class="num ${r.deltaVP != null && r.deltaVP < 0 ? 'neg' : 'pos'}">${deltaVP}</td>
        <td class="num" style="color:${arrowColor}">${deltaRankTxt}</td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>FlashTrade Leaderboard — Top 20</title>
<style>
  @font-face { font-family: Inter; src: local("Inter"); font-weight: 400 700; }
  body{ margin:0; background:#0f151a; color:#e6f0f7; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
  .wrap{ width:1100px; margin:20px auto; padding:16px 20px; background:#0b1217; border-radius:14px; box-shadow:0 4px 40px rgba(0,0,0,.35); }
  h1{ margin:6px 0 4px; font-size:28px; letter-spacing:.2px;}
  .sub{ color:#9ab; font-size:13px; margin-bottom:14px; }
  .metric{ font-size:16px; margin: 8px 0 16px; }
  .metric strong{ font-size:18px; color:#fff; }
  table{ width:100%; border-collapse:collapse; font-size:14px; }
  th,td{ padding:10px 12px; white-space:nowrap; }
  th{ color:#99aab5; font-weight:600; border-bottom:1px solid #1b2732; }
  td{ border-bottom:1px solid rgba(255,255,255,.04); }
  .rank{ font-variant-numeric: tabular-nums; }
  .addr{ max-width:300px; overflow:hidden; text-overflow:ellipsis; }
  .num{ text-align:right; font-variant-numeric: tabular-nums; }
  .medal{ margin-right:6px; }
  .pos{ color:#2ecc71; }
  .neg{ color:#e74c3c; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="sub">Snapshot (UTC): ${new Date().toISOString().slice(0,16).replace('T',' ')}</div>
    <h1>FlashTrade Leaderboard — Top 20</h1>
    <div class="metric">Total Volume Traded (Today): <strong>${fmtUsd(totalToday)}</strong> <span class="sub">(${headDelta})</span></div>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Address</th>
          <th>Level</th>
          <th>FAF</th>
          <th>Volume</th>
          <th>Δ VP</th>
          <th>Δ Rank</th>
        </tr>
      </thead>
      <tbody>
        ${rowHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

(async () => {
  // 1) 今日
  const today = await fetchTop20();
  if (today.length < 5) {
    // 取れないときでも後続を止めない
    await fs.writeFile('leaderboard_card.png', Buffer.from([]));
    console.log('No rows; skipped.');
    process.exit(0);
  }

  // 2) 前日
  await fs.mkdir('data', { recursive: true });
  let yesterday = null;
  try {
    yesterday = JSON.parse(await fs.readFile(path.join('data', 'last.json'), 'utf8'));
  } catch {}

  const withDiff = computeDiffs(today, yesterday || []);
  const totalToday = today.reduce((s, r) => s + (r.volumeNum || 0), 0);
  const totalYesterday = yesterday ? yesterday.reduce((s, r) => s + (r.volumeNum || 0), 0) : null;

  // 3) HTML→PNG
  const html = htmlCard(withDiff, totalToday, totalYesterday);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 }); // 高解像度
  await page.setContent(html, { waitUntil: 'load' });
  const el = await page.$('.wrap');
  await el.screenshot({ path: 'leaderboard_card.png' });
  await browser.close();

  // 4) 今日を保存（次回の“前日”にする）
  await fs.writeFile(path.join('data','last.json'), JSON.stringify(today, null, 2), 'utf8');

  // 参考でJSONも保存
  await fs.writeFile('leaderboard_rows.json', JSON.stringify(withDiff, null, 2), 'utf8');

  console.log('Card image created: leaderboard_card.png');
})();
