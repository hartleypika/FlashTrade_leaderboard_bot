// snapshot.js — FlashTrade Leaderboard → 画像化
// ・LVL/FAF を正規化して数値化
// ・列幅を再設計（Address を詰め、右端 ΔRank が切れない）
// ・Total Volume を表示 ＋ 前日比を表示
// ・昨日との差分（ΔVP / ΔRank）を計算・保存

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

// ---------- helpers ----------
const medal = (r) => (r === 1 ? '🥇 ' : r === 2 ? '🥈 ' : r === 3 ? '🥉 ' : '');
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
const onlyDigits = (s) => String(s ?? '').replace(/[^\d.-]/g, '');
const num = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').match(/-?[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
};
const toUsd = (n) =>
  '$' + Math.round(Math.max(0, Number(n || 0))).toLocaleString('en-US');
const looksLikeAddress = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || ''));
const timeStampUTC = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

// “LVL …”を “LVL X” に正規化（なければ空）
const normLevel = (s) => {
  const t = String(s ?? '');
  const m = t.match(/(?:LVL|Level)\s*([0-9]+)/i);
  if (m) return `LVL ${m[1]}`;
  const n = t.match(/\b([0-9]+)\b/);
  return n ? `LVL ${n[1]}` : '';
};

// “… FAF staked”や“2,345,678 FAF”から数値だけを抽出
const normFaf = (s) => {
  const t = String(s ?? '');
  const m = t.match(/([\d,]+)\s*FAF/i) || t.match(/FAF\s*(?:staked|)\s*:?[\s$]*([\d,]+)/i);
  if (m) return Number((m[1] || m[2]).replace(/,/g, '')).toLocaleString('en-US');
  // 数字だけ並んでいるケースも拾う
  const d = t.match(/[\d,]{3,}/);
  return d ? Number(d[0].replace(/,/g, '')).toLocaleString('en-US') : '';
};

function fixedWidth(str, max) {
  str = String(str ?? '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

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

// JSON 経由で top20 を推測（最優先）
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
        Object.values(it).find((x) => typeof x === 'number' && x > 1_000);
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
      const level = normLevel(pickField(it, ['level', 'lvl']) ?? '');
      const fafRaw =
        pickField(it, ['faf', 'staked', 'stakedFAF', 'stake']) ??
        pickField(it, ['staked_faf', 'fafStaked']) ??
        '';
      const faf = normFaf(fafRaw);
      const volRaw =
        pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
        Object.values(it).find((x) => typeof x === 'number');

      const volumeNum = num(volRaw);
      return { address: String(address).slice(0, 64), level, faf, volumeNum };
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

// ---------- main ----------
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
    viewport: { width: 1380, height: 2200 }, // 横幅を少し広げて右端切れを防止
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
  });

  // 軽いステルス
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const page = await context.newPage();

  // 返ってくる JSON を全部キャプチャ
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
        '_' +
        crypto.createHash('md5').update(url).digest('hex').slice(0, 8) +
        '.json';
      await fs.writeFile(path.join('debug/json', name), JSON.stringify(body, null, 2), 'utf8');
    } catch {}
  });

  // ナビゲーション（数回トライ）
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${URL}?_=${Date.now()}_${attempt}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    // 画面内の行がしっかり描画されるまで軽くスクロール
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(600);
    }
    const ok = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/[1-9A-HJ-NP-Za-km-z]{20,}/g);
      return m && m.length >= 10;
    }).catch(() => false);
    if (ok) break;
  }

  // 生のページ全体スクショ（デバッグ）
  await page.screenshot({ path: 'raw_page.png', fullPage: true }).catch(() => {});

  // ① JSON → ② DOM → ③ TEXT の順に抽出
  let top20 = guessTop20FromJson(jsonPool);
  let totalNum = guessTotalFromJson(jsonPool);

  // ② DOM 抽出（フォールバック）
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
            const address = tds.find(looksLikeAddress) || tds[1] || '';
            const volText = tds.find((s) => /\$\s?\d/.test(s)) || '';
            const volumeNum = num(volText);
            const level = normLevel(tds.find((s) => /(LVL|Level)/i.test(s)) || tds[2] || '');
            const faf = normFaf(tds.find((s) => /FAF/i.test(s)) || tds[3] || '');
            return { address, level, faf, volumeNum };
          })
          .filter((x) => x.address);

        parsed.sort((a, b) => b.volumeNum - a.volumeNum);
        top20 = parsed.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
      }
    } catch {}
  }

  // ③ 全文テキストから拾う（最終手段）
  if (!top20 || !top20.length) {
    try {
      const text = await page.evaluate(() => document.body.innerText);
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const addrIdx = [];
      lines.forEach((s, i) => { if (looksLikeAddress(s)) addrIdx.push(i); });

      const rows = addrIdx.slice(0, 30).map((i) => {
        const address = lines[i];
        const area = lines.slice(Math.max(0, i - 5), i + 8);
        const volLine = area.find((s) => /\$\s?\d/.test(s)) || '';
        const level = normLevel(area.find((s) => /(LVL|Level)/i.test(s)) || '');
        const faf = normFaf(area.find((s) => /FAF/i.test(s)) || '');
        const volumeNum = num(volLine);
        return { address, level, faf, volumeNum };
      }).filter((r) => r.address);

      rows.sort((a, b) => b.volumeNum - a.volumeNum);
      top20 = rows.slice(0, 20).map((x, i) => ({ ...x, rank: i + 1, volume: toUsd(x.volumeNum) }));
    } catch {}
  }

  // HTML 保存（デバッグ）
  if (!top20 || !top20.length) {
    try { await fs.writeFile('debug/page.html', await page.content(), 'utf8'); } catch {}
  }

  // Total Volume（DOM テキスト保険）
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

  // 前日比較のため保存値を読む
  let yesterday = [];
  let yesterdayTotal = null;
  try { yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8')); } catch {}
  try { yesterdayTotal = Number(await fs.readFile('data/last_total.txt', 'utf8')); } catch {}

  // ΔVP / ΔRank
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));
  const withDiff = (top20 || []).map((r, i) => {
    const y = mapY.get(r.address);
    const rank = i + 1;
    return {
      ...r,
      rank,
      deltaVP: y ? r.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? rank - (y.rank || 0) : null,
    };
  });

  // 次回用に保存
  if (withDiff.length) {
    await fs.writeFile(
      'data/last.json',
      JSON.stringify(withDiff.map(({ deltaVP, deltaRank, ...rest }) => rest), null, 2)
    );
  }
  if (totalNum != null) {
    await fs.writeFile('data/last_total.txt', String(totalNum));
  }

  // --------------- カード描画 ---------------
  const totalStr = totalNum != null ? toUsd(totalNum) : '—';
  const deltaTotal =
    totalNum != null && typeof yesterdayTotal === 'number'
      ? totalNum - yesterdayTotal
      : null;
  const deltaTotalStr =
    deltaTotal == null ? '–' : `${deltaTotal >= 0 ? '+' : '-'}${toUsd(Math.abs(deltaTotal))}`;

  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .slice(0, 20)
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, '0')}</td><td></td><td></td><td></td><td class="num">-</td><td class="num">-</td><td class="num">-</td></tr>`;
      }
      const dVP =
        r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${toUsd(Math.abs(r.deltaVP))}`;
      const dr =
        r.deltaRank == null
          ? '–'
          : r.deltaRank < 0
          ? `▲${Math.abs(r.deltaRank)}`
          : r.deltaRank > 0
          ? `▼${r.deltaRank}`
          : '＝';
      const drColor =
        r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

      return `
        <tr>
          <td>${medal(r.rank)}${String(r.rank).padStart(2, '0')}</td>
          <td title="${r.address}">${fixedWidth(r.address, 40)}</td>
          <td title="${r.level}">${r.level}</td>
          <td title="${r.faf}">${r.faf}</td>
          <td class="num">${toUsd(r.volumeNum)}</td>
          <td class="num">${dVP}</td>
          <td class="num" style="color:${drColor}">${dr}</td>
        </tr>`;
    })
    .join('');

  const html = `
  <html><head><meta charset="utf-8"/>
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);
      font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1320px;margin:24px auto;background:var(--panel);border-radius:14px;
      box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);
      display:flex;align-items:baseline;gap:16px}
    .title{font-size:24px;font-weight:700}
    .total{margin-left:auto;font-weight:700;display:flex;gap:12px}
    .total small{color:var(--muted);font-weight:500;margin-right:6px}
    .delta{color:#8aa1b1;font-weight:600}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
    tr:nth-child(even){background:#0e151b}
    /* 列幅: Address を詰めて右側を拡げる */
    th:nth-child(1),td:nth-child(1){width:100px}
    th:nth-child(2),td:nth-child(2){width:380px;font-family:ui-monospace,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:120px}
    th:nth-child(4),td:nth-child(4){width:170px}
    th:nth-child(5),td:nth-child(5){width:180px;text-align:right}
    th:nth-child(6),td:nth-child(6){width:170px;text-align:right}
    th:nth-child(7),td:nth-child(7){width:120px;text-align:right}
    .num{font-variant-numeric: tabular-nums;}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style></head>
  <body><div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total">
        <div><small>Total Volume Traded (Today)</small>${totalStr}</div>
        <div class="delta"><small>vs Yesterday</small>${deltaTotalStr}</div>
      </div>
    </div>
    <table>
      <thead><tr>
        <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th>
        <th>Volume</th><th>ΔVP</th><th>ΔRank</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${timeStampUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / debug/page.html / debug/json/* / data/last.json / data/last_total.txt');
})();
