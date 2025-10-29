// snapshot.js
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.flash.trade/leaderboard';

function csvNum(s) {
  const m = String(s || '').match(/[\d,]+(\.\d+)?/);
  if (!m) return 0;
  return Number(m[0].replace(/,/g, ''));
}
const fmtUsd = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '');

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
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}?nocache=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000); // 十分にレンダリングさせる

  const rows = await page.evaluate(() => {
    const tableRows = Array.from(document.querySelectorAll('table tbody tr'));
    return tableRows.slice(0, 20).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td =>
        (td.innerText || td.textContent || '').trim()
      )
    );
  });

  await browser.close();

  return rows.map(normalizeRow).filter(r => r.address).slice(0, 20);
}

function computeDiffs(today, yesterday) {
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));
  return today.map((t) => {
    const y = mapY.get(t.address);
    const deltaVP = y ? t.volumeNum - (y.volumeNum || 0) : null;
    const deltaRank = y ? t.rank - (y.rank || 0) : null;
    return { ...t, deltaVP, deltaRank };
  });
}

function htmlCard(rows) {
  const rowHtml = rows.map((r) => {
    const medalTxt = medal(r.rank);
    const deltaVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${fmtUsd(Math.abs(r.deltaVP))}`;
    const deltaRankTxt = r.deltaRank == null ? '–' : (r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` : r.deltaRank > 0 ? `▼${r.deltaRank}` : '＝');
    const deltaColor = r.deltaRank == null ? '#aaa' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#aaa';

    return `
      <tr>
        <td>${medalTxt}${String(r.rank).padStart(2, '0')}</td>
        <td>${r.address}</td>
        <td>${r.level}</td>
        <td>${r.faf}</td>
        <td style="text-align:right">${r.volume}</td>
        <td style="text-align:right">${deltaVP}</td>
        <td style="text-align:right;color:${deltaColor}">${deltaRankTxt}</td>
      </tr>
    `;
  }).join('');

  return `
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body { background: #0f151a; color: #e6f0f7; font-family: sans-serif; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 8px 10px; border-bottom: 1px solid #1b2732; }
      th { text-align: left; color: #99aab5; }
      .wrap { width: 1000px; margin: 20px auto; background: #0b1217; border-radius: 10px; padding: 16px; }
      h1 { font-size: 20px; margin-bottom: 10px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>FlashTrade Leaderboard — Top 20</h1>
      <table>
        <thead>
          <tr>
            <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th><th>ΔVP</th><th>ΔRank</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>
  </body>
  </html>
  `;
}

(async () => {
  const today = await fetchTop20();
  let yesterday = [];
  try {
    yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}
  const withDiff = computeDiffs(today, yesterday);
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/last.json', JSON.stringify(today, null, 2));

  const html = htmlCard(withDiff);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: 'leaderboard_card.png', fullPage: true });
  await browser.close();

  console.log('✅ leaderboard_card.png created successfully!');
})();
