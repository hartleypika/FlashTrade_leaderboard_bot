// snapshot.js
// 1) キャッシュ無効化して /leaderboard を開く
// 2) JSON / DOM / テキストの順に多段リトライで取得
// 3) どうしても取れなければデバッグアーティファクトを残して「成功終了」(exit 0)
//    → ワークフローを止めず、毎日画像生成の後続へ進めるため

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.flash.trade/leaderboard';

function now() {
  return new Date().toISOString();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function saveDebug(page, label) {
  try {
    const html = await page.content();
    await fs.writeFile('debug_page.html', html, 'utf8');
    await page.screenshot({ path: 'debug_page.png', fullPage: true });
    await fs.writeFile('debug_info.txt', `[${now()}] ${label}\n`, 'utf8');
  } catch (_) {}
}

function normalizeRow(tds) {
  const safe = (i) => (tds[i] ?? '').toString().trim();
  let rank = safe(0).replace(/[^\d]/g, '');
  let address = safe(1);
  let level = safe(2);
  let faf = safe(3);
  let volume = safe(4);

  // volume が入っていない場合、$を含むセルを拾う
  if (!/\$\d/.test(volume)) {
    const found = tds.find((s) => /\$\d/.test(String(s)));
    if (found) volume = found;
  }
  const num = (s) => String(s).replace(/[^\d.,\-]/g, '');

  return {
    rank: rank || '',
    address: address || '',
    level: num(level),
    faf: num(faf),
    volume: volume || '',
    _raw: tds,
  };
}

async function extractViaDOM(page) {
  // table tbody tr → なければ role="row"/"cell"
  const rows = await page.evaluate(() => {
    const pickTable = () => {
      const trs = Array.from(document.querySelectorAll('table tbody tr'));
      if (trs.length < 5) return null;
      return trs.slice(0, 25).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) =>
          (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
        )
      );
    };
    const pickRole = () => {
      const divRows = Array.from(document.querySelectorAll('[role="row"]'));
      const valid = divRows
        .map((row) => {
          const cells = Array.from(row.querySelectorAll('[role="cell"]'));
          if (cells.length < 4) return null;
          const tds = cells.map((c) =>
            (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim()
          );
          return tds;
        })
        .filter(Boolean);
      if (valid.length < 5) return null;
      return valid.slice(0, 25);
    };

    return pickTable() ?? pickRole() ?? [];
  });

  return rows.map(normalizeRow).filter((r) => r.address).slice(0, 20);
}

async function extractViaFullText(page) {
  const text = await page.evaluate(() => document.body.innerText || '');
  if (!text || !text.includes('$')) return [];
  // ざっくり1行ずつ拾って5列相当を推定（最後の砦）
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length && out.length < 20; i++) {
    const L = lines[i];
    if (/^\d{2}$/.test(L) || /^\d{1,2}$/.test(L)) {
      // Rank とみなして周辺から $ を含む行などを寄せ集める
      const slice = lines.slice(i, i + 8);
      const addr = slice.find((s) => /[A-Za-z0-9]{4,}\.\.\.[A-Za-z0-9]{3,}/.test(s)) || '';
      const vol  = slice.find((s) => /\$\d/.test(s)) || '';
      const lvl  = slice.find((s) => /^LVL|^LV|^L\d/.test(s)) || '';
      const faf  = slice.find((s) => /FAF|,?\d{3}(?:,\d{3})*/.test(s)) || '';
      out.push(normalizeRow([L, addr, lvl, faf, vol]));
    }
  }
  return out;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 2200 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    locale: 'en-US',
  });

  // リクエストに no-cache を付ける（CDNキャッシュ回避）
  await context.route('**/*', async (route) => {
    const req = route.request();
    const headers = {
      ...req.headers(),
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    };
    route.continue({ headers });
  });

  const page = await context.newPage();

  // クエリストリングでキャッシュ無効化
  const url = `${BASE_URL}?nocache=${Date.now()}`;

  // リトライで DOM の行が出るまで待つ
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.mouse.move(200, 200);
  await page.mouse.wheel(0, 800);

  let rows = [];
  let lastErr = '';

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      // まず DOM 直接
      rows = await extractViaDOM(page);
      if (rows.length >= 5) break;

      // FullText（最終手段）
      const viaText = await extractViaFullText(page);
      if (viaText.length >= 5) {
        rows = viaText;
        break;
      }

      // まだダメなら少し待って再読み込み
      await sleep(1500);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    } catch (e) {
      lastErr = String(e);
      await sleep(1200);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
  }

  if (rows.length < 5) {
    console.warn('No rows captured (all fallbacks). Saving debug artifacts and exiting 0.');
    await saveDebug(page, `lastErr=${lastErr}`);
    await browser.close();
    // 失敗でワークフロー全体が止まらないよう成功終了
    process.exit(0);
  }

  // ここから先は、あなたの画像生成処理へ接続する。
  // 例として rows を JSON で残しつつ、簡易のテーブル画像を撮る（ページ内の表を狙う）。
  await fs.writeFile('leaderboard_rows.json', JSON.stringify(rows, null, 2), 'utf8');

  // 表領域を狙って撮影（CSS が変わっても最低限の画像は残す）
  try {
    const tableHandle = await page.$('table') || await page.$('[role="table"]') || await page.$('body');
    await tableHandle.screenshot({ path: 'leaderboard_snapshot.png' });
  } catch {
    await page.screenshot({ path: 'leaderboard_snapshot.png', fullPage: true });
  }

  await browser.close();
  console.log(`Captured ${rows.length} rows.`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(0); // ここも 0 にして毎日運用を止めない
});
