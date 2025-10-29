// snapshot.js — FlashTrade Leaderboard: robust DOM reader
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toUsd = (n) => {
  const v = Number(String(n).replace(/[^\d.-]/g, '')) || 0;
  return '$' + Math.round(v).toLocaleString('en-US');
};
const num = (s) => Number(String(s).replace(/[^\d.-]/g, '')) || 0;
const fixed = (s, w) => (String(s ?? '').length <= w ? String(s ?? '') : String(s ?? '').slice(0, w - 1) + '…');
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const timeStampUTC = () => new Date().toISOString().slice(0,16).replace('T',' ');

(async () => {
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 2200 },      // 幅を広げて列を隠さない
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36'
  });

  // 軽いステルス
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await ctx.newPage();
  await page.goto(URL + '?_' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  // 少しスクロールして描画を促す
  for (let i=0;i<5;i++){ await page.mouse.wheel(0, 700); await sleep(250); }
  await sleep(700);

  // ヘッダ名→列インデックス
  const header = await page.evaluate(() => {
    const headRow =
      document.querySelector('table thead tr') ||
      document.querySelector('[role="table"] [role="rowgroup"] [role="row"]');
    if (!headRow) return null;
    const getText = el => (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
    const cells = Array.from(headRow.querySelectorAll('th,[role="columnheader"],td,div')).map(getText);
    const idx = {};
    cells.forEach((label, i) => {
      const L = label.toLowerCase();
      if (L.includes('rank')) idx.rank = i;
      if (L.includes('address')) idx.address = i;
      if (L.includes('level')) idx.level = i;
      if (L === 'faf' || L.includes('faf')) idx.faf = i;
      if (L.includes('voltage') || L === 'vp' || L.includes('points')) idx.vp = i;
      if (L.includes('Δvp') || L.includes('dvp')) idx.deltaVp = i;
      if (L.includes('Δrank') || L.includes('drank')) idx.deltaRank = i;
    });
    return idx;
  });

  if (!header || header.address === undefined) {
    await page.screenshot({ path: 'raw_page.png', fullPage: true });
    throw new Error('Header not detected. Table structure changed?');
  }

  // 行読み出し（リンクに依存しない）：tbody>tr か role=row を対象にヘッダ位置でセルを読む
  const rows = await page.evaluate((header) => {
    const qAll = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const getText = el => (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();

    // データ行候補
    let dataRows = qAll('table tbody tr');
    if (dataRows.length < 10) {
      const allRows = qAll('[role="table"] [role="rowgroup"] [role="row"]');
      // 先頭（ヘッダ）を除外
      dataRows = allRows.slice(1);
    }

    const list = [];
    for (const row of dataRows) {
      const cells = Array.from(row.querySelectorAll('td, [role="cell"], div')).map(getText).filter(Boolean);
      if (cells.length < 4) continue;

      const pick = (i, d='') => (i===undefined ? d : (cells[i] ?? d));

      // 省略表示のアドレス（4ky4Tk…sH4z 等）もそのまま採用
      const address = pick(header.address, '');
      if (!address) continue;

      const r = {
        rank: Number(String(pick(header.rank,'')).replace(/[^\d]/g,'')) || null,
        address,
        level: pick(header.level,''),
        faf: pick(header.faf,''),
        vp: pick(header.vp,''),
        deltaVp: pick(header.deltaVp,'–'),
        deltaRank: pick(header.deltaRank,'–')
      };
      list.push(r);
    }

    // rankがあればソート
    list.sort((a,b) => {
      if (a.rank && b.rank) return a.rank - b.rank;
      if (a.rank) return -1; if (b.rank) return 1; return 0;
    });

    return list.slice(0, 30);
  }, header);

  // 右上の “Total Volume Traded (Today)”
  const totalToday = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/Total\s+Volume\s+Traded\s+\(Today\)\s*:\s*\$[\d,]+/i);
    if (!m) return null;
    const m2 = m[0].match(/\$[\d,]+/);
    return m2 ? m2[0] : null;
  });

  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // 画像用に整形
  const top20 = (rows || []).filter(r => r.address).slice(0,20)
    .map((r,i) => ({
      rank: r.rank ?? (i+1),
      address: r.address,
      level: r.level?.trim() || '',
      faf: r.faf?.trim() || '',
      volume: r.vp || '',
      dVP: r.deltaVp || '–',
      dRank: r.deltaRank || '–'
    }));

  // last.json（差分用・任意）
  try {
    const snapshot = top20.map(x => ({ rank:x.rank, address:x.address, level:x.level, faf:x.faf, volumeNum: num(x.volume) }));
    await fs.writeFile(path.join('data','last.json'), JSON.stringify(snapshot, null, 2));
  } catch {}

  // カード描画（列幅固定で重なり防止）
  const rowsHtml = (top20.length ? top20 : new Array(20).fill(null)).map((r,idx) => {
    if (!r) return `<tr><td>${String(idx+1).padStart(2,'0')}</td><td></td><td></td><td></td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>`;
    return `<tr>
      <td>${medal(r.rank)}${String(r.rank).padStart(2,'0')}</td>
      <td title="${r.address}">${fixed(r.address, 44)}</td>
      <td title="${r.level}">${fixed(r.level, 14)}</td>
      <td title="${r.faf}">${fixed(r.faf, 16)}</td>
      <td class="num" title="${r.volume}">${r.volume || '–'}</td>
      <td class="num" title="${r.dVP}">${r.dVP}</td>
      <td class="num" title="${r.dRank}">${r.dRank}</td>
    </tr>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1240px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px}
    .title{font-size:24px;font-weight:700}
    .total{margin-left:auto;color:var(--muted)}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:110px}
    th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:140px}
    th:nth-child(4),td:nth-child(4){width:170px}
    th:nth-child(5),td:nth-child(5){width:170px;text-align:right}
    th:nth-child(6),td:nth-child(6){width:140px;text-align:right}
    th:nth-child(7),td:nth-child(7){width:110px;text-align:right}
    .num{text-align:right}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style></head>
  <body><div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total">Total Volume Traded (Today): <b>${totalToday ?? '—'}</b></div>
    </div>
    <table>
      <thead><tr>
        <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Voltage Points</th><th>ΔVP</th><th>ΔRank</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / data/last.json');
})();
