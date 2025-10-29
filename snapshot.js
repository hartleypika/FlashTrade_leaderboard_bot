// snapshot.js
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.flash.trade/leaderboard';

// 小物ユーティリティ
const pickNumber = (s) => {
  const m = String(s ?? '').match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
};
const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '');

// 行→正規化
function normalizeRow(tds) {
  const safe = (i) => (tds[i] ?? '').toString().trim();
  let rank = Number(String(safe(0)).replace(/[^\d]/g, '')) || 0;
  let address = safe(1);
  let level = String(safe(2)).replace(/[^\d.,-]/g, '');
  let faf = String(safe(3)).replace(/[^\d.,-]/g, '');
  let volume = safe(4);

  // volume が見つからない構成にも対応（$ を含む列をサーチ）
  if (!/\$\d/.test(volume)) {
    const found = (tds || []).find((x) => /\$\d/.test(String(x)));
    if (found) volume = found;
  }

  return {
    rank,
    address,
    level,
    faf,
    volume,
    volumeNum: pickNumber(volume),
  };
}

// 本体
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // キャッシュ抑止
  await page.setExtraHTTPHeaders({
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  });

  // 取得
  const url = `${BASE_URL}?nocache=${Date.now()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // スクロール＆待機しながら、行が出るまで最大20秒待つ
  await page.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('table tbody tr').length >= 10 ||
      document.querySelectorAll('[role="row"]').length >= 10,
    { timeout: 20000, polling: 1000 }
  ).catch(() => {});

  // DOM から複数パターンで抽出（どちらか多い方を採用）
  const rows = await page.evaluate(() => {
    const fromTable = Array.from(document.querySelectorAll('table tbody tr'))
      .slice(0, 20)
      .map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) =>
          (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
        )
      );

    const fromRole = Array.from(document.querySelectorAll('[role="row"]'))
      .map((row) =>
        Array.from(row.querySelectorAll('[role="cell"], td')).map((c) =>
          (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim()
        )
      )
      .filter((cells) => cells.length >= 4)
      .slice(0, 20);

    return fromTable.length >= 10 ? fromTable : fromRole;
  });

  // 失敗時はデバッグ用に HTML を保存して終了
  if (!rows || rows.length === 0) {
    await fs.mkdir('debug', { recursive: true });
    await fs.writeFile('debug/page.html', await page.content(), 'utf8');
    await browser.close();
    console.error('No rows captured. Saved HTML to debug/page.html');
    process.exit(1);
  }

  const top20 = rows.map(normalizeRow).filter((r) => r.address).slice(0, 20);

  // 前日データ読み込み
  let yesterday = [];
  try {
    yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}

  // 差分算出
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));
  const withDiff = top20.map((t) => {
    const y = mapY.get(t.address);
    return {
      ...t,
      deltaVP: y ? t.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? t.rank - (y.rank || 0) : null,
    };
  });

  // 次回用に保存
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/last.json', JSON.stringify(top20, null, 2), 'utf8');

  // ===== レンダリング（画像カード） =====
  const rowsHtml = withDiff
    .map((r) => {
      const m = medal(r.rank);
      const dVP =
        r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${fmtUsd(Math.abs(r.deltaVP))}`;
      const dRank =
        r.deltaRank == null
          ? '–'
          : r.deltaRank < 0
          ? `▲${Math.abs(r.deltaRank)}`
          : r.deltaRank > 0
          ? `▼${r.deltaRank}`
          : '＝';
      const dRankColor =
        r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

      return `
        <tr>
          <td>${m}${String(r.rank).padStart(2, '0')}</td>
          <td>${r.address}</td>
          <td>${r.level}</td>
          <td>${r.faf}</td>
          <td style="text-align:right">${r.volume}</td>
          <td style="text-align:right">${dVP}</td>
          <td style="text-align:right;color:${dRankColor}">${dRank}</td>
        </tr>`;
    })
    .join('');

  const html = `
  <html>
  <head>
    <meta charset="utf-8"/>
    <style>
      body { margin:0; background:#0b1217; color:#e6f0f7; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial; }
      .wrap { width: 1200px; margin: 24px auto; background:#0f151a; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); overflow:hidden; }
      .title { padding:18px 22px; font-size:24px; font-weight:700; border-bottom:1px solid #1b2732; }
      table { width:100%; border-collapse:collapse; font-size:16px; }
      th, td { padding:12px 14px; border-bottom:1px solid #15202b; }
      th { text-align:left; color:#8aa1b1; font-weight:600; background:#0e151b; position:sticky; top:0; }
      tr:nth-child(even){ background:#0e151b; }
      td:first-child { width:110px; }
      td:nth-child(2) { width:420px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
      .footer { padding:12px 14px; color:#8aa1b1; font-size:12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <table>
        <thead>
          <tr>
            <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th style="text-align:right">Volume</th><th style="text-align:right">ΔVP</th><th style="text-align:right">ΔRank</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="footer">Snapshot (UTC): ${new Date().toISOString().slice(0,16).replace('T',' ')}</div>
    </div>
  </body>
  </html>`;

  // HTML を headless で画像化
  const cardPage = await context.newPage();
  await cardPage.setContent(html, { waitUntil: 'load' });
  // 実寸で撮る（全体）
  const bufName = 'leaderboard_card.png';
  await cardPage.screenshot({ path: bufName, fullPage: true });
  await browser.close();

  console.log(`✅ Generated ${bufName} with ${withDiff.length} rows`);
})();
