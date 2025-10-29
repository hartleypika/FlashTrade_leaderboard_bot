// snapshot.js
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const URL = 'https://www.flash.trade/leaderboard';

const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '');
const fmtUsd = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const pickNumber = (v) => {
  if (v == null) return 0;
  const s = String(v);
  const m = s.match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : (typeof v === 'number' ? v : 0);
};

// 候補キーから最適なフィールドを引く
const pickField = (obj, keys) => {
  for (const k of keys) {
    const hit = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit) return obj[hit];
  }
  // 前方一致（例: totalVolume, walletAddress など）
  for (const k of keys) {
    const hit = Object.keys(obj).find((x) => x.toLowerCase().includes(k.toLowerCase()));
    if (hit) return obj[hit];
  }
  return undefined;
};

// JSON の配列候補を総当りで抽出
const digArrays = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) out.push(node);
  for (const v of Object.values(node)) digArrays(v, out);
  return out;
};

// JSON から Top20 を推定
function guessTop20FromJson(pool) {
  // すべての JSON から配列候補を集める
  let candidates = [];
  for (const { body } of pool) candidates.push(...digArrays(body));

  // “アドレスっぽい文字列” と “ボリュームっぽい数値” を含む配列を優先
  const isAddr = (s) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(s || '')); // base58 っぽい
  const scoreArray = (arr) => {
    let score = 0;
    for (const it of arr.slice(0, 30)) {
      if (!it || typeof it !== 'object') continue;
      const addr =
        pickField(it, ['address', 'wallet', 'owner', 'account', 'id']) ||
        Object.values(it).find((x) => isAddr(x));
      const vol =
        pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
        Object.values(it).find((x) => typeof x === 'number' && x > 1000);
      if (addr) score += 2;
      if (vol != null) score += 1;
    }
    // 配列長も少し加点
    score += Math.min(arr.length, 50) / 10;
    return score;
  };

  candidates = candidates
    .filter((a) => Array.isArray(a) && a.length >= 10)
    .map((a) => ({ arr: a, score: scoreArray(a) }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const best = candidates[0].arr;

  // 正規化
  const normalized = best.map((it, idx) => {
    // 柔軟にフィールドを当てに行く
    const address =
      pickField(it, ['address', 'wallet', 'owner', 'account', 'id']) ||
      Object.values(it).find((x) => /[1-9A-HJ-NP-Za-km-z]{20,}/.test(String(x || ''))) ||
      '';
    const level = pickField(it, ['level', 'lvl']) ?? '';
    const faf =
      pickField(it, ['faf', 'staked', 'stakedFAF', 'stake']) ??
      pickField(it, ['staked_faf', 'fafStaked']) ??
      '';
    const volRaw =
      pickField(it, ['volume', 'totalVolume', 'vp', 'points', 'voltagePoints', 'value']) ??
      Object.values(it).find((x) => typeof x === 'number');

    const volumeNum = pickNumber(volRaw);
    const volume = fmtUsd(volumeNum);

    return {
      rank: idx + 1,
      address: String(address).slice(0, 50),
      level: String(level ?? ''),
      faf: String(faf ?? ''),
      volume,
      volumeNum,
    };
  });

  // volume の降順で並び替えた上で rank 付け直し
  const top = normalized
    .filter((x) => x.address)
    .sort((a, b) => b.volumeNum - a.volumeNum)
    .slice(0, 20)
    .map((x, i) => ({ ...x, rank: i + 1 }));

  return top.length ? top : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
  });
  const page = await context.newPage();

  // 受信 JSON をすべて保存＆保持
  const jsonPool = [];
  await fs.mkdir('debug/json', { recursive: true });

  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const url = res.url();
      const body = await res.json();

      jsonPool.push({ url, body });

      const name =
        url
          .replace(/^https?:\/\//, '')
          .replace(/[^\w.-]+/g, '_')
          .slice(0, 180) +
        '_' +
        crypto.createHash('md5').update(url).digest('hex').slice(0, 8) +
        '.json';
      await fs.writeFile(path.join('debug/json', name), JSON.stringify(body, null, 2), 'utf8');
    } catch {}
  });

  // キャッシュ抑止
  await page.setExtraHTTPHeaders({ 'cache-control': 'no-cache', pragma: 'no-cache' });

  // 遷移（nocache クエリ）
  await page.goto(`${URL}?nocache=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // 少し操作して 8〜12 秒ほどネットワークを待つ（CSR の fetch を待機）
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(4000);

  // JSON から推定
  let top20 = guessTop20FromJson(jsonPool);

  // 最後の保険：DOM の table/role を見る（うまく行けばそのまま使える）
  if (!top20) {
    const rows = await page.evaluate(() => {
      const fromTable = Array.from(document.querySelectorAll('table tbody tr'))
        .slice(0, 20)
        .map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) =>
            (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
          )
        );

      const fromRole = Array.from(document.querySelectorAll('[role="row"]'))
        .map((row) =>
          Array.from(row.querySelectorAll('[role="cell"], td')).map((c) =>
            (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim()
          )
        )
        .filter((cells) => cells.length >= 4)
        .slice(0, 20);

      return fromTable.length >= 10 ? fromTable : fromRole;
    });

    if (rows && rows.length) {
      top20 = rows
        .map((tds, i) => {
          const addr = tds[1] || '';
          const vol = tds.find((x) => /\$\d/.test(x)) || '';
          return {
            rank: i + 1,
            address: addr,
            level: tds[2] || '',
            faf: tds[3] || '',
            volume: vol,
            volumeNum: pickNumber(vol),
          };
        })
        .filter((x) => x.address)
        .slice(0, 20);
    }
  }

  // ここまでで無理なら HTML 保存してエラー終了
  if (!top20 || !top20.length) {
    await fs.mkdir('debug', { recursive: true });
    await fs.writeFile('debug/page.html', await page.content(), 'utf8');
    await browser.close();
    console.error('No rows captured. Saved HTML to debug/page.html');
    process.exit(1);
  }

  // 前日データ（差分用）
  let yesterday = [];
  try {
    yesterday = JSON.parse(await fs.readFile('data/last.json', 'utf8'));
  } catch {}
  const mapY = new Map((yesterday || []).map((r) => [r.address, r]));
  const withDiff = top20.map((t) => {
    const y = mapY.get(t.address);
    return {
      ...t,
      deltaVP: y ? t.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? t.rank - (y.rank || 0) : null,
    };
  });

  // 次回用に保存
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/last.json', JSON.stringify(top20, null, 2), 'utf8');

  // 画像カードをレンダリング
  const rowsHtml = withDiff
    .map((r) => {
      const dVP =
        r.deltaVP == null ? '–' : `${r.deltaVP >= 0 ? '+' : '-'}${fmtUsd(Math.abs(r.deltaVP))}`;
      const dRank =
        r.deltaRank == null
          ? '–'
          : r.deltaRank < 0
          ? `▲${Math.abs(r.deltaRank)}`
          : r.deltaRank > 0
          ? `▼${r.deltaRank}`
          : '＝';
      const dRankColor =
        r.deltaRank == null ? '#8aa1b1' : r.deltaRank < 0 ? '#2ecc71' : r.deltaRank > 0 ? '#e74c3c' : '#8aa1b1';

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
  <html>
  <head>
    <meta charset="utf-8"/>
    <style>
      body { margin:0; background:#0b1217; color:#e6f0f7; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      .wrap { width: 1200px; margin: 24px auto; background:#0f151a; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); overflow:hidden; }
      .title { padding:18px 22px; font-size:24px; font-weight:700; border-bottom:1px solid #1b2732; }
      table { width:100%; border-collapse:collapse; font-size:16px; }
      th, td { padding:12px 14px; border-bottom:1px solid #15202b; }
      th { text-align:left; color:#8aa1b1; font-weight:600; background:#0e151b; position:sticky; top:0; }
      tr:nth-child(even){ background:#0e151b; }
      td:first-child { width:110px; }
      td:nth-child(2) { width:420px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
      .footer { padding:12px 14px; color:#8aa1b1; font-size:12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <table>
        <thead>
          <tr>
            <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th style="text-align:right">Volume</th><th style="text-align:right">ΔVP</th><th style="text-align:right">ΔRank</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="footer">Snapshot (UTC): ${new Date().toISOString().slice(0,16).replace('T',' ')}</div>
    </div>
  </body>
  </html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: 'load' });
  await card.screenshot({ path: 'leaderboard_card.png', fullPage: true });

  await browser.close();
  console.log('✅ Done. Saved leaderboard_card.png, data/last.json and debug/json/*.json');
})();
