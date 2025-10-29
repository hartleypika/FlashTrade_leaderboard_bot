// snapshot.js - FlashTrade Leaderboard 最新値取得＋画像生成（完全版）

const { chromium } = require('playwright');
const fs = require('fs');
const { createCanvas } = require('canvas');

const BASE_URL = 'https://www.flash.trade/leaderboard';

function fmt(n) {
  const num = Number(String(n).replace(/[^\d.-]/g, ''));
  if (isNaN(num)) return '';
  return num.toLocaleString('en-US');
}

// ─────────────────────────────
// DOMテーブル読み取り関数
async function scrapeRows(page) {
  const viaTable = await page.$$eval('table tbody tr', trs => {
    return trs.slice(0, 20).map((tr, i) => {
      const tds = Array.from(tr.querySelectorAll('td')).map(td =>
        td.innerText.replace(/\s+/g, ' ').trim()
      );
      return {
        rank: i + 1,
        address: tds[0] || '',
        level:   tds[1] || '',
        faf:     (tds[2] || '').replace(/[^\d,.-]/g, ''),
        volume:  (tds[3] || '').replace(/[$,]/g, ''),
        _raw:    tds
      };
    });
  }).catch(() => []);
  if (viaTable && viaTable.length >= 5 && viaTable.some(r => r._raw.length >= 4)) {
    return viaTable;
  }

  const viaRole = await page.$$eval('[role="row"]', rows => {
    const pick = rows.slice(0, 25).map((row, i) => {
      const cells = Array.from(row.querySelectorAll('[role="cell"], td, div'));
      const texts = cells
        .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      return { i, texts };
    }).filter(x => x.texts.length >= 4).slice(0, 20);

    return pick.map((r, idx) => ({
      rank: idx + 1,
      address: r.texts[0] || '',
      level:   r.texts[1] || '',
      faf:     (r.texts[2] || '').replace(/[^\d,.-]/g, ''),
      volume:  (r.texts[3] || '').replace(/[$,]/g, ''),
      _raw:    r.texts
    }));
  }).catch(() => []);
  if (viaRole && viaRole.length >= 5) return viaRole;

  const bigText = await page.evaluate(() => document.body.innerText);
  const lines = bigText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 400);

  const addrRe = /^[1-9A-HJ-NP-Za-km-z]{2,5}.*[1-9A-HJ-NP-Za-km-z]{2,5}$/;
  const usdRe  = /^\$?\d{1,3}(,\d{3})*(\.\d+)?$/;

  const rowsLoose = [];
  for (let i = 0; i < lines.length - 5 && rowsLoose.length < 20; i++) {
    const a = lines[i];
    const v = lines.slice(i, i + 6).find(s => usdRe.test(s));
    if (addrRe.test(a) && v) {
      rowsLoose.push({
        rank: rowsLoose.length + 1,
        address: a,
        level:   '',
        faf:     '',
        volume:  v.replace(/[$,]/g, ''),
        _raw:    [a, '', '', v]
      });
    }
  }
  return rowsLoose;
}

// ─────────────────────────────

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--window-size=1500,1800',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1500, height: 1800 },
    locale: 'en-US',
    timezoneId: 'UTC',
    bypassCSP: true,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  });

  // 各リクエストにも no-cache を付与
  await context.route('**/*', route => {
    const req = route.request();
    route.continue({
      headers: { ...req.headers(), 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
  });

  const page = await context.newPage();
  const apiJson = [];
  page.on('response', async (res) => {
    try {
      const type = res.request().resourceType();
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if ((type === 'xhr' || type === 'fetch') && ct.includes('application/json')) {
        const url = res.url();
        if (/(leader|board|rank|volume)/i.test(url)) {
          const text = await res.text();
          apiJson.push({ url, text });
          const safe = Buffer.from(url).toString('base64').slice(0,48);
          fs.writeFileSync(`api_${safe}.json`, text);
        }
      }
    } catch (_) {}
  });

  await page.goto(`${BASE_URL}?t=${Date.now()}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(6000);

  // 値が入るまで待つ
  await page.waitForFunction(() => {
    const cell = document.querySelector('table tbody tr td:last-child') ||
                 document.querySelector('[role="row"] [role="cell"]:last-child');
    if (!cell) return false;
    const t = (cell.innerText || '').trim();
    return /^\$\d/.test(t) && !/^\$0/.test(t);
  }, { timeout: 20000 }).catch(()=>{});

  await page.screenshot({ path: 'page_full.png', fullPage: true }).catch(()=>{});
  const tableHtml = await page.evaluate(() => {
    const t = document.querySelector('table') || document.querySelector('[role="table"]') || document.body;
    return t.outerHTML;
  });
  fs.writeFileSync('table.html', tableHtml);

  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await Promise.race([
        page.waitForSelector('table tbody tr', { timeout: 20000 }),
        page.waitForSelector('[role="row"], [data-testid*=row], .row', { timeout: 20000 }),
      ]);
    } catch (_) {}

    rows = await scrapeRows(page);
    if (rows.length >= 10) {
      await page.waitForTimeout(2000);
      rows = await scrapeRows(page);
    }
    if (rows.length >= 10) break;

    if (attempt < 3) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(7000);
      await page.waitForFunction(() => {
        const cell = document.querySelector('table tbody tr td:last-child') ||
                     document.querySelector('[role="row"] [role="cell"]:last-child');
        if (!cell) return false;
        const t = (cell.innerText || '').trim();
        return /^\$\d/.test(t) && !/^\$0/.test(t);
      }, { timeout: 20000 }).catch(()=>{});
    }
  }

  // APIフォールバック
  function tryFromApiDump(dumps) {
    for (const { text } of dumps) {
      try {
        const data = JSON.parse(text);
        const stack = [data];
        while (stack.length) {
          const v = stack.pop();
          if (Array.isArray(v) && v.length >= 10 && typeof v[0] === 'object') {
            const mapped = v.map((o, i) => ({
              rank: i + 1,
              address: o.address || o.wallet || o.addr || o.user || '',
              level:   o.level ? `LVL ${o.level}` : '',
              faf:     String(o.faf_staked ?? o.faf ?? ''),
              volume:  String(o.volumeUsd ?? o.volume_usd ?? o.volume ?? o.volUsd ?? 0),
            })).filter(x => x.address && x.volume && x.volume !== '0');
            if (mapped.length >= 10) return mapped.slice(0, 20);
          } else if (v && typeof v === 'object') {
            for (const k in v) stack.push(v[k]);
          }
        }
      } catch {}
    }
    return null;
  }
  if (!rows || rows.length < 10) {
    const apiRows = tryFromApiDump(apiJson);
    if (apiRows && apiRows.length >= 10) rows = apiRows;
  }

  if (!rows.length) {
    await browser.close();
    console.error('No rows captured.');
    process.exit(1);
  }

  rows = rows.slice(0, 20);

  // ──────────── 画像生成 ────────────
  const W = 1400, H = 160 + rows.length * 66 + 70;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#182428';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#EFFFF9';
  ctx.font = 'bold 50px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('⚡ FlashTrade Leaderboard — Top 20', 50, 60);

  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  ctx.font = '22px Arial';
  ctx.fillStyle = '#ABBDB6';
  ctx.fillText(`Snapshot (UTC): ${ts}`, 50, 95);

  const totalVol = rows.reduce((s, r) => s + (Number(r.volume) || 0), 0);
  ctx.font = 'bold 30px Arial';
  ctx.fillStyle = '#FFEBAA';
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, 50, 130);

  const X = { rank: 80, addr: 180, level: 560, faf: 820, vol: 1320 };
  ctx.fillStyle = '#D2E6E1';
  ctx.font = 'bold 26px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Rank', X.rank, 170);
  ctx.fillText('Address', X.addr, 170);
  ctx.fillText('Level', X.level, 170);
  ctx.textAlign = 'right';
  ctx.fillText('FAF', X.faf, 170);
  ctx.fillText('Volume', X.vol, 170);

  let y = 215;
  const rowH = 66;
  rows.forEach((r) => {
    if (r.rank % 2 === 0) {
      ctx.fillStyle = '#1E2E32';
      ctx.fillRect(40, y - 30, W - 80, rowH - 12);
    }
    ctx.textAlign = 'left';
    ctx.font = '26px Arial';
    if (r.rank === 1) { ctx.fillStyle = '#FFD700'; ctx.fillText('🥇', X.rank, y); }
    else if (r.rank === 2) { ctx.fillStyle = '#C0C0C0'; ctx.fillText('🥈', X.rank, y); }
    else if (r.rank === 3) { ctx.fillStyle = '#CD7F32'; ctx.fillText('🥉', X.rank, y); }
    else { ctx.fillStyle = '#C8DCD7'; ctx.fillText(String(r.rank).padStart(2, '0'), X.rank, y); }

    ctx.fillStyle = '#E0EBE7';
    const addr = (r.address || '').replace(/\s+/g, ' ');
    const addrTrim = addr.length > 24 ? addr.slice(0, 24) + '…' : addr;
    ctx.fillText(addrTrim, X.addr, y);

    ctx.fillStyle = '#B5D2CC';
    ctx.fillText(r.level || '', X.level, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#B5D2CC';
    ctx.fillText(r.faf ? fmt(r.faf) : '', X.faf, y);

    ctx.fillStyle = '#F0FFFA';
    ctx.fillText(`$${fmt(r.volume)}`, X.vol, y);

    y += rowH;
  });

  ctx.strokeStyle = '#587072'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(40, y + 10); ctx.lineTo(W - 40, y + 10); ctx.stroke();
  ctx.fillStyle = '#ADBFBA'; ctx.font = '20px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Medals for Top 3. Δ/Rank Diff will appear from the second day.', 50, y + 40);

  fs.writeFileSync('leaderboard_snapshot.png', canvas.toBuffer('image/png'));
  console.log('✅ Saved: leaderboard_snapshot.png');

  await browser.close();
})();
