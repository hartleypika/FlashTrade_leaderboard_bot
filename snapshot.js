// snapshot.js — robust version: retries + Grid/Table/Text fallback + stable card
const fs = require('fs/promises');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const toInt = (s) => {
  if (typeof s === 'number') return Math.round(s);
  const m = String(s ?? '').match(/[\d,]+(\.\d+)?/);
  return m ? Math.round(Number(m[0].replace(/,/g, ''))) : 0;
};
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 16);

async function pageReady(page) {
  // どれかが満たされればOK
  const ok = await page.evaluate(() => {
    const hasGrid =
      document.querySelector('[role="grid"] [role="rowgroup"] [role="row"]') !== null;
    const hasTable = document.querySelector('table tbody tr') !== null;
    const text = document.body.innerText || '';
    const addr = (text.match(/[1-9A-HJ-NP-Za-km-z]{20,}/g) || []).length;
    return hasGrid || hasTable || addr >= 10;
  });
  return ok;
}

async function extractRows(page) {
  // 1) Grid 優先
  let rows = await page.$$eval(
    '[role="grid"] [role="rowgroup"] [role="row"]',
    (nodes) =>
      nodes.map((r) =>
        Array.from(r.querySelectorAll('[role="cell"], td, div'))
          .map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
  ).catch(() => []);

  // 2) Table フォールバック
  if (!rows || rows.length < 10) {
    rows = await page.$$eval('table tbody tr', (trs) =>
      Array.from(trs).map((tr) =>
        Array.from(tr.querySelectorAll('td'))
          .map((td) => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).catch(() => []);
  }

  // 3) Text 最終手段
  if (!rows || rows.length < 10) {
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const idxs = [];
    lines.forEach((s, i) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(s) && idxs.push(i));

    rows = idxs.slice(0, 30).map((i) => {
      const address = lines[i];
      const neighborhood = lines.slice(Math.max(0, i - 4), i + 6);
      const lvlLine = neighborhood.find((s) => /LVL\s*\d+/i.test(s)) || '';
      const fafLine = neighborhood.find((s) => /([\d,]+)\s*FAF/i.test(s)) || '';
      const vpLine = neighborhood.find((s) => /\d[\d,]{2,}/.test(s)) || '';
      return [String(i + 1), address, `${lvlLine} ${fafLine}`.trim(), vpLine];
    });
  }

  // 正規化：Rank | Address | Level/FAF | Voltage Points
  const parsed = rows
    .map((cells) => {
      // rank は左端 or 先頭の番号を拾う（なければ null）
      const rank =
        Number(String(cells[0] || '').replace(/[^\d]/g, '')) ||
        Number(String(cells[1] || '').replace(/[^\d]/g, '')) ||
        null;

      // address は長い英数（base58 に近い）の最初のもの
      const addr =
        (cells.find((s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(s)) || '').trim();

      // Level/FAF の混在セル
      const lvlfaf = (cells[2] || cells[1] || '').toUpperCase();
      const level = (lvlfaf.match(/LVL\s*\d+/) || [''])[0].replace(/\s+/g, ' ');
      const faf = (lvlfaf.match(/([\d,]+)\s*FAF/) || [,''])[1] || '';

      // Voltage Points（数値行の中で最大っぽいものを採用）
      const vpCand = cells.slice(0, 6).map(toInt);
      const vp = Math.max(...vpCand, 0);

      return { rank, address: addr, fullAddress: addr, level, faf, vp };
    })
    .filter((r) => r.rank && r.address && r.vp)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);

  return parsed;
}

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

  // ---- ナビゲーション & リトライ（最大5回）----
  let ready = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`${URL}?_=${Date.now()}_${attempt}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    // 遅延描画対策にスクロール
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(400);
    }
    ready = await pageReady(page);
    if (ready) break;
    await page.waitForTimeout(1500);
  }

  // 参照用スクショは常に保存
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(() => {});

  // ---- ヘッダ右上の Today 合計 ----
  const totalToday = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('div,span'));
    const head = all.find((el) =>
      /Total\s+Volume\s+Traded\s*\(Today\)/i.test(el.textContent || '')
    );
    if (!head) return null;
    const num = (head.textContent || '').match(/\$?\s*([\d,]+)/);
    return num ? Number(num[1].replace(/,/g, '')) : null;
  });

  // ---- Top20 抽出（Grid→Table→Text）----
  let rows = [];
  try {
    rows = await extractRows(page);
  } catch (e) {
    // 失敗時は HTML を残す
    await fs.writeFile('debug_page.html', await page.content(), 'utf8').catch(() => {});
  }

  // Δ計算（前回保存）
  let last = { totalToday: null, rows: [] };
  try {
    last = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}
  const lastMap = new Map((last.rows || []).map((r) => [r.fullAddress, r]));
  const withDiff = rows.map((r) => {
    const y = lastMap.get(r.fullAddress);
    return {
      ...r,
      deltaVP: y ? r.vp - (y.vp || 0) : null,
      deltaRank: y ? r.rank - (y.rank || 0) : null,
    };
  });

  await fs.writeFile(
    'data/last.json',
    JSON.stringify({ totalToday, rows }, null, 2),
    'utf8'
  ).catch(() => {});

  // ---- カード描画（列幅固定で重なり防止）----
  const yesterdayTotal = last.totalToday;
  const totalDelta =
    totalToday != null && yesterdayTotal != null ? totalToday - yesterdayTotal : null;
  const totalLine =
    totalToday == null
      ? '—'
      : `$${fmtNum(totalToday)}${
          totalDelta == null
            ? ''
            : ` ( ${totalDelta >= 0 ? '+' : '−'}$${fmtNum(Math.abs(totalDelta))} vs Yesterday )`
        }`;

  const bodyRows = (withDiff.length ? withDiff : new Array(20).fill(null))
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>`;
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

      // 表示用に住所は短縮、title にフル
      const shortAddr = (r.fullAddress || '').slice(0, 44);

      return `<tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
        <td title="${r.fullAddress}">${shortAddr}</td>
        <td>${(r.level || '').toUpperCase()}</td>
        <td class="num">${r.faf || '—'}</td>
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
  /* 列幅（住所を詰め、数値列広め） */
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
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${utcNow()} ・ Source: flash.trade/leaderboard</div>
  </div>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ generated: leaderboard_card.png (and raw_page.png)');
})();
