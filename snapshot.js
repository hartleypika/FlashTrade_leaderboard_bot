// snapshot.js — Final Stable Version (2025-10)
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/[^\d.-]/g, '')) || 0;
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const fixed = (s, w) => (s.length <= w ? s : s.slice(0, w - 1) + '…');
const timeStampUTC = () => new Date().toISOString().slice(0,16).replace('T',' ');

(async () => {
  await fs.mkdir('data', { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 2200 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  await page.goto(URL + '?_' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  await sleep(1000);

  // 各行のセルを解析
  const rows = await page.evaluate(() => {
    const qAll = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const getText = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g,' ');
    const trs = qAll('table tbody tr');
    const data = [];

    for (const tr of trs) {
      const tds = qAll('td, [role="cell"]', tr).map(getText).filter(Boolean);
      if (tds.length < 3) continue;

      let rank = Number(tds[0].replace(/[^\d]/g, '')) || null;
      let address = tds.find(t => t.match(/…/) || t.match(/^[1-9A-HJ-NP-Za-km-z]{10,}/)) || '';
      let level='', faf='', vp='', dVp='–', dRank='–';

      // "LVL 6 4,035,239 FAF staked" のような複合セル対応
      const lvlCell = tds.find(t => t.includes('LVL')) || '';
      const lvlMatch = lvlCell.match(/(LVL\s*\d+)/i);
      if (lvlMatch) level = lvlMatch[1];
      const fafMatch = lvlCell.match(/(\d[\d,]+\s*FAF\s*staked)/i);
      if (fafMatch) faf = fafMatch[1];

      // Voltage Points列を検索
      const vpCell = tds.find(t => t.match(/\d[\d,]+\s*$/) || t.match(/Points/i));
      if (vpCell) vp = vpCell.replace(/[^\d,]/g,'').replace(/,$/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',');

      data.push({ rank, address, level, faf, vp, dVp, dRank });
    }
    data.sort((a,b) => (a.rank ?? 999) - (b.rank ?? 999));
    return data;
  });

  // Total Volume Traded (Today)
  const totalToday = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Total Volume Traded\s*\(Today\)\s*[:：]\s*\$[\d,]+/i);
    return m ? (m[0].match(/\$[\d,]+/) || [])[0] : '—';
  });

  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  const top20 = rows.slice(0,20);
  await fs.writeFile(path.join('data','last.json'), JSON.stringify(top20,null,2));

  // HTML生成
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <style>
    body{margin:0;background:#0b1217;color:#e6f0f7;font:16px/1.5 sans-serif;}
    .wrap{width:1240px;margin:24px auto;background:#0f151a;border-radius:14px;overflow:hidden;box-shadow:0 0 30px rgba(0,0,0,.4)}
    .head{padding:18px 22px;border-bottom:1px solid #15202b;display:flex;align-items:center;gap:16px}
    .title{font-size:22px;font-weight:700}
    .total{margin-left:auto;color:#8aa1b1}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:10px 14px;border-bottom:1px solid #15202b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{background:#0e151b;color:#8aa1b1;font-weight:600}
    td.num{text-align:right}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:90px}
    th:nth-child(2),td:nth-child(2){width:300px;font-family:monospace}
    th:nth-child(3),td:nth-child(3){width:150px}
    th:nth-child(4),td:nth-child(4){width:180px}
    th:nth-child(5),td:nth-child(5){width:180px;text-align:right}
    th:nth-child(6),td:nth-child(6),th:nth-child(7),td:nth-child(7){width:100px;text-align:right}
    .foot{padding:10px 14px;color:#8aa1b1;font-size:12px}
  </style></head><body>
  <div class="wrap"><div class="head">
    <div class="title">FlashTrade Leaderboard — Top 20</div>
    <div class="total">Total Volume Traded (Today): <b>${totalToday}</b></div>
  </div>
  <table>
    <thead><tr>
      <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Voltage Points</th><th>ΔVP</th><th>ΔRank</th>
    </tr></thead>
    <tbody>
      ${top20.map((r,i)=>`
        <tr>
          <td>${medal(r.rank)}${String(r.rank).padStart(2,'0')}</td>
          <td>${fixed(r.address,30)}</td>
          <td>${r.level}</td>
          <td>${r.faf}</td>
          <td class="num">${r.vp}</td>
          <td class="num">–</td>
          <td class="num">–</td>
        </tr>`).join('\n')}
    </tbody>
  </table>
  <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / data/last.json');
})();
