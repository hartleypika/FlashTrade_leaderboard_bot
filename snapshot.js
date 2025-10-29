// snapshot.js
// FlashTrade Leaderboard → Top20 を確実に取得するための堅牢版
// - Playwright Extra + Stealth
// - 強制 no-cache ＆ キャッシュバスター
// - CSR / 仮想化テーブルの描画完了を waitForFunction で厳密待機
// - <table> と ARIAグリッド [role="row"] の両方に対応
// - 失敗時は数回リロードして自動リトライ

const { chromium } = require('playwright-extra');
const stealth = require('playwright-extra-plugin-stealth')();
chromium.use(stealth);

const SNAPSHOT_URL_BASE = 'https://www.flash.trade/leaderboard';
const TIMEOUT_MS = 60_000;       // 全体タイムアウト
const TRY_MAX = 5;               // リトライ回数
const VIEWPORT = { width: 1440, height: 2200 };

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  const page = await context.newPage();

  // webdriver を偽装
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // すべてのリクエストに no-cache ヘッダを付与
  await page.route('**/*', async (route) => {
    const req = route.request();
    const headers = {
      ...req.headers(),
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      expires: '0'
    };
    await route.continue({ headers });
  });

  // ===== 主要ロジック =====

  // キャッシュバスター付き URL
  const urlWithTs = () => `${SNAPSHOT_URL_BASE}?ts=${Date.now()}`;

  // ページが実際に最新で埋まるまでしつこく待つ
  async function waitUntilLeaderboardReady(p) {
    // 1) DOM 基本が来るまで
    await p.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS });

    // 2) 初動で少しスクロール（仮想化対策）
    await p.waitForTimeout(800);
    await p.mouse.move(200, 200);
    await p.mouse.wheel(0, 800);
    await p.waitForTimeout(400);
    await p.mouse.wheel(0, -800);
    await p.waitForTimeout(400);

    // 3) 「行が10行以上」「$を含むvolume列が複数」になるまで待機
    await p.waitForFunction(
      () => {
        const pickText = (el) =>
          (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

        // table tbody tr パス
        let rows = Array.from(document.querySelectorAll('table tbody tr'))
          .map((tr) => Array.from(tr.querySelectorAll('td')).map(pickText))
          .filter((cells) => cells.length >= 4);

        // 足りなければ ARIA グリッド
        if (rows.length < 8) {
          rows = Array.from(document.querySelectorAll('[role="row"]'))
            .map((row) =>
              Array.from(row.querySelectorAll('[role="cell"]')).map(pickText)
            )
            .filter((cells) => cells.length >= 4);
        }

        // $ を含むセルの数（Volume などが埋まっているかの指標）
        const dollarCells = rows.flat().filter((s) => /\$\d/.test(s)).length;

        return rows.length >= 10 && dollarCells >= 5;
      },
      { timeout: TIMEOUT_MS }
    );
  }

  // DOM から上位20を吸い出す
  async function extractTop20(p) {
    return await p.evaluate(() => {
      const pick = (el) =>
        (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

      const collect = () => {
        // 優先: <table>
        let rows = Array.from(document.querySelectorAll('table tbody tr')).map(
          (tr) => Array.from(tr.querySelectorAll('td')).map(pick)
        );

        // サブ: ARIA
        if (rows.length < 5) {
          rows = Array.from(document.querySelectorAll('[role="row"]')).map(
            (row) =>
              Array.from(row.querySelectorAll('[role="cell"]')).map(pick)
          );
        }

        // ノイズ除去
        rows = rows.filter((cells) => cells.length >= 4);

        const toNum = (s) => (s || '').replace(/[^\d.,\-]/g, '');

        const normalize = (cells) => {
          // 想定: [rank, address, level, faf, volume] だがズレることがある
          let rank = (cells[0] || '').replace(/[^\d]/g, '');
          let address = cells[1] || '';
          let level = toNum(cells[2] || '');
          let faf = toNum(cells[3] || '');
          // volume は $ を含むどれか
          let volume =
            cells.find((c) => /\$\d/.test(c)) || cells[4] || '';

          return { rank, address, level, faf, volume };
        };

        return rows.slice(0, 20).map(normalize);
      };

      return collect();
    });
  }

  // メイン: リトライしながら最新を取りに行く
  let data = [];
  for (let i = 1; i <= TRY_MAX; i++) {
    try {
      await page.goto(urlWithTs(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      await waitUntilLeaderboardReady(page);

      // 念のため再スクロール（仮想化の取りこぼし抑制）
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(300);

      data = await extractTop20(page);

      // volume に $ が十分含まれていれば成功とみなす
      const ok = data.filter((r) => /\$\d/.test(r.volume || '')).length >= 10;
      if (ok) break;

      // 不十分 → 再試行
      await page.waitForTimeout(1200);
    } catch (e) {
      // 失敗 → リロードして再試行
      await page.waitForTimeout(1200);
    }
  }

  if (!data || data.length === 0) {
    console.error('No rows captured.');
    await browser.close();
    process.exit(1);
  }

  // ここで JSON を出力（あなたの描画コードにパイプする前段）
  console.log(JSON.stringify(data, null, 2));

  await browser.close();
})();
