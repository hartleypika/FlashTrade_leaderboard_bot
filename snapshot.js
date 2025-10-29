// snapshot.js (robust CommonJS)
// 1) Playwrightで leaderboard の表データを抽出（待機・リトライ付き）
// 2) node-canvas で Top20 のランキング画像を生成

const { chromium } = require('playwright');
const fs = require('fs');
const { createCanvas } = require('canvas');

const URL = 'https://www.flash.trade/leaderboard';

function fmt(n) {
  const num = Number(String(n).replace(/[^\d.-]/g, ''));
  if (isNaN(num)) return '';
  return num.toLocaleString('en-US');
}

// テーブルから上位20件を抽出する関数（ページ内で実行）
async function scrapeRows(page) {
  return await page.evaluate(() => {
    // 優先: 通常の table
    const tableRows = Array.from(document.querySelectorAll('table tbody tr'));
    if (tableRows.length >= 5) {
      return tableRows.slice(0, 20).map((tr, i) => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        // 期待する並びに合わせて調整（必要に応じてここは微調整）
        return {
          rank: i + 1,
          address: tds[0] || '',
          level: tds[1] || '',
          faf: (tds[2] || '').replace(/[^\d,.-]/g, ''),
          volume: (tds[3] || '').replace(/[$,]/g, ''),
        };
      });
    }

    // Fallback: data-testid やカスタム行
    const guessRows = Array.from(document.querySelectorAll('[data-testid*=row], .row')).slice(0, 20);
    if (guessRows.length) {
      return guessRows.map((el, i) => {
        const text = el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        const address = text[0] || '';
        const level = (text.find(t => /^LVL/i.test(t)) || '').trim();
        const faf = (text.find(t => /FAF/i.test(t)) || '').replace(/[^\d,.-]/g, '');
        const volStr = (text.find(t => /\$/i.test(t)) || '').replace(/[$,]/g, '');
        return { rank: i + 1, address, level, faf, volume: volStr };
      });
    }

    return [];
  });
}

(async () => {
  // ===== 1) ブラウザ起動（GPUなし環境向けフラグ）
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
      '--window-size=1400,1600',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1600 },
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();

  // ===== 2) ページ遷移 & 待機
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // Cloudflare等の中間画面待機
  await page.waitForTimeout(6000);

  // 描画完了までリトライ（最大 3 回、各 20 秒）
  let rows = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // まずは table/row が出るのを待機
      await Promise.race([
        page.waitForSelector('table tbody tr', { timeout: 20000 }),
        page.waitForSelector('[data-testid*=row], .row', { timeout: 20000 }),
      ]);
    } catch (_) {
      // 何も出なければリロード
    }

    rows = await scrapeRows(page);
    if (rows.length >= 5) break; // 十分取れたら抜ける

    // まだ少ない → 少し待つ or リロードして再試行
    if (attempt < 3) {
      await page.waitForTimeout(5000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }
  }

  if (!rows.length) {
    await browser.close();
    console.error('No rows captured (page structure or protection may have changed).');
    process.exit(1);
  }

  // 上位20に限定
  rows = rows.slice(0, 20);

  // ===== 3) 画像生成
  const W = 1300, H = 160 + rows.length * 60 + 60;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#182428';
  ctx.fillRect(0, 0, W, H);

  // タイトル
  ctx.fillStyle = '#EFFFF9';
  ctx.font = 'bold 46px Arial';
  ctx.fillText('⚡ FlashTrade Leaderboard — Top 20', 50, 60);

  // タイムスタンプ
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  ctx.font = '22px Arial';
  ctx.fillStyle = '#ABBDB6';
  ctx.fillText(`Snapshot (UTC): ${ts}`, 50, 95);

  // 合計ボリューム
  const totalVol = rows.reduce((s, r) => s + (Number(r.volume) || 0), 0);
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#FFEBAA';
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, 50, 130);

  // ヘッダー
  const X = { rank: 60, addr: 140, level: 520, faf: 640, vol: 860 };
  ctx.fillStyle = '#D2E6E1';
  ctx.font = 'bold 26px Arial';
  ctx.fillText('Rank',   X.rank,  170);
  ctx.fillText('Address',X.addr,  170);
  ctx.fillText('Level',  X.level, 170);
  ctx.fillText('FAF',    X.faf,   170);
  ctx.fillText('Volume', X.vol,   170);

  // 行
  let y = 210;
  const rowH = 58;
  for (const r of rows) {
    if (r.rank % 2 === 0) {
      ctx.fillStyle = '#1E2E32';
      ctx.fillRect(40, y - 30, W - 80, rowH - 8);
    }
    ctx.font = '26px Arial';
    if (r.rank === 1) { ctx.fillStyle = '#FFD700'; ctx.fillText('🥇', X.rank, y); }
    else if (r.rank === 2) { ctx.fillStyle = '#C0C0C0'; ctx.fillText('🥈', X.rank, y); }
    else if (r.rank === 3) { ctx.fillStyle = '#CD7F32'; ctx.fillText('🥉', X.rank, y); }
    else { ctx.fillStyle = '#C8DCD7'; ctx.fillText(String(r.rank).padStart(2,'0'), X.rank, y); }

    ctx.fillStyle = '#E0EBE7';
    const addr = (r.address || '').replace(/\s+/g, ' ');
    ctx.fillText(addr.length > 22 ? addr.slice(0,22) + '…' : addr, X.addr, y);

    ctx.fillStyle = '#B5D2CC';
    ctx.fillText(r.level || '', X.level, y);
    ctx.fillText(r.faf ? fmt(r.faf) : '', X.faf, y);

    ctx.fillStyle = '#F0FFFA';
    ctx.fillText(`$${fmt(r.volume)}`, X.vol, y);

    y += rowH;
  }

  // 備考
  ctx.strokeStyle = '#587072'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(40, y + 10); ctx.lineTo(W - 40, y + 10); ctx.stroke();
  ctx.fillStyle = '#ADBFBA'; ctx.font = '20px Arial';
  ctx.fillText('Medals for Top 3. Δ/Rank Diff will appear from the second day.', 50, y + 40);

  fs.writeFileSync('leaderboard_snapshot.png', canvas.toBuffer('image/png'));
  console.log('✅ Saved: leaderboard_snapshot.png');

  await browser.close();
})();
