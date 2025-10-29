// --- Stealth 化した Playwright 起動 ---
const { chromium } = require('playwright-extra');
const stealth = require('playwright-extra-plugin-stealth')();
chromium.use(stealth);

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
    viewport: { width: 1366, height: 2000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  const page = await context.newPage();

  // webdriver = false に偽装
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // キャッシュ殺し
  await page.route('**/*', async (route) => {
    const headers = {
      ...route.request().headers(),
      'cache-control': 'no-cache',
      pragma: 'no-cache'
    };
    await route.continue({ headers });
  });

  // ====== ここから本処理 ======
  const URL = 'https://www.flash.trade/leaderboard';
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 追加の“人間ぽさ”
  await page.waitForTimeout(1000);
  await page.mouse.move(200, 200);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(500);

  // CSRで表が埋まるまで数回リトライして拾う
  let rows = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      // テーブルの候補: table > tbody > tr か、role="row"
      rows = await page.$$eval('table tbody tr', (trs) =>
        trs.slice(0, 20).map((tr, i) => {
          const tds = Array.from(tr.querySelectorAll('td')).map((td) =>
            (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
          );
          return { i, tds };
        })
      );

      // なければ ARIA で探す
      if (!rows || rows.length < 5) {
        rows = await page.$$eval('[role="row"]', (divs) =>
          divs
            .map((row, i) => {
              const cells = Array.from(row.querySelectorAll('[role="cell"]'));
              const texts = cells
                .map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
              return { i, tds: texts };
            })
            .slice(0, 20)
        );
      }

      // まだ少ない → 少し待って再試行
      if (!rows || rows.length < 5) {
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        continue;
      }

      // 正常取得できたら脱出
      break;
    } catch (e) {
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  }

  if (!rows || rows.length < 5) {
    console.error('No rows captured.');
    await browser.close();
    process.exit(1);
  }

  // 行データの正規化（列の並びが違っても吸収）
  const normalize = (tds) => {
    // だいたい: [rank, address, level, faf, volume] の想定
    // カラム数が4や5で揺れる場合もあるのでざっくり寄せる
    const safe = (idx) => (tds[idx] ?? '').toString();

    let rank = safe(0).replace(/[^\d]/g, '');
    let address = safe(1);
    let level = safe(2);
    let faf = safe(3);
    let volume = safe(4);

    // もし volume が空で、末尾に $ がある列が他にあれば拾う
    if (!/\$\d/.test(volume)) {
      const found = tds.find((s) => /\$\d/.test(s));
      if (found) volume = found;
    }

    // 数値フォーマット軽く整える
    const n = (s) => s.replace(/[^\d.,\-]/g, '');
    return {
      rank: rank || '',
      address: address || '',
      level: n(level),
      faf: n(faf),
      volume: volume || ''
    };
  };

  const top20 = rows
    .map((r) => normalize(r.tds || []))
    .filter((r) => r.address)
    .slice(0, 20);

  if (!top20.length) {
    console.error('Parsed rows are empty.');
    await browser.close();
    process.exit(1);
  }

  // ここで top20 を使って、あなたの画像生成関数に渡してください
  // 例：await renderPng(top20)
  console.log(JSON.stringify(top20, null, 2)); // ← 動作確認用
  // ← ここで rows を使って画像を描画する処理に繋げる（既存の描画コードでOK）

  await browser.close();
})();
