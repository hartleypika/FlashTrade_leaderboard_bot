/* snapshot.js (v2: deep fallbacks + debug artifacts) */
const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'https://www.flash.trade/leaderboard';
const OUT_FILE   = 'leaderboard_snapshot.png';
const DEBUG_HTML = 'debug_page.html';
const DEBUG_PNG  = 'debug_page.png';
const TRY_MAX    = 6;
const TIMEOUT    = 60_000;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 2000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();

  // no-cache で最新
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

  // --- JSON スニッフィング ---
  const capturedJsons = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      const url = resp.url();
      // ランキングやボリュームっぽいURLのみ
      if (!/leader|board|rank|volume|wallet|address|faf|trader|stats/i.test(url)) return;
      const json = await resp.json().catch(() => null);
      if (json) capturedJsons.push({ url, json });
    } catch {}
  });

  // --- 表示まで誘発 ---
  for (let i = 0; i < TRY_MAX; i++) {
    await page.goto(`${TARGET_URL}?t=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT
    });

    // 仮想化解除を誘発
    await page.waitForTimeout(800);
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(500);

    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
    if (capturedJsons.length) break;
  }

  // ===== 正規化関数 =====
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

  const normFromJson = (payload) => {
    let arr = [];
    const cands = [
      payload,
      payload?.data,
      payload?.rows,
      payload?.result,
      payload?.leaderboard,
      payload?.items,
      payload?.list
    ].filter(Boolean);

    for (const c of cands) {
      if (Array.isArray(c)) { arr = c; break; }
    }
    if (!arr.length) return [];

    const out = arr.map((it, idx) => {
      const addr = it.address || it.wallet || it.account || it.owner || it.addr || it.trader || '';
      const level = it.level ?? it.tier ?? it.rankLevel ?? it.userLevel ?? '';
      const faf   = it.faf ?? it.FAF ?? it.staked ?? it.stake ?? it.deposited ?? '';
      const volRaw =
        it.volume ?? it.totalVolume ?? it.tradedVolume ??
        it.volumeUsd ?? it.usdVolume ?? it.value ?? it.amount ?? it.pnl;
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
  };

  // ===== 1) JSON から試す =====
  let top20 = [];
  for (const { url, json } of capturedJsons) {
    const normalized = normFromJson(json);
    if (normalized.length >= 10) { top20 = normalized; break; }
    if (!top20.length && normalized.length) top20 = normalized;
  }

  // ===== 2) セマンティック DOM パース =====
  if (!top20.length) {
    const rows1 = await page.$$eval('table tbody tr', trs =>
      trs.slice(0, 40).map(tr => Array.from(tr.querySelectorAll('td'))
        .map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()))
    ).catch(() => []);

    let via = rows1;

    if (!via?.length) {
      // role="row" でセルを取得
      const r2 = await page.$$eval('[role="row"]', rows =>
        rows.map(row =>
          Array.from(row.querySelectorAll('[role="cell"],[data-column],[class*="cell"]'))
            .map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim())
        ).filter(c => c.length >= 3).slice(0, 60)
      ).catch(() => []);
      via = r2;
    }

    if (!via?.length) {
      // 「$ を含むセル」を拾って近傍のアドレスを探す
      const r3 = await page.$$eval('body *', nodes => {
        const isAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{20,45}$/.test(s);
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const all = nodes
          .map(n => clean(n.innerText || n.textContent || ''))
          .map((t, i) => ({ i, t }))
          .filter(x => x.t && (/\$\d/.test(x.t) || isAddr(x.t)));

        const rows = [];
        for (let i = 0; i < all.length; i++) {
          const a = all[i];
          if (!/\$\d/.test(a.t)) continue;
          // 前方20件くらいでアドレスを探す
          const near = [];
          for (let j = Math.max(0, i - 20); j < i + 1; j++) near.push(all[j].t);
          const addr = near.reverse().find(s => isAddr(s)) || '';
          if (!addr) continue;
          rows.push([String(rows.length + 1), addr, '', '', a.t]);
          if (rows.length >= 40) break;
        }
        return rows;
      }).catch(() => []);
      via = r3;
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

    const tmp = (via || []).map((r, i) => norm(r, i)).filter(r => r.address && r.volume);
    if (tmp.length) top20 = tmp.slice(0, 20);
  }

  // ===== 3) テキスト全文ルーズパース =====
  if (!top20.length) {
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const lines = bodyText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 5000);

    const addrRe = /^[1-9A-HJ-NP-Za-km-z]{20,45}$/;
    const volRe  = /^\$[0-9][\d,]*(\.\d+)?$/;

    const rowsLoose = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (!addrRe.test(L)) continue;
      // 近傍 8 行以内に $ を探す
      let vol = '';
      for (let k = i; k < Math.min(lines.length, i + 8); k++) {
        if (volRe.test(lines[k])) { vol = lines[k]; break; }
      }
      if (!vol) continue;
      rowsLoose.push({
        rank: String(rowsLoose.length + 1),
        address: L,
        level: '',
        faf: '',
        volume: vol
      });
      if (rowsLoose.length >= 20) break;
    }
    if (rowsLoose.length) top20 = rowsLoose;
  }

  // ===== 失敗 → デバッグ成果物を残して終了 =====
  if (!top20.length) {
    try { fs.writeFileSync(DEBUG_HTML, await page.content(), 'utf8'); } catch {}
    try { await page.screenshot({ path: DEBUG_PNG, fullPage: true }); } catch {}
    console.error('No rows captured (JSON & DOM & Text all failed). Debug artifacts saved.');
    await browser.close();
    process.exit(1);
  }

  // ===== 集計 & レンダリング =====
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
