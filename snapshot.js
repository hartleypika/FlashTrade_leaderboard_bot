// snapshot.js (robust)
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '');
const fmtUsd = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const num = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
};

// 深掘りで配列候補を拾う
const digArrays = (n, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) out.push(n);
  for (const v of Object.values(n)) digArrays(v, out);
  return out;
};

// JSON 推定
function guessTop20FromJson(pool) {
  const arrays = [];
  for (const { body } of pool) digArrays(body, arrays);

  const looksAddr = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || ''));
  const score = (arr) => {
    let s = 0;
    for (const it of arr.slice(0, 40)) {
      if (!it || typeof it !== 'object') continue;
      const vals = Object.values(it);
      if (vals.some(looksAddr)) s += 2;
      if (vals.some((x) => typeof x === 'number' && x > 1_000)) s += 1;
    }
    return s + Math.min(arr.length, 50) / 10;
  };

  const cand = arrays
    .filter((a) => a.length >= 10)
    .map((a) => ({ a, s: score(a) }))
    .sort((x, y) => y.s - x.s);

  if (!cand.length) return null;

  const best = cand[0].a.map((it, i) => {
    const entries = Object.entries(it || {});
    const addr =
      entries.find(([k, v]) => /address|wallet|owner|account|id/i.test(k) && looksAddr(v))?.[1] ||
      entries.find(([_, v]) => looksAddr(v))?.[1] ||
      '';
    const level = entries.find(([k]) => /level|lvl/i.test(k))?.[1] ?? '';
    const faf =
      entries.find(([k]) => /faf|stake/i.test(k))?.[1] ??
      entries.find(([k]) => /staked[_]?faf/i.test(k))?.[1] ??
      '';
    const vol =
      entries.find(([k, v]) => /volume|totalvolume|vp|points|voltage/i.test(k) && typeof v !== 'object')?.[1] ??
      entries.find(([_, v]) => typeof v === 'number')?.[1] ??
      '';

    const volNum = num(vol);
    return { rank: i + 1, address: String(addr), level: String(level ?? ''), faf: String(faf ?? ''), volume: fmtUsd(volNum), volNum };
  });

  const top = best
    .filter((x) => x.address)
    .sort((a, b) => b.volNum - a.volNum)
    .slice(0, 20)
    .map((x, i) => ({ ...x, rank: i + 1 }));

  return top.length ? top : null;
}

(async () => {
  await fs.mkdir('debug/json', { recursive: true });
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1300, height: 2000 },
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    bypassCSP: true,
    serviceWorkers: 'block',
  });

  const page = await context.newPage();

  // webdriver偽装
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // 強めのヘッダ
  await page.setExtraHTTPHeaders({
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'accept-language': 'en-US,en;q=0.9',
    accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    referer: 'https://www.flash.trade/',
  });

  // すべてのレスポンスを保存（content-type に依存しない）
  const pool = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const txt = await res.text();
      // JSON っぽければ parse
      let body = null;
      try {
        body = JSON.parse(txt);
      } catch {}
      // 保存
      const base =
        url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 160) +
        '_' +
        crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
      await fs.writeFile(path.join('debug/json', base + '.txt'), txt);
      if (body) {
        await fs.writeFile(path.join('debug/json', base + '.json'), JSON.stringify(body, null, 2));
        pool.push({ url, body });
      }
    } catch {}
  });

  // 読み込み
  await page.goto(`${URL}?nocache=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // しっかり待つ（CSRのfetch完了を狙う）
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(4000);

  // まず JSON から推定
  let top20 = guessTop20FromJson(pool);

  // 取れなければ DOM も試す
  if (!top20) {
    const rows = await page.evaluate(() => {
      const norm = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const tb = Array.from(document.querySelectorAll('table tbody tr'))
        .slice(0, 20)
        .map((tr) => Array.from(tr.querySelectorAll('td')).map(norm));
      if (tb.length >= 10) return tb;
      const aria = Array.from(document.querySelectorAll('[role="row"]'))
        .map((row) => Array.from(row.querySelectorAll('[role="cell"], td')).map(norm))
        .filter((cells) => cells.length >= 4)
        .slice(0, 20);
      return aria;
    });

    if (rows && rows.length) {
      top20 = rows
        .map((tds, i) => {
          const address = tds[1] || '';
          const volStr = tds.find((s) => /\$[\d,]/.test(s)) || '';
          return {
            rank: i + 1,
            address,
            level: tds[2] || '',
            faf: tds[3] || '',
            volume: volStr,
            volNum: num(volStr),
          };
        })
        .filter((x) => x.address)
        .slice(0, 20);
    }
  }

  // それでもダメなら HTML とスクショを保存して成功終了（ワークフローを落とさない）
  if (!top20 || !top20.length) {
    await fs.writeFile('debug/page.html', await page.content(), 'utf8');
    await page.screenshot({ path: 'raw_leaderboard.png', fullPage: true });
    await browser.close();
    console.log('⚠️ No rows captured. Saved debug/page.html & raw_leaderboard.png & debug/json/*');
    process.exit(0); // ← 成功扱い（Artifacts を手で見れるように）
  }

  // 差分用
  let y = [];
  try { y = JSON.parse(await fs.readFile('data/last.json', 'utf8')); } catch {}
  const mapY = new Map(y.map((r) => [r.address, r]));

  const withDiff = top20.map((t) => {
    const prev = mapY.get(t.address);
    const deltaVP = prev ? t.volNum - (prev.volNum || 0) : null;
    const deltaRank = prev ? t.rank - (prev.rank || 0) : null;
    return { ...t, deltaVP, deltaRank };
  });

  await fs.writeFile('data/last.json', JSON.stringify(top20, null, 2));

  // カード描画
  const rowsHtml = withDiff
    .map((r) => {
      const dVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${fmtUsd(Math.abs(r.deltaVP))}`;
      const dRank =
        r.deltaRank == null ? '–' : r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` : r.deltaRank > 0 ? `▼${r.deltaRank}` : '＝';
      const dRankColor = r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';
      return `
        <tr>
          <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
          <td>${r.address}</td>
          <td>${r.level ?? ''}</td>
          <td>${r.faf ?? ''}</td>
          <td style="text-align:right">${r.volume}</td>
          <td style="text-align:right">${dVP}</td>
          <td style="text-align:right;color:${dRankColor}">${dRank}</td>
        </tr>`;
    })
    .join('');

  const html = `
  <html><head><meta charset="utf-8"/>
  <style>
    body{margin:0;background:#0b1217;color:#e6f0f7;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1200px;margin:24px auto;background:#0f151a;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .title{padding:18px 22px;font-size:24px;font-weight:700;border-bottom:1px solid #1b2732}
    table{width:100%;border-collapse:collapse;font-size:16px}
    th,td{padding:12px 14px;border-bottom:1px solid #15202b}
    th{text-align:left;color:#8aa1b1;font-weight:600;background:#0e151b;position:sticky;top:0}
    tr:nth-child(even){background:#0e151b}
    td:first-child{width:110px}
    td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace}
    .footer{padding:12px 14px;color:#8aa1b1;font-size:12px}
  </style></head>
  <body>
    <div class="wrap">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <table>
        <thead><tr>
          <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th>
          <th style="text-align:right">Volume</th>
          <th style="text-align:right">ΔVP</th>
          <th style="text-align:right">ΔRank</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="footer">Snapshot (UTC): ${new Date().toISOString().slice(0,16).replace('T',' ')}</div>
    </div>
  </body></html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Saved leaderboard_card.png / data/last.json / debug/json/*');
})();