// snapshot.js — FlashTrade Leaderboard daily snapshot
// 依存: Playwright (chromium) のみ。追加npmパッケージ不要。

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// ----------------- utils -----------------
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const toUsd = (n) => '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const num = (v) => {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const m = String(v).match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
};
const timeStampUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const looksLikeAddress = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || ''));

function fixedWidth(str, max) {
  str = String(str ?? '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// JSON探索ヘルパ
function collectArrays(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) out.push(node);
  for (const v of Object.values(node)) collectArrays(v, out);
  return out;
}
function pickField(obj, preferred) {
  const keys = Object.keys(obj);
  for (const k of preferred) {
    const exact = keys.find((x) => x.toLowerCase() === k.toLowerCase());
    if (exact) return obj[exact];
  }
  for (const k of preferred) {
    const like = keys.find((x) => x.toLowerCase().includes(k.toLowerCase()));
    if (like) return obj[like];
  }
  return undefined;
}

// JSON 抽出（最優先）
function guessTop20FromJson(jsonPool) {
  let arrays = [];
  for (const { body } of jsonPool) collectArrays(body, arrays);
  arrays = arrays.filter((a) => Array.isArray(a) && a.length >= 10);
  if (!arrays.length) return null;

  const score = (arr) => {
    let s = 0;
    for (const it of arr.slice(0, 30)) {
      if (!it || typeof it !== 'object') continue;
      const addr =
        pickField(it, ['address', 'wallet', 'owner', 'account', 'id']) ??
        Object.values(it).find(looksLikeAddress);
      const vol =
        pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
        Object.values(it).find((x) => typeof x === 'number' && x > 1000);
      if (addr) s += 2;
      if (vol != null) s += 1;
    }
    s += Math.min(arr.length, 50) / 10;
    return s;
  };

  arrays.sort((a, b) => score(b) - score(a));
  const best = arrays[0];

  const rows = best
    .map((it) => {
      const address =
        pickField(it, ['address', 'wallet', 'owner', 'account', 'id']) ??
        Object.values(it).find(looksLikeAddress) ??
        '';
      const level = pickField(it, ['level', 'lvl']) ?? '';
      const faf =
        pickField(it, ['faf', 'staked', 'stakedFAF', 'stake']) ??
        pickField(it, ['staked_faf', 'fafStaked']) ??
        '';
      const volRaw =
        pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
        Object.values(it).find((x) => typeof x === 'number');

      const volumeNum = num(volRaw);
      return { address: String(address).slice(0, 64), level: String(level ?? ''), faf: String(faf ?? ''), volumeNum };
    })
    .filter((x) => x.address);

  rows.sort((a, b) => b.volumeNum - a.volumeNum);
  return rows.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
}
function guessTotalFromJson(jsonPool) {
  const candidates = [];
  for (const { body } of jsonPool) {
    if (!body || typeof body !== 'object') continue;
    const keys = Object.keys(body);
    for (const k of keys) {
      if (/total.*volume|daily.*volume|volume.*today/i.test(k)) {
        const v = body[k];
        if (typeof v === 'number') candidates.push(v);
      }
    }
    const arrays = collectArrays(body);
    for (const arr of arrays) {
      const sum = arr
        .map((it) => {
          if (!it || typeof it !== 'object') return 0;
          const v =
            pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
            Object.values(it).find((x) => typeof x === 'number');
          return num(v);
        })
        .reduce((a, b) => a + b, 0);
      if (sum > 0) candidates.push(sum);
    }
  }
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

// ----------------- main -----------------
(async () => {
  await fs.mkdir('debug/json', { recursive: true });
  await fs.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 2400 },
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
  });

  // できる限りbot判定を回避
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
    });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';          // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL';   // UNMASKED_RENDERER_WEBGL
      return getParameter.apply(this, [parameter]);
    };
  });

  const page = await context.newPage();

  // JSON横取り
  const jsonPool = [];
  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const url = res.url();
      const body = await res.json();
      jsonPool.push({ url, body });
      const name =
        url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 160) +
        '_' + crypto.createHash('md5').update(url).digest('hex').slice(0, 8) + '.json';
      await fs.writeFile(path.join('debug/json', name), JSON.stringify(body, null, 2), 'utf8');
    } catch {}
  });

  // --------- ナビゲーション（強化待機＋リトライ） ---------
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${URL}?_=${Date.now()}_${attempt}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 800); await page.waitForTimeout(700); }
    await page.mouse.move(200, 200);
    await page.waitForTimeout(1000);
    const ok = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/[1-9A-HJ-NP-Za-km-z]{20,}/g);
      return m && m.length >= 10;
    }).catch(() => false);
    if (ok) break;
    await page.waitForTimeout(2000);
  }

  // 保険の生スクショ
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(()=>{});

  // --------- ① JSON → ② DOM → ③ TEXT の順で抽出 ---------
  let top20 = guessTop20FromJson(jsonPool);
  let totalNum = guessTotalFromJson(jsonPool);

  if (!top20 || !top20.length) {
    try {
      const rows = await page.evaluate(() => {
        const q = (sel, root = document) => Array.from(root.querySelectorAll(sel));
        const tableRows = q('table tbody tr')
          .map((tr) => q('td', tr).map((td) => (td.innerText || td.textContent || '').trim()))
          .filter((a) => a.length >= 4);
        if (tableRows.length >= 10) return tableRows.slice(0, 30);

        const roleRows = q('[role="row"]')
          .map((row) =>
            q('[role="cell"], td, div', row)
              .map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
          .filter((a) => a.length >= 4);
        return roleRows.slice(0, 30);
      });

      if (rows && rows.length) {
        const parsed = rows
          .map((tds) => {
            const address = tds.find((s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(s)) || tds[1] || '';
            const volText = tds.find((s) => /\$\s?\d/.test(s)) || '';
            const volumeNum = num(volText);
            const level = tds.find((s) => /LVL|LV|Level/i.test(s)) || tds[2] || '';
            const faf = tds.find((s) => /FAF|staked/i.test(s)) || tds[3] || '';
            return { address, level, faf, volumeNum };
          })
          .filter((x) => x.address);
        parsed.sort((a, b) => b.volumeNum - a.volumeNum);
        top20 = parsed.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
      }
    } catch {}
  }

  if (!top20 || !top20.length) {
    try {
      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const addrIdx = [];
      lines.forEach((s, i) => { if (/[1-9A-HJ-NP-Za-km-z]{20,}/.test(s)) addrIdx.push(i); });
      const rows = addrIdx.slice(0, 30).map((i) => {
        const address = lines[i];
        const neighborhood = lines.slice(Math.max(0, i - 4), i + 6);
        const volLine = neighborhood.find((s) => /\$\s?\d/.test(s)) || '';
        const level = neighborhood.find((s) => /LVL|LV|Level/i.test(s)) || '';
        const faf = neighborhood.find((s) => /FAF|staked/i.test(s)) || '';
        const volumeNum = num(volLine);
        return { address, level, faf, volumeNum };
      }).filter((r) => r.address);
      rows.sort((a, b) => b.volumeNum - a.volumeNum);
      top20 = rows.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
    } catch {}
  }

  if (!top20 || !top20.length) {
    try { await fs.writeFile('debug/page.html', await page.content(), 'utf8'); } catch {}
    console.error('No rows captured (JSON & DOM & Text all failed). Debug artifacts saved.');
    // 失敗でも空テーブルでカードは描画する
  }

  if (totalNum == null) {
    try {
      const allText = await page.evaluate(() => document.body.innerText);
      const m = allText.match(/Total\s+Volume.*?\$[\d,]+/i);
      if (m) {
        const m2 = m[0].match(/\$[\d,]+/);
        if (m2) totalNum = Number(m2[0].replace(/\$|,/g, ''));
      }
    } catch {}
  }

  // 差分
  let yesterday = [];
  try { yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8')); } catch {}
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));
  const withDiff = (top20 || []).map((r, i) => {
    const y = mapY.get(r.address);
    const rank = i + 1;
    return {
      ...r,
      rank,
      volume: r.volume ?? toUsd(r.volumeNum),
      deltaVP: y ? r.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? rank - (y.rank || 0) : null,
    };
  });
  if (withDiff.length) {
    await fs.writeFile(
      'data/last.json',
      JSON.stringify(withDiff.map(({ deltaVP, deltaRank, ...rest }) => rest), null, 2)
    );
  }

  // --------- カード描画 ---------
  const totalStr = totalNum != null ? toUsd(totalNum) : '—';
  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .slice(0, 20)
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td></td><td style="text-align:right">-</td><td style="text-align:right">-</td><td style="text-align:right">-</td></tr>`;
      }
      const dVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${toUsd(Math.abs(r.deltaVP))}`;
      const dr = r.deltaRank == null ? '–' : (r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` : r.deltaRank > 0 ? `▼${r.deltaRank}` : '＝');
      const drColor = r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

      return `
        <tr>
          <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
          <td title="${r.address}">${fixedWidth(r.address, 48)}</td>
          <td title="${r.level ?? ''}">${fixedWidth(r.level ?? '', 10)}</td>
          <td title="${r.faf ?? ''}">${fixedWidth(r.faf ?? '', 14)}</td>
          <td style="text-align:right">${r.volume}</td>
          <td style="text-align:right">${dVP}</td>
          <td style="text-align:right;color:${drColor}">${dr}</td>
        </tr>`;
    })
    .join('');

  const html = `
  <html><head><meta charset="utf-8"/>
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7;}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
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
  </style></head>
  <body><div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total"><small>Total Volume Traded (Today):</small>${totalStr}</div>
    </div>
    <table>
      <thead><tr>
        <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th><th>ΔVP</th><th>ΔRank</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / debug/page.html / debug/json/* / data/last.json');
})();
