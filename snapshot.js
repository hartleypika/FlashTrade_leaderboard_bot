// snapshot.js — FlashTrade Leaderboard 最新値スナップショット（改良版）
// ❶ APIレスポンス優先で最新化 ❷ キャッシュ完全バイパス ❸ テキスト重なり防止描画

const { chromium } = require('playwright');
const fs = require('fs');
const { createCanvas } = require('canvas');

const URL = 'https://www.flash.trade/leaderboard';

// -------------------- ユーティリティ --------------------
const nowTag = () => `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const num = v => Number(String(v).replace(/[^\d.-]/g, ''));
const fmt = v => {
  const n = num(v);
  return isNaN(n) ? '' : n.toLocaleString('en-US');
};
function middleEllipsis(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  const keep = Math.max(2, Math.floor((max - 1) / 2));
  return str.slice(0, keep) + '…' + str.slice(-keep);
}
function fitText(ctx, text, maxWidth) {
  // 幅に収まるまで短くして末尾に"…"を付ける
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cand = text.slice(0, mid) + '…';
    if (ctx.measureText(cand).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(0, lo - 1)) + '…';
}

// -------------------- DOM抽出 --------------------
async function scrapeFromDOM(page) {
  // テーブル（tbody tr）系
  const viaTable = await page.$$eval('table tbody tr', trs => {
    return trs.slice(0, 20).map((tr, i) => {
      const tds = Array.from(tr.querySelectorAll('td')).map(td =>
        (td.innerText || '').replace(/\s+/g, ' ').trim()
      );
      return {
        rank: i + 1,
        address: tds[0] || '',
        level:   tds[1] || '',
        faf:     (tds[2] || '').replace(/[^\d,.-]/g, ''),
        volume:  (tds[3] || '').replace(/[$,]/g, '')
      };
    });
  }).catch(() => []);
  if (viaTable?.length >= 10) return viaTable;

  // ARIAロール系
  const viaRole = await page.$$eval('[role="row"]', rows => {
    const pick = rows.slice(0, 25).map((row, i) => {
      const cells = Array.from(row.querySelectorAll('[role="cell"],td,div'));
      const texts = cells.map(c => (c.innerText || c.textContent || '')
        .replace(/\s+/g,' ').trim()).filter(Boolean);
      return { texts };
    }).filter(x => x.texts.length >= 4).slice(0, 20);

    return pick.map((r, idx) => ({
      rank: idx + 1,
      address: r.texts[0] || '',
      level:   r.texts[1] || '',
      faf:     (r.texts[2] || '').replace(/[^\d,.-]/g, ''),
      volume:  (r.texts[3] || '').replace(/[$,]/g, '')
    }));
  }).catch(() => []);
  if (viaRole?.length >= 10) return viaRole;

  // 最終手段：bodyテキストから
  const body = await page.evaluate(() => document.body.innerText);
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 400);
  const addrRe = /^[1-9A-HJ-NP-Za-km-z]{3,}.*[1-9A-HJ-NP-Za-km-z]{2,}$/;
  const usdRe  = /^\$?\d{1,3}(,\d{3})*(\.\d+)?$/;

  const rows = [];
  for (let i = 0; i < lines.length - 6 && rows.length < 20; i++) {
    const a = lines[i];
    const v = lines.slice(i, i+6).find(s => usdRe.test(s));
    if (addrRe.test(a) && v) {
      rows.push({ rank: rows.length+1, address: a, level: '', faf: '', volume: v.replace(/[$,]/g,'') });
    }
  }
  return rows;
}

// -------------------- 実行本体 --------------------
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--use-gl=swiftshader', '--window-size=1500,1900',
    ],
  });

  // キャッシュ完全無効 & SW遮断
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1900 },
    timezoneId: 'UTC',
    bypassCSP: true,
    serviceWorkers: 'block',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    extraHTTPHeaders: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  });
  await context.route('**/*', route => {
    const req = route.request();
    route.continue({
      headers: { ...req.headers(), 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
  });

  const page = await context.newPage();

  // APIレスポンスを捕捉（最新優先）
  const apiDumps = [];
  page.on('response', async res => {
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (/(xhr|fetch)/i.test(res.request().resourceType()) && ct.includes('application/json')) {
        const u = res.url();
        if (/(leader|board|rank|volume|stats)/i.test(u)) {
          const t = await res.text();
          apiDumps.push({ u, t, ts: Date.now() });
        }
      }
    } catch {}
  });

  // 1回目ロード
  await page.goto(`${URL}?r=${nowTag()}`, { waitUntil: 'networkidle', timeout: 120_000 });
  // 値が0/空でないことを確認
  await page.waitForFunction(() => {
    const cell =
      document.querySelector('table tbody tr td:last-child') ||
      document.querySelector('[role="row"] [role="cell"]:last-child');
    if (!cell) return false;
    const t = (cell.innerText || '').trim();
    return /^\$?\d/.test(t) && !/^\$?0(?:\.0+)?$/.test(t);
  }, { timeout: 20_000 }).catch(() => {});

  // “最新化”のため1回だけリロードして変化を見る
  const firstShot = await page.evaluate(() => {
    const c =
      document.querySelector('table tbody tr td:last-child') ||
      document.querySelector('[role="row"] [role="cell"]:last-child');
    return c ? (c.innerText || '').trim() : '';
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const secondShot = await page.evaluate(() => {
    const c =
      document.querySelector('table tbody tr td:last-child') ||
      document.querySelector('[role="row"] [role="cell"]:last-child');
    return c ? (c.innerText || '').trim() : '';
  });
  // 変化がなく“古臭い”可能性があれば別URL（乱数付与）で再ロード
  if (firstShot === secondShot) {
    await page.goto(`${URL}?fresh=${nowTag()}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
  }

  // まずAPIから試す（最新timestampを選択）
  let rows = [];
  let bestDump = null;
  if (apiDumps.length) {
    apiDumps.sort((a,b) => b.ts - a.ts);
    for (const d of apiDumps) {
      try {
        const obj = JSON.parse(d.t);
        // 配列のどこかに {address, volume...} がまとまっている想定で探索
        const stack = [obj];
        while (stack.length) {
          const v = stack.pop();
          if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
            const mapped = v.map((o, i) => ({
              rank: i + 1,
              address: o.address || o.wallet || o.addr || o.user || o.owner || '',
              level:   o.level ? `LVL ${o.level}` : '',
              faf:     String(o.faf_staked ?? o.faf ?? ''),
              volume:  String(o.volumeUsd ?? o.volume_usd ?? o.volume ?? o.volUsd ?? 0),
            })).filter(x => x.address && num(x.volume) > 0);
            if (mapped.length >= 10) { rows = mapped.slice(0, 20); bestDump = d.u; break; }
          } else if (v && typeof v === 'object') {
            for (const k in v) stack.push(v[k]);
          }
        }
        if (rows.length) break;
      } catch {}
    }
  }

  // APIでダメならDOM
  if (!rows.length) rows = await scrapeFromDOM(page);

  if (!rows.length) {
    await browser.close();
    console.error('No rows captured.');
    process.exit(1);
  }

  rows = rows.slice(0, 20);

  // -------- 画像生成（重なり防止仕様） --------
  // カラム幅・配置（px）
  const PAD_L = 48;
  const COL = {
    rank:  70,       // 右寄せ
    medal: 28,       // アイコン用
    addr:  520,      // 可変長 → fitText
    level: 140,
    faf:   180,      // 右寄せ
    vol:   240       // 右寄せ
  };
  const ROW_H = 64;
  const HEADER_H = 170;
  const FOOT_H = 50;
  const W = PAD_L + COL.rank + COL.medal + COL.addr + COL.level + COL.faf + COL.vol + PAD_L;
  const H = HEADER_H + rows.length * ROW_H + FOOT_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#182428';
  ctx.fillRect(0, 0, W, H);

  // タイトル
  ctx.fillStyle = '#EFFFF9';
  ctx.font = 'bold 46px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('⚡ FlashTrade Leaderboard — Top 20', PAD_L, 58);

  // タイムスタンプ
  ctx.font = '22px Arial';
  ctx.fillStyle = '#AFC3BE';
  const ts = new Date().toISOString().slice(0,16).replace('T',' ');
  ctx.fillText(`Snapshot (UTC): ${ts}`, PAD_L, 92);

  // 合計
  const totalVol = rows.reduce((s,r) => s + (num(r.volume)||0), 0);
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#FFEBAA';
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, PAD_L, 130);

  // ヘッダ
  ctx.fillStyle = '#D4E4DF';
  ctx.font = 'bold 24px Arial';
  let x = PAD_L;
  ctx.textAlign = 'right'; ctx.fillText('Rank', x + COL.rank, 164); x += COL.rank + 10;
  ctx.textAlign = 'left';  ctx.fillText('', x, 164);                 x += COL.medal + 10;
  ctx.textAlign = 'left';  ctx.fillText('Address', x, 164);          x += COL.addr;
  ctx.textAlign = 'left';  ctx.fillText('Level', x, 164);            x += COL.level;
  ctx.textAlign = 'right'; ctx.fillText('FAF',   x + COL.faf, 164);  x += COL.faf + 20;
  ctx.textAlign = 'right'; ctx.fillText('Volume',x + COL.vol, 164);

  // 行
  let y = HEADER_H + 4;
  for (const r of rows) {
    // 偶数行の帯
    if (r.rank % 2 === 0) {
      ctx.fillStyle = '#1E2E32';
      ctx.fillRect(PAD_L - 10, y - 28, W - PAD_L*2 + 20, ROW_H - 8);
    }

    // 列描画
    x = PAD_L;

    // Rank
    ctx.textAlign = 'right';
    ctx.font = '26px Arial';
    ctx.fillStyle = '#CFE1DC';
    ctx.fillText(String(r.rank).padStart(2,'0'), x + COL.rank, y);
    x += COL.rank + 10;

    // Medal
    ctx.textAlign = 'left';
    ctx.font = '26px Arial';
    if (r.rank === 1) { ctx.fillStyle = '#FFD700'; ctx.fillText('🥇', x, y); }
    else if (r.rank === 2) { ctx.fillStyle = '#C0C0C0'; ctx.fillText('🥈', x, y); }
    else if (r.rank === 3) { ctx.fillStyle = '#CD7F32'; ctx.fillText('🥉', x, y); }
    x += COL.medal + 10;

    // Address（fitText）
    ctx.fillStyle = '#E8F4F1';
    ctx.font = '26px Arial';
    const addrRaw = (r.address || '').replace(/\s+/g,' ');
    const addrDisp = fitText(ctx, addrRaw, COL.addr - 6); // 幅内に省略
    ctx.fillText(addrDisp, x, y);
    x += COL.addr;

    // Level
    ctx.fillStyle = '#B5CBC6';
    ctx.font = '24px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(r.level || '', x, y);
    x += COL.level;

    // FAF（右寄せ）
    ctx.fillStyle = '#B5CBC6';
    ctx.font = '24px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(r.faf ? fmt(r.faf) : '', x + COL.faf, y);
    x += COL.faf + 20;

    // Volume（右寄せ）
    ctx.fillStyle = '#F6FFFC';
    ctx.font = '26px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(`$${fmt(r.volume)}`, x + COL.vol, y);

    y += ROW_H;
  }

  // フッタ
  ctx.strokeStyle = '#586B6F';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(PAD_L - 10, y - 20); ctx.lineTo(W - PAD_L + 10, y - 20); ctx.stroke();
  ctx.fillStyle = '#AABBB7';
  ctx.font = '18px Arial';
  ctx.textAlign = 'left';
  ctx.fillText(
    `Source: ${bestDump ? 'API ' + bestDump : 'DOM snapshot'}  •  Medals for Top 3  •  Layout uses measured truncation`,
    PAD_L, y + 18
  );

  // 保存
  fs.writeFileSync('leaderboard_snapshot.png', canvas.toBuffer('image/png'));
  await page.screenshot({ path: 'page_full.png', fullPage: true }).catch(()=>{});
  const html = await page.evaluate(() => (document.querySelector('table')||document.body).outerHTML);
  fs.writeFileSync('table.html', html);
  console.log('✅ Saved: leaderboard_snapshot.png');

  await browser.close();
})();
