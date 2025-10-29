/* snapshot.js */
const { chromium } = require('playwright');

const TARGET_URL = 'https://www.flash.trade/leaderboard';
const OUT_FILE   = 'leaderboard_snapshot.png';
const TRY_MAX    = 6;
const TIMEOUT    = 60_000;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();

  // no-cache で最新を取りにいく
  await page.route('**/*', (route) => {
    route.continue({
      headers: {
        ...route.request().headers(),
        'cache-control': 'no-cache, no-store, must-revalidate',
        pragma: 'no-cache',
        expires: '0'
      }
    });
  });

  // ===== JSON スニッフィング =====
  let capturedJsons = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;                  // JSON だけ見る
      const url = resp.url();
      // ランキング/ボリュームっぽいURLだけ拾う（ゆるいフィルタ）
      if (!/leader|board|rank|volume|wallet|address|faf/i.test(url)) return;

      const json = await resp.json().catch(() => null);
      if (json) capturedJsons.push({ url, json });
    } catch {}
  });

  // ===== ページへ（キャッシュバスター付き） =====
  for (let i = 0; i < TRY_MAX; i++) {
    await page.goto(`${TARGET_URL}?t=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT
    });

    // 初期スクロールで仮想化解除を誘発
    await page.waitForTimeout(800);
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, -1000);
    await page.waitForTimeout(400);

    // ネットワーク落ち着くまで待機
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
    // 何も JSON が拾えてなければリロード
    if (capturedJsons.length) break;
  }

  // ===== JSON → レコード配列に正規化 =====
  function normalizeFromJsonPayload(payload) {
    // 代表的なコンテナを抽出
    let arr = [];
    const cands = [
      payload,
      payload?.data,
      payload?.rows,
      payload?.result,
      payload?.leaderboard,
      payload?.items,
    ].filter(Boolean);

    for (const c of cands) {
      if (Array.isArray(c)) { arr = c; break; }
    }
    if (!arr.length) return [];

    // レコード正規化（キーが何で来ても吸収）
    const toVolStr = (v) => {
      if (v == null || v === '') return '';
      if (typeof v === 'string') {
        if (/^\$/.test(v)) return v;
        const num = Number(v.replace(/,/g, ''));
        return isFinite(num) ? `$${num.toLocaleString('en-US')}` : '';
      }
      if (typeof v === 'number') return `$${v.toLocaleString('en-US')}`;
      return '';
    };

    const out = arr.map((it, idx) => {
      // ありがちキー候補
      const addr = it.address || it.wallet || it.account || it.owner || it.addr || '';
      const level = it.level ?? it.tier ?? it.rankLevel ?? '';
      const faf   = it.faf ?? it.FAF ?? it.staked ?? it.stake ?? '';
      const volRaw =
        it.volume ?? it.totalVolume ?? it.tradedVolume ??
        it.volumeUsd ?? it.usdVolume ?? it.value ?? it.amount;

      const volume = toVolStr(volRaw);
      return {
        rank: String(idx + 1),
        address: String(addr || ''),
        level: String(level ?? ''),
        faf: String(faf ?? ''),
        volume
      };
    }).filter(r => r.address && r.volume);

    return out.slice(0, 20);
  }

  let top20 = [];
  for (const { url, json } of capturedJsons) {
    const normalized = normalizeFromJsonPayload(json);
    if (normalized.length >= 10) { // 手応えありの JSON を優先採用
      top20 = normalized;
      break;
    }
    // 弱い場合も候補としてマージ
    if (!top20.length && normalized.length) top20 = normalized;
  }

  // ===== 取れなければ DOM フォールバック =====
  if (!top20.length) {
    const rows = await page.$$eval('table tbody tr', trs =>
      trs.slice(0, 30).map(tr => Array.from(tr.querySelectorAll('td'))
        .map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()))
    ).catch(() => []);

    let via = rows;
    if (!via?.length) {
      via = await page.$$eval('[role="row"]', rows =>
        rows.map(row =>
          Array.from(row.querySelectorAll('[role="cell"]'))
            .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
        ).filter(c => c.length >= 4).slice(0, 30)
      ).catch(() => []);
    }

    const num = (s) => (s || '').replace(/[^\d.,\-]/g, '');
    const norm = (cols, i) => {
      const g = (k) => (cols[k] ?? '').toString();
      let rank = g(0).replace(/[^\d]/g, '') || String(i + 1);
      let address = g(1);
      let level = num(g(2));
      let faf = num(g(3));
      let volume = g(4);
      if (!/\$\d/.test(volume)) {
        const f = cols.find((s) => /\$\d/.test(String(s)));
        if (f) volume = f;
      }
      return { rank, address, level, faf, volume };
    };

    top20 = (via || []).map((r, i) => norm(r, i)).filter(r => r.address && r.volume).slice(0, 20);
  }

  if (!top20.length) {
    console.error('No rows captured (JSON & DOM both failed).');
    await browser.close();
    process.exit(1);
  }

  // ===== 画像レンダリング（重なり無しで綺麗に） =====
  const utcTs = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const medal = (n) => (n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : '');
  const esc = (s='') => s.replace(/[&<>"']/g,(c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const total = top20.reduce((sum, r) => {
    const m = String(r.volume).match(/\$([\d,.,]+)/);
    if (!m) return sum;
    const n = Number(m[1].replace(/,/g, ''));
    return sum + (isFinite(n) ? n : 0);
  }, 0);
  const totalFmt = `$${total.toLocaleString('en-US')}`;

  const rowsHtml = top20.map(r => `
    <tr>
      <td class="rank">${medal(+r.rank)} <span>&lt; ${String(r.rank).padStart(2,'0')} &gt;</span></td>
      <td class="addr">${esc(r.address)}</td>
      <td class="level">${esc(r.level || '')}</td>
      <td class="faf">${esc(r.faf || '')}</td>
      <td class="vol">${esc(r.volume || '')}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>
  :root{--bg:#0c1117;--panel:#0f1621;--row:#0d131c;--text:#dbe4ee;--muted:#95a1b3;--accent:#22d3ee;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{width:1040px;margin:26px auto;padding:20px 24px;background:var(--panel);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
  h1{font-size:28px;margin:0 0 8px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .total{font-size:18px;margin-bottom:14px}
  .total b{color:var(--accent)}
  table{width:100%;border-collapse:separate;border-spacing:0 8px;font-size:14px}
  thead th{color:#9fb1c6;font-weight:600;text-align:left;padding:8px 14px}
  tbody tr{background:var(--row)}
  tbody td{padding:12px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rank{width:180px;color:#cbd7e6}
  .rank span{opacity:.9}
  .addr{max-width:430px;font-family:ui-monospace,Menlo,Consolas,monospace}
  .level{width:110px;text-align:right;color:#cbd7e6}
  .faf{width:120px;text-align:right;color:#cbd7e6}
  .vol{width:180px;text-align:right;font-weight:700}
</style></head>
<body>
  <div class="wrap">
    <h1>⚡ FlashTrade Leaderboard — Top 20</h1>
    <div class="sub">Snapshot (UTC): ${utcTs}</div>
    <div class="total">Total Volume Traded (Today): <b>${totalFmt}</b> (– vs Yesterday)</div>
    <table>
      <thead><tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</body></html>`;

  const painter = await context.newPage();
  await painter.setViewportSize({ width: 1100, height: 1900 });
  await painter.setContent(html, { waitUntil: 'load' });
  await painter.screenshot({ path: OUT_FILE, fullPage: true });

  await browser.close();
  console.log(`Saved: ${OUT_FILE}`);
})();
