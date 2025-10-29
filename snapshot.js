// snapshot.js (refresh & layout improved, CommonJS)
const { chromium } = require('playwright');
const fs = require('fs');
const { createCanvas } = require('canvas');

const BASE_URL = 'https://www.flash.trade/leaderboard';

function fmt(n) {
  const num = Number(String(n).replace(/[^\d.-]/g, ''));
  if (isNaN(num)) return '';
  return num.toLocaleString('en-US');
}

async function scrapeRows(page) {
  return await page.evaluate(() => {
    // 優先: table
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    if (trs.length) {
      return trs.slice(0, 20).map((tr, i) => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td =>
          td.innerText.replace(/\s+/g, ' ').trim()
        );
        // 期待: [Address, Level, FAF, Volume, ...] に合わせて調整
        return {
          rank: i + 1,
          address: tds[0] || '',
          level: tds[1] || '',
          faf: (tds[2] || '').replace(/[^\d,.-]/g, ''),
          volume: (tds[3] || '').replace(/[$,]/g, ''),
        };
      });
    }
    // Fallback: カスタム行
    const rows = Array.from(document.querySelectorAll('[data-testid*=row], .row')).slice(0, 20);
    return rows.map((el, i) => {
      const text = el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const address = text[0] || '';
      const level = (text.find(t => /^LVL/i.test(t)) || '').trim();
      const faf = (text.find(t => /FAF/i.test(t)) || '').replace(/[^\d,.-]/g, '');
      const volStr = (text.find(t => /\$/i.test(t)) || '').replace(/[$,]/g, '');
      return { rank: i + 1, address, level, faf, volume: volStr };
    });
  });
}

(async () => {
  // ── 1) 起動（GPU無し環境対策）
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
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
    extraHTTPHeaders: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
  });
  const page = await context.newPage();

  // ── 2) 遷移（キャッシュバスター付与）
  const url = `${BASE_URL}?t=${Date.now()}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });

  // Cloudflare等の待機
  await page.waitForTimeout(6000);

  // 描画完了まで 最大3回 リトライ＆リロード
  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await Promise.race([
        page.waitForSelector('table tbody tr', { timeout: 20000 }),
        page.waitForSelector('[data-testid*=row], .row', { timeout: 20000 }),
      ]);
    } catch (_) {}

    rows = await scrapeRows(page);
    // 最新更新を反映させるため、1回だけ追い読み
    if (rows.length >= 10) {
      await page.waitForTimeout(2000);
      rows = await scrapeRows(page);
    }
    if (rows.length >= 10) break;

    if (attempt < 3) {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);
    }
  }

  if (!rows.length) {
    await browser.close();
    console.error('No rows captured (page structure or protection may have changed).');
    process.exit(1);
  }

  rows = rows.slice(0, 20);

  // ── 3) 画像生成（レイアウト改善）
  const W = 1400, H = 160 + rows.length * 66 + 70;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#182428';
  ctx.fillRect(0, 0, W, H);

  // タイトル
  ctx.fillStyle = '#EFFFF9';
  ctx.font = 'bold 50px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('⚡ FlashTrade Leaderboard — Top 20', 50, 60);

  // タイムスタンプ
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  ctx.font = '22px Arial';
  ctx.fillStyle = '#ABBDB6';
  ctx.fillText(`Snapshot (UTC): ${ts}`, 50, 95);

  // 合計
  const totalVol = rows.reduce((s, r) => s + (Number(r.volume) || 0), 0);
  ctx.font = 'bold 30px Arial';
  ctx.fillStyle = '#FFEBAA';
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, 50, 130);

  // 列位置（右寄せを使って重なり防止）
  const X = {
    rank: 80,              // left
    addr: 180,             // left
    level: 560,            // left
    faf: 820,              // right
    vol: 1320,             // right（画像幅に合わせて右端）
  };

  // ヘッダー
  ctx.fillStyle = '#D2E6E1';
  ctx.font = 'bold 26px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Rank', X.rank, 170);
  ctx.fillText('Address', X.addr, 170);
  ctx.fillText('Level', X.level, 170);
  ctx.textAlign = 'right';
  ctx.fillText('FAF', X.faf, 170);
  ctx.fillText('Volume', X.vol, 170);

  // 行
  let y = 215;
  const rowH = 66;
  rows.forEach((r) => {
    // ストライプ
    if (r.rank % 2 === 0) {
      ctx.fillStyle = '#1E2E32';
      ctx.fillRect(40, y - 30, W - 80, rowH - 12);
    }

    // ランク＆メダル
    ctx.textAlign = 'left';
    ctx.font = '26px Arial';
    if (r.rank === 1) { ctx.fillStyle = '#FFD700'; ctx.fillText('🥇', X.rank, y); }
    else if (r.rank === 2) { ctx.fillStyle = '#C0C0C0'; ctx.fillText('🥈', X.rank, y); }
    else if (r.rank === 3) { ctx.fillStyle = '#CD7F32'; ctx.fillText('🥉', X.rank, y); }
    else { ctx.fillStyle = '#C8DCD7'; ctx.fillText(String(r.rank).padStart(2, '0'), X.rank, y); }

    // アドレス（最大24文字）
    ctx.fillStyle = '#E0EBE7';
    const addr = (r.address || '').replace(/\s+/g, ' ');
    const addrTrim = addr.length > 24 ? addr.slice(0, 24) + '…' : addr;
    ctx.fillText(addrTrim, X.addr, y);

    // レベル
    ctx.fillStyle = '#B5D2CC';
    ctx.fillText(r.level || '', X.level, y);

    // FAF（右寄せ）
    ctx.textAlign = 'right';
    ctx.fillStyle = '#B5D2CC';
    ctx.fillText(r.faf ? fmt(r.faf) : '', X.faf, y);

    // Volume（右寄せ）
    ctx.fillStyle = '#F0FFFA';
    ctx.fillText(`$${fmt(r.volume)}`, X.vol, y);

    y += rowH;
  });

  // 備考
  ctx.strokeStyle = '#587072'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(40, y + 10); ctx.lineTo(W - 40, y + 10); ctx.stroke();
  ctx.fillStyle = '#ADBFBA'; ctx.font = '20px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Medals for Top 3. Δ/Rank Diff will appear from the second day.', 50, y + 40);

  fs.writeFileSync('leaderboard_snapshot.png', canvas.toBuffer('image/png'));
  console.log('✅ Saved: leaderboard_snapshot.png');

  await browser.close();
})();
