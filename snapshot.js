// snapshot.js
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// ---------- 小道具 ----------
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const toUsd = (n) => '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const num = (v) => {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const m = String(v).match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
};
const timeStampUTC = () =>
  new Date().toISOString().slice(0, 16).replace('T', ' ');

// ベース58っぽい（Sol のアドレス等）
const looksLikeAddress = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || ''));

// ---------- JSON候補の探索 ----------
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
      return {
        address: String(address).slice(0, 64),
        level: String(level ?? ''),
        faf: String(faf ?? ''),
        volumeNum,
      };
    })
    .filter((x) => x.address);

  rows.sort((a, b) => b.volumeNum - a.volumeNum);
  return rows.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
}

function guessTotalFromJson(jsonPool) {
  // 合計に見えるフィールド、または配列の合計などを推定
  const candidates = [];
  for (const { body } of jsonPool) {
    if (!body || typeof body !== 'object') continue;
    // 直接 totalVolume / dailyVolume を探す
    const keys = Object.keys(body);
    for (const k of keys) {
      if (/total.*volume|daily.*volume|volume.*today/i.test(k)) {
        const v = body[k];
        if (typeof v === 'number') candidates.push(v);
      }
    }
    // 配列の合計（volumeNum的な数値を合計）
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
  // 一番大きい値を採用（だいたい合計が最大）
  return Math.max(...candidates);
}

// ---------- メイン ----------
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1800 },
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36'
  });
  const page = await context.newPage();

  // デバッグ保存先
  await fs.mkdir('debug/json', { recursive: true });
  await fs.mkdir('data', { recursive: true });

  // 受信JSONをキャプチャ
  const jsonPool = [];
  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const url = res.url();
      const body = await res.json();
      jsonPool.push({ url, body });

      const name =
        url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 180) +
        '_' + crypto.createHash('md5').update(url).digest('hex').slice(0, 8) +
        '.json';
      await fs.writeFile(path.join('debug/json', name), JSON.stringify(body, null, 2), 'utf8');
    } catch {}
  });

  // キャッシュ抑止
  await page.setExtraHTTPHeaders({ 'cache-control': 'no-cache', pragma: 'no-cache' });

  // 遷移
  await page.goto(`${URL}?nocache=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // しばらく待つ＋スクロールでCSRのfetchを促す
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(3000);

  // JSON優先で抽出
  let top20 = guessTop20FromJson(jsonPool);
  let totalNum = guessTotalFromJson(jsonPool);

  // DOMフォールバック（トップのTotal Volumeと行）
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

  if (!top20 || !top20.length) {
    try {
      const rows = await page.evaluate(() => {
        const q = (sel) => Array.from(document.querySelectorAll(sel));
        const fromTable = q('table tbody tr')
          .slice(0, 20)
          .map((tr) => q('td', tr).map((td) => (td.innerText || td.textContent || '').trim()));
        if (fromTable.length >= 10) return fromTable;

        const fromRole = q('[role="row"]')
          .map((row) =>
            q('[role="cell"], td', row).map((c) => (c.innerText || c.textContent || '').trim())
          )
          .filter((a) => a.length >= 4)
          .slice(0, 20);
        return fromRole;
      });

      if (rows && rows.length) {
        top20 = rows.map((tds, i) => {
          const address = tds[1] || '';
          const level = tds[2] || '';
          const faf = tds[3] || '';
          const volText = tds.find((x) => /\$\d/.test(x)) || '';
          const volumeNum = num(volText);
          return { rank: i + 1, address, level, faf, volumeNum, volume: toUsd(volumeNum) };
        });
      }
    } catch {}
  }

  // 最後の保険：ページのHTML保存（調査用）
  if (!top20 || !top20.length) {
    await fs.writeFile('debug/page.html', await page.content(), 'utf8');
  }

  // 元ページのスクショ（保険）
  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // 前日データの読み込み
  let yesterday = [];
  try {
    yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));

  // 差分付与
  const withDiff = (top20 || []).map((r, i) => {
    const y = mapY.get(r.address);
    const rank = i + 1;
    return {
      ...r,
      rank,
      volume: r.volume ?? toUsd(r.volumeNum),
      deltaVP: y ? r.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? rank - (y.rank || 0) : null
    };
  });

  // 次回比較用に保存（データが拾えた時のみ）
  if (withDiff.length) {
    await fs.writeFile('data/last.json', JSON.stringify(withDiff.map(({ deltaVP, deltaRank, ...rest }) => rest), null, 2));
  }

  // --------- カードHTML生成（文字重なり防止レイアウト） ----------
  const totalStr = totalNum != null ? toUsd(totalNum) : '—';

  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .slice(0, 20)
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td></td><td style="text-align:right"></td><td style="text-align:right">–</td><td style="text-align:right">–</td></tr>`;
      }
      const dVP = r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${toUsd(Math.abs(r.deltaVP))}`;
      const dr = r.deltaRank == null ? '–' : (r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` : r.deltaRank > 0 ? `▼${r.deltaRank}` : '＝');
      const drColor = r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';
      return `
        <tr>
          <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
          <td title="${r.address}">${r.address}</td>
          <td title="${r.level ?? ''}">${r.level ?? ''}</td>
          <td title="${r.faf ?? ''}">${r.faf ?? ''}</td>
          <td style="text-align:right">${r.volume}</td>
          <td style="text-align:right">${dVP}</td>
          <td style="text-align:right;color:${drColor}">${dr}</td>
        </tr>`;
    })
    .join('');

  const html = `
  <html>
    <head>
      <meta charset="utf-8"/>
      <style>
        :root{
          --bg:#0b1217; --panel:#0f151a; --line:#15202b; --muted:#8aa1b1; --text:#e6f0f7;
        }
        *{ box-sizing:border-box; }
        body{ margin:0; background:var(--bg); color:var(--text); font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
        .wrap{ width:1200px; margin:24px auto; background:var(--panel); border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); overflow:hidden; }
        .head{ padding:18px 22px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; }
        .title{ font-size:24px; font-weight:700; }
        .total{ margin-left:auto; font-weight:700; }
        .total small{ color:var(--muted); font-weight:500; margin-right:10px; }
        table{ width:100%; border-collapse:collapse; table-layout:fixed; }
        th,td{ padding:12px 14px; border-bottom:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        th{ text-align:left; background:#0e151b; color:var(--muted); font-weight:600; }
        tr:nth-child(even){ background:#0e151b; }
        /* 列幅固定：重なり防止 */
        th:nth-child(1),td:nth-child(1){ width:120px; }
        th:nth-child(2),td:nth-child(2){ width:420px; font-family: ui-monospace,SFMono-Regular,Consolas,Menlo,monospace; }
        th:nth-child(3),td:nth-child(3){ width:110px; }
        th:nth-child(4),td:nth-child(4){ width:160px; }
        th:nth-child(5),td:nth-child(5){ width:170px; }
        th:nth-child(6),td:nth-child(6){ width:160px; }
        th:nth-child(7),td:nth-child(7){ width:110px; }
        td:nth-child(5), td:nth-child(6), td:nth-child(7){ text-align:right; }
        .foot{ padding:10px 14px; color:var(--muted); font-size:12px; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="head">
          <div class="title">FlashTrade Leaderboard — Top 20</div>
          <div class="total"><small>Total Volume Traded (Today):</small>${totalStr}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th><th>ΔVP</th><th>ΔRank</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
      </div>
    </body>
  </html>`;

  // HTML → 画像レンダリング
  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / data/last.json / debug/json/*');
})();
