// snapshot_hybrid.js
// FlashTrade Leaderboard を「証跡スクショ + 全選択テキスト」から確実に抽出 → 画像カード生成
// 依存: playwright のみ（追加npm不要: actionsなら `npx playwright install --with-deps chromium`）

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// ---------- utils ----------
const looksLikeAddress = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || ''));
const toUsd = (n) => '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const parseMoney = (s) => {
  if (!s) return 0;
  const m = String(s).match(/[\$¥]?\s*([\d,]+(\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
};
const tsUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const fixed = (str, max) => {
  str = String(str ?? '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
};

// 近傍（数行）から「$数値」を拾う
function findVolumeNearby(lines, i) {
  const neigh = lines.slice(Math.max(0, i - 4), i + 6);
  const hit = neigh.find((s) => /\$\s?[\d,]+/.test(s));
  return hit ? hit.match(/\$\s?[\d,]+/)[0].replace(/\s+/g, '') : '';
}

// 近傍から Level / FAF らしきものを拾う（なければ空）
function findLevelNearby(lines, i) {
  const neigh = lines.slice(Math.max(0, i - 4), i + 6);
  const lv = neigh.find((s) => /(?:LVL|Level)\s*\d+/i.test(s));
  return lv ? lv.match(/(?:LVL|Level)\s*\d+/i)[0].replace(/\s+/g, '') : '';
}
function findFafNearby(lines, i) {
  const neigh = lines.slice(Math.max(0, i - 4), i + 6);
  // "FAF" というラベルがある場合
  const lab = neigh.find((s) => /FAF/i.test(s) && /[\d,]+/.test(s));
  if (lab) {
    const m = lab.match(/[\d,]+/);
    return m ? m[0] : '';
  }
  // ラベルが無ければ、Volume の行以外の「大きめの数」を候補にする（安全寄りに弱め）
  const vols = neigh.map((s) => (/\$\s?[\d,]+/.test(s) ? s : '')); // volume候補
  const bigNums = neigh
    .filter((s) => s && !/\$\s?[\d,]+/.test(s))
    .map((s) => {
      const m = s.match(/[\d,]{3,}/);
      return m ? m[0] : '';
    })
    .filter(Boolean);
  // FAF 見出せずなら空返却（誤検出より欠損のほうが安全）
  return bigNums[0] || '';
}

// ---------- main ----------
(async () => {
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 2400 } });

  // 1) ページ表示 & 待機
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  // 動的描画の余裕
  await page.waitForTimeout(3000);

  // 2) 証跡スクショ
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(() => {});

  // 3) ページ全テキスト
  const text = await page.evaluate(() => document.body.innerText);
  await fs.writeFile('data/raw_text.txt', text, 'utf8');

  // 4) テキスト→ランキング抽出
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const addr = lines[i].match(/[1-9A-HJ-NP-Za-km-z]{20,}/)?.[0];
    if (!addr) continue;

    // 近傍から各値を拾う（Volumeは必須）
    const volume = findVolumeNearby(lines, i);
    if (!volume) continue;

    const level = findLevelNearby(lines, i);
    const faf = findFafNearby(lines, i);
    const volumeNum = parseMoney(volume);

    rows.push({
      address: addr,
      level,
      faf,
      volume,
      volumeNum,
    });
  }

  // Volume順に並べ替え → 上位20
  rows.sort((a, b) => b.volumeNum - a.volumeNum);
  const top20 = rows.slice(0, 20).map((r, idx) => ({ ...r, rank: idx + 1 }));

  await fs.writeFile('data/top20.json', JSON.stringify(top20, null, 2));

  // 5) 差分（昨日）
  let y = [];
  try { y = JSON.parse(await fs.readFile('data/last.json', 'utf8')); } catch {}
  const mapY = new Map((y || []).map((r) => [r.address, r]));
  const withDiff = top20.map((r, i) => {
    const prev = mapY.get(r.address);
    const rank = i + 1;
    return {
      ...r,
      deltaVP: prev ? (r.volumeNum - (prev.volumeNum || 0)) : null,
      deltaRank: prev ? (rank - (prev.rank || 0)) : null,
    };
  });
  if (top20.length) {
    await fs.writeFile('data/last.json', JSON.stringify(top20, null, 2));
  }

  // 6) 合計（今日のテーブル合計を表示。公式「Total Volume Traded (Today)」が別にあるならそちら優先に差し替え可）
  const totalNum = withDiff.reduce((a, b) => a + (b.volumeNum || 0), 0);
  const totalStr = toUsd(totalNum);

  // 7) カード画像（PlaywrightでHTML→PNG）
  const rowsHtml = withDiff.map((r) => {
    const dVP =
      r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${toUsd(Math.abs(r.deltaVP))}`;
    const dR =
      r.deltaRank == null
        ? '–'
        : r.deltaRank < 0
        ? `▲${Math.abs(r.deltaRank)}`
        : r.deltaRank > 0
        ? `▼${r.deltaRank}`
        : '＝';
    const dRc =
      r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

    return `<tr>
      <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
      <td title="${r.address}">${fixed(r.address, 48)}</td>
      <td title="${r.level}">${fixed(r.level || '', 10)}</td>
      <td title="${r.faf}">${fixed(r.faf || '', 14)}</td>
      <td style="text-align:right">${r.volume}</td>
      <td style="text-align:right">${dVP}</td>
      <td style="text-align:right;color:${dRc}">${dR}</td>
    </tr>`;
  }).join('');

  const html = `<!doctype html><meta charset="utf-8">
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7;}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
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
    th:nth-child(6),td:nth-child(6){width:160px;text-align:right}
    th:nth-child(7),td:nth-child(7){width:110px;text-align:right}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style>
  <div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total"><small>Total Volume Traded (Today):</small>${totalStr}</div>
    </div>
    <table>
      <thead><tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th><th>ΔVP</th><th>ΔRank</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${tsUTC()} ・ Source: flash.trade/leaderboard</div>
  </div>`;

  const card = await browser.newPage({ viewport: { width: 1300, height: 1600 } });
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });
  await browser.close();

  console.log('✅ Done: raw_page.png / data/raw_text.txt / data/top20.json / data/last.json / leaderboard_card.png');
})();