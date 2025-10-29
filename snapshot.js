// snapshot.js — robust LB capture: strong waits + header-based column mapping + clean screenshot
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const toUsd = (n) =>
  '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const num = (v) => {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const m = String(v).replace(/\u00A0/g, ' ').match(/\$?\s*([\d,]+(\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
};
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const tsUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  await fs.mkdir('debug', { recursive: true });
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
  });
  const page = await ctx.newPage();

  // 1) ナビゲーション
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // 自動スクロールでハイドレーション促進
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      window.scrollBy(0, window.innerHeight);
      await sleep(500);
    }
  });

  // 2) 「テーブルが埋まった」まで強待機
  await page.waitForFunction(
    () => {
      // 1) ヘッダ
      const head = Array.from(document.querySelectorAll('thead th'))
        .map((th) => th.textContent.trim().toLowerCase())
        .join('|');
      if (!head || !/rank|address|volume|faf|level/.test(head)) return false;

      // 2) 行数
      const rows = document.querySelectorAll('tbody tr');
      if (!rows || rows.length < 20) return false;

      // 3) Volume の妥当性（$ と5桁以上が少なくとも5行）
      let ok = 0;
      rows.forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        for (const td of tds) {
          const s = (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
          if (/\$\s*[\d,]{5,}/.test(s)) ok++;
        }
      });
      return ok >= 5;
    },
    { timeout: 45_000 }
  ).catch(() => {});

  // 3) トップに戻す（スクショが4位以下になるのを防止）
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(400);

  // 4) テーブル抽出（ヘッダから列位置を推定）
  const { rows, totalText } = await page.evaluate(() => {
    const byText = (s) => (s || '').replace(/\u00A0/g, ' ').trim();

    const ths = Array.from(document.querySelectorAll('thead th'));
    const header = ths.map((th) => byText(th.innerText || th.textContent).toLowerCase());
    const idx = {
      rank: header.findIndex((h) => /rank/.test(h)),
      address: header.findIndex((h) => /address/.test(h)),
      level: header.findIndex((h) => /level|lvl/.test(h)),
      faf: header.findIndex((h) => /faf|stak/.test(h)),
      volume: header.findIndex((h) => /volume|vp|points/.test(h)),
    };

    const trs = Array.from(document.querySelectorAll('tbody tr'));
    const safeCellText = (tr, i) => {
      const cell = tr.children[i];
      if (!cell) return '';
      const cs = getComputedStyle(cell);
      if (cs.display === 'none' || cs.visibility === 'hidden') return '';
      return byText(cell.innerText || cell.textContent);
    };

    const rows = trs.slice(0, 40).map((tr, i) => {
      return {
        rankText: idx.rank >= 0 ? safeCellText(tr, idx.rank) : String(i + 1),
        address: idx.address >= 0 ? safeCellText(tr, idx.address) : '',
        level: idx.level >= 0 ? safeCellText(tr, idx.level) : '',
        faf: idx.faf >= 0 ? safeCellText(tr, idx.faf) : '',
        volumeText: idx.volume >= 0 ? safeCellText(tr, idx.volume) : '',
      };
    });

    const totalNode = Array.from(document.querySelectorAll('*'))
      .find((el) => /total\s+volume/i.test(byText(el.innerText || el.textContent)));
    const totalText = totalNode ? byText(totalNode.innerText || totalNode.textContent) : '';

    return { rows, totalText };
  });

  // 5) 正規化
  const top = rows
    .map((r, i) => {
      const volumeNum = num(r.volumeText);
      return {
        rank: i + 1,
        address: (r.address || '').slice(0, 64),
        level: r.level || '',
        faf: r.faf || '',
        volumeNum,
        volume: toUsd(volumeNum),
      };
    })
    .filter((r) => r.address)
    .slice(0, 20);

  // 6) 前日比
  let y = [];
  try { y = JSON.parse(await fs.readFile('data/last.json', 'utf8')); } catch {}
  const ym = new Map(y.map((r) => [r.address, r]));
  const withDiff = top.map((r, i) => {
    const prev = ym.get(r.address);
    const deltaVP = prev ? r.volumeNum - (prev.volumeNum || 0) : null;
    const deltaRank = prev ? (i + 1) - (prev.rank || 0) : null;
    return { ...r, deltaVP, deltaRank };
  });
  if (withDiff.length) {
    await fs.writeFile('data/last.json', JSON.stringify(withDiff.map(({ deltaVP, deltaRank, ...rest }) => rest), null, 2));
  }

  // 7) カード描画（固定幅で重なり防止）
  const totalStr = /\$\d/.test(totalText || '') ? (totalText.match(/\$\s*[\d,]+/) || ['—'])[0] : '—';
  const fixed = (s, n) => {
    s = String(s ?? '');
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
  };
  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .slice(0, 20)
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td></td><td class="num">-</td><td class="num">-</td><td class="num">-</td></tr>`;
      }
      const dVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${toUsd(Math.abs(r.deltaVP))}`;
      const dR =
        r.deltaRank == null ? '–' :
        r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` :
        r.deltaRank > 0 ? `▼${r.deltaRank}` : '＝';
      const dRColor =
        r.deltaRank == null ? '#8aa1b1' :
        r.deltaRank < 0 ? '#2ecc71' :
        r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';
      return `<tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
        <td title="${r.address}">${fixed(r.address, 48)}</td>
        <td title="${r.level}">${fixed(r.level, 10)}</td>
        <td title="${r.faf}">${fixed(r.faf, 14)}</td>
        <td class="num">${r.volume}</td>
        <td class="num">${dVP}</td>
        <td class="num" style="color:${dRColor}">${dR}</td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
  :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
  .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px}
  .title{font-size:24px;font-weight:700}.total{margin-left:auto;font-weight:700}.total small{color:var(--muted);font-weight:500;margin-right:10px}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  th,td{padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
  tr:nth-child(even){background:#0e151b}.num{text-align:right}
  th:nth-child(1),td:nth-child(1){width:120px}
  th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace}
  th:nth-child(3),td:nth-child(3){width:110px}
  th:nth-child(4),td:nth-child(4){width:160px}
  th:nth-child(5),td:nth-child(5){width:170px}
  th:nth-child(6),td:nth-child(6){width:160px}
  th:nth-child(7),td:nth-child(7){width:110px}
  .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style></head><body>
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
  </div>
  </body></html>`;

  const card = await ctx.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  // 生ページの保険スクショ＆HTML保存
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(()=>{});
  await fs.writeFile(path.join('debug', 'page.html'), await page.content(), 'utf8');

  await browser.close();
  console.log('✅ generated: leaderboard_card.png, raw_page.png, debug/page.html, data/last.json');
})();
