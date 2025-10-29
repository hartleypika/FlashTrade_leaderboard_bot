// snapshot.js — FlashTrade Leaderboard: DOM安定版
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
const fixed = (s, w) => {
  s = String(s ?? '');
  return s.length <= w ? s : s.slice(0, w - 1) + '…';
};
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const timeStampUTC = () => new Date().toISOString().slice(0,16).replace('T',' ');

(async () => {
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 2100 },
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36'
  });

  // 軽いステルス
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await ctx.newPage();
  await page.goto(URL + '?_' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });

  // しっかり描画させる（軽くスクロール & 待機）
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 800); await sleep(400); }
  await sleep(800);

  // ❶ 見出し→列インデックスを確定
  const header = await page.evaluate(() => {
    const headRow =
      document.querySelector('table thead tr') ||
      document.querySelector('[role="table"] [role="rowgroup"] [role="row"]');
    if (!headRow) return null;
    const cells = Array.from(headRow.querySelectorAll('th, [role="columnheader"], td'))
                       .map(el => (el.innerText || el.textContent || '').trim());
    const indexByName = {};
    cells.forEach((label, idx) => {
      const L = label.toLowerCase();
      if (L.includes('rank')) indexByName.rank = idx;
      if (L.includes('address')) indexByName.address = idx;
      if (L.includes('level')) indexByName.level = idx;
      if (L === 'faf' || L.includes('faf')) indexByName.faf = idx;
      if (L.includes('voltage') || L === 'vp' || L.includes('points')) indexByName.vp = idx;
      if (L.includes('Δvp') || L.includes('dvp')) indexByName.deltaVp = idx;
      if (L.includes('Δrank') || L.includes('drank')) indexByName.deltaRank = idx;
    });
    return indexByName;
  });

  if (!header || header.address === undefined) {
    // 最低限の保険：表自体が見つからない場合でもスクショだけ残す
    await page.screenshot({ path: 'raw_page.png', fullPage: true });
    throw new Error('Header not detected. The table structure may have changed.');
  }

  // ❷ 各行の「Visit Profile」リンク（/profile/<address>）から完全アドレスを取得し、同じ行のセル値を読む
  const rows = await page.evaluate((header) => {
    const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const profileLinks = qAll('a[href*="/profile/"]');

    // 各リンクの祖先にある「行」をとる（role=row → tr → 近いdiv行の順）
    const getRowEl = (el) =>
      el.closest('[role="row"]') ||
      el.closest('tr') ||
      el.closest('div');

    // セルテキストを配列化
    const getCells = (row) => {
      const candidates = [
        () => qAll('td, th, [role="cell"], [data-column]', row),
        () => qAll(':scope > *', row),
      ];
      for (const fn of candidates) {
        const list = fn().map(c => (c.innerText || c.textContent || '').replace(/\s+/g,' ').trim()).filter(Boolean);
        if (list.length >= 4) return list;
      }
      // 最終手段：row全体テキストを粗く分割
      return (row.innerText || row.textContent || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    };

    const toIndex = (cells, idx, fallback = '') => {
      if (idx === undefined) return fallback;
      return cells[idx] ?? fallback;
    };

    const seen = new Set();
    const out = [];

    for (const a of profileLinks) {
      const m = a.getAttribute('href')?.match(/\/profile\/([1-9A-HJ-NP-Za-km-z]+)/);
      if (!m) continue;
      const address = m[1];
      if (seen.has(address)) continue; // 同一行の複数リンクを除外
      seen.add(address);

      const row = getRowEl(a);
      if (!row) continue;

      const cells = getCells(row);

      const rank = toIndex(cells, header.rank, '');
      const level = toIndex(cells, header.level, '');
      const faf = toIndex(cells, header.faf, '');
      const vp = toIndex(cells, header.vp, '');
      const deltaVp = toIndex(cells, header.deltaVp, '–');
      const deltaRank = toIndex(cells, header.deltaRank, '–');

      out.push({
        address,
        rank: Number(String(rank).replace(/[^\d]/g,'')) || null,
        level,
        faf,
        vp,
        deltaVp,
        deltaRank
      });
    }

    // rankが取れている行を優先し、なければリンク出現順
    out.sort((a,b) => {
      if (a.rank && b.rank) return a.rank - b.rank;
      if (a.rank) return -1;
      if (b.rank) return 1;
      return 0;
    });
    return out;
  }, header);

  // 総数チェック（少なければ再描画＆再取得）
  let top = rows;
  if (!top || top.length < 10) {
    // 少し上に戻って再描画してからもう一度拾う
    for (let i=0;i<4;i++){ await page.mouse.wheel(0,-800); await sleep(250); }
    for (let i=0;i<6;i++){ await page.mouse.wheel(0, 600); await sleep(250); }

    // 再評価（同ロジック）
    const retry = await page.evaluate((header) => {
      const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
      const profileLinks = qAll('a[href*="/profile/"]');
      const getRowEl = (el) => el.closest('[role="row"]') || el.closest('tr') || el.closest('div');
      const getCells = (row) => {
        const list = Array.from(row.querySelectorAll('td, th, [role="cell"], [data-column]'))
          .map(c => (c.innerText || c.textContent || '').replace(/\s+/g,' ').trim()).filter(Boolean);
        return list.length ? list : (row.innerText || row.textContent || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      };
      const toIndex = (cells, idx, fallback='') => (idx===undefined ? fallback : (cells[idx] ?? fallback));
      const seen = new Set();
      const out = [];
      for (const a of profileLinks) {
        const m = a.getAttribute('href')?.match(/\/profile\/([1-9A-HJ-NP-Za-km-z]+)/);
        if (!m) continue;
        const address = m[1];
        if (seen.has(address)) continue;
        seen.add(address);
        const row = getRowEl(a);
        if (!row) continue;
        const cells = getCells(row);
        const rank = toIndex(cells, header.rank, '');
        const level = toIndex(cells, header.level, '');
        const faf = toIndex(cells, header.faf, '');
        const vp = toIndex(cells, header.vp, '');
        const deltaVp = toIndex(cells, header.deltaVp, '–');
        const deltaRank = toIndex(cells, header.deltaRank, '–');
        out.push({
          address,
          rank: Number(String(rank).replace(/[^\d]/g,'')) || null,
          level, faf, vp, deltaVp, deltaRank
        });
      }
      out.sort((a,b) => (a.rank && b.rank) ? a.rank - b.rank : a.rank ? -1 : b.rank ? 1 : 0);
      return out;
    }, header);
    top = retry;
  }

  // 右上の「Total Volume Traded (Today)」
  const totalToday = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const m = txt.match(/Total\s+Volume\s+Traded\s+\(Today\)\s*:\s*\$[\d,]+/i);
    if (!m) return null;
    const m2 = m[0].match(/\$[\d,]+/);
    return m2 ? m2[0] : null;
  });

  // スクショ（デバッグ用）
  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // 画像用データ成形
  const normalized = (top || [])
    .filter(r => r.address)
    .slice(0, 20)
    .map((r, i) => ({
      rank: r.rank ?? (i+1),
      address: r.address,
      level: r.level?.replace(/\s+/g,' ').trim() || '',
      faf: r.faf?.replace(/\s+/g,' ').trim() || '',
      volume: r.vp || '',
      dVP: r.deltaVp || '–',
      dRank: r.deltaRank || '–'
    }));

  // 差分用の last.json 更新（任意：volume 数値化を保存）
  try {
    const snapshotForDiff = normalized.map(x => ({
      rank: x.rank, address: x.address,
      level: x.level, faf: x.faf,
      volumeNum: num(x.volume)
    }));
    await fs.writeFile(path.join('data','last.json'), JSON.stringify(snapshotForDiff, null, 2));
  } catch {}

  // ❸ カード描画（列幅固定で重なり防止）
  const rowsHtml = (normalized.length ? normalized : new Array(20).fill(null))
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx+1).padStart(2,'0')}</td><td></td><td></td><td></td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>`;
      }
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
