// snapshot.js — Playwright screenshot → Tesseract OCR → parse → card image
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const URL = 'https://www.flash.trade/leaderboard';

// ---------- utilities ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toUSD = (n) => '$' + Math.round(Math.max(0, Number(n||0))).toLocaleString('en-US');
const tsUTC = () => new Date().toISOString().slice(0,16).replace('T',' ');

const medal = (r) => r===1?'🥇 ':r===2?'🥈 ':r===3?'🥉 ':'';

function num(s) {
  if (s == null) return 0;
  const m = String(s).match(/[\d,]+(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : 0;
}

// 文字を安全短縮して表セルで重ならないように
function clip(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  return s.slice(0, n-1) + '…';
}

// ---------- OCR parse (robust) ----------
/**
 * 期待する行の情報:
 *   rank 01..20（OCRでは "< 01 >" など混入しがち）
 *   アドレスは "3BwpZf...QA2m" のように "…"(三点リーダ) または "..." を含む
 *   "LVL6" のようなレベル表記
 *   "X,XXX,XXX FAF staked" のようなFAF数
 *   最後に "24,356,207" のようなVP値
 */
function parseOCR(ocrText) {
  const lines = ocrText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 余計なUI文言を除去
  const drop = [
    'Voltage Points Leaderboard', 'Fees', 'Visit Profile', 'CURRENT',
    'Back to Previous Page', 'Epoch', 'USDC', 'View Epoch',
    'CURRENT EPOCH PROGRESS', 'Level (according to FAF staked)',
    'Action', 'Voltage Points', 'Rank', 'Address', 'Level', 'FAF', 'VP Today'
  ];
  const cleaned = lines.filter(s => !drop.some(d => s.includes(d)));

  // ラインを rankごとに束ねる（ランクは先頭/角括弧/矢印混入に耐性）
  const rankLineIdx = [];
  cleaned.forEach((s,i)=>{
    if (/^(?:<\s*)?0?(?:[1-9]|1\d|20)(?:\s*>|\b)/.test(s)) rankLineIdx.push(i);
  });

  // ランク表記が見つからない場合、LVLでセグメント化（より緩い戦略）
  const segments = [];
  if (rankLineIdx.length >= 5) {
    for (let i=0;i<rankLineIdx.length;i++){
      const start = rankLineIdx[i];
      const end = rankLineIdx[i+1] ?? cleaned.length;
      segments.push(cleaned.slice(start, end));
    }
  } else {
    // LVL を基準に周辺を拾う
    const lvlIdx = [];
    cleaned.forEach((s,i)=>{ if (/LVL\d+/.test(s)) lvlIdx.push(i); });
    for (let i=0;i<lvlIdx.length;i++){
      const start = Math.max(0, lvlIdx[i]-1);
      const end = lvlIdx[i+1] ?? Math.min(cleaned.length, start+4);
      segments.push(cleaned.slice(start, end));
    }
  }

  // セグメントから1行データを作る
  const rows = [];
  for (const seg of segments) {
    const blob = seg.join(' ');
    // rank
    const rM = blob.match(/(?:^|\s)(0?(?:[1-9]|1\d|20))(?:\s|$|>)/);
    const rank = rM ? Number(rM[1]) : (rows.length+1);
    if (rank < 1 || rank > 20) continue;

    // address（"xxxx...xxxx" / "xxxx…xxxx"）
    const aM = blob.match(/[A-Za-z0-9]{2,}\s?(?:\.{3}|…)\s?[A-Za-z0-9]{2,}/);
    const address = aM ? aM[0].replace(/\s+/g,'') : '';

    // level
    const lM = blob.match(/LVL\s?\d+/i);
    const level = lM ? lM[0].replace(/\s+/g,'').toUpperCase() : '';

    // FAF
    // 例: "6,577,330 FAF staked" → 数値のみ抽出
    const fM = blob.match(/([\d,]{1,3}(?:,\d{3})+)\s*FAF/i);
    const faf = fM ? fM[1] : '';

    // VP (最後の大きめの数字を拾う)
    const nums = [...blob.matchAll(/[\d,]{1,3}(?:,\d{3})+/g)].map(m=>m[0]);
    let vp = '';
    if (nums.length) {
      vp = nums[nums.length-1]; // ライン末尾に来ることが多い
      // ただし FAF が最後に来ている場合は一つ手前
      if (vp === faf && nums.length>=2) vp = nums[nums.length-2];
    }

    // 最低限 address or vp がないと行として弱いのでスキップ
    if (!address && !vp) continue;

    rows.push({
      rank, address, level, faf, vp, vpNum: num(vp)
    });
  }

  // rank重複対策：最小rankから順にソートして1〜20に詰め直し
  rows.sort((a,b)=>a.rank-b.rank || b.vpNum-a.vpNum);
  const top = rows.slice(0,20).map((r,i)=>({ ...r, rank: i+1 }));

  return top;
}

// ---------- render card ----------
async function renderCard(browser, rows) {
  const total = rows.reduce((a,b)=>a + (b.vpNum||0), 0);
  const html = `
  <html><head><meta charset="utf-8"><style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7;}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px}
    .title{font-size:26px;font-weight:800;letter-spacing:.2px}
    .total{margin-left:auto;font-weight:700}
    .total small{color:var(--muted);font-weight:500;margin-right:8px}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:120px}
    th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:110px}
    th:nth-child(4),td:nth-child(4){width:160px}
    th:nth-child(5),td:nth-child(5){width:170px;text-align:right}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style></head>
  <body><div class="wrap">
    <div class="head">
      <div class="title">FlashTrade VP Leaderboard — Top 20</div>
      <div class="total"><small>Total VP (Today):</small>${toUSD(total)}</div>
    </div>
    <table>
      <thead><tr>
        <th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>VP</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${medal(r.rank)}${String(r.rank).padStart(2,'0')}</td>
            <td title="${r.address}">${clip(r.address, 46)}</td>
            <td>${clip(r.level, 10)}</td>
            <td>${clip(r.faf, 14)}</td>
            <td style="text-align:right">${r.vp || '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${tsUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 }});
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: 'leaderboard_card.png', fullPage: true });
  await page.close();
}

// ---------- main ----------
(async () => {
  await fsp.mkdir('debug', { recursive: true });
  await fsp.mkdir('data', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 2400 },
    deviceScaleFactor: 2,
    timezoneId: 'UTC',
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36'
  });

  // ページへ
  await page.goto(`${URL}?_=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 読み込み＋スクロール（仮想リスト対策）
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  for (let i=0;i<8;i++){ await page.mouse.wheel(0, 800); await sleep(400); }
  for (let i=0;i<4;i++){ await page.mouse.wheel(0,-800); await sleep(250); }

  // 画面全体の証跡スクショ
  await page.screenshot({ path: 'raw_page.png', fullPage: true });

  // ---- OCR ----
  // Tesseractに優しめの設定
  const tesseractArgs = [
    'raw_page.png', 'ocr', '-l', 'eng',
    '--psm', '6', '--oem', '1',
    '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$,.<>:;_-/()[]{}… '
  ];
  try {
    execFileSync('tesseract', tesseractArgs, { stdio: 'inherit' });
  } catch (e) {
    console.error('Tesseract failed', e);
  }

  let ocrText = '';
  try { ocrText = await fsp.readFile('ocr.txt', 'utf8'); } catch {}
  if (!ocrText) {
    // フォールバック: PlaywrightからinnerText（取り出せれば）
    try { ocrText = await page.evaluate(()=>document.body.innerText); } catch {}
  }
  await fsp.writeFile(path.join('debug', 'ocr_dump.txt'), ocrText || '(empty)');

  // ---- parse ----
  let rows = [];
  if (ocrText) rows = parseOCR(ocrText);

  // 足りない箇所はプレースホルダで埋めて 20 行に
  if (rows.length < 20) {
    const missing = 20 - rows.length;
    for (let i=0;i<missing;i++) {
      rows.push({
        rank: rows.length+1, address: '', level: '', faf: '', vp: '—', vpNum: 0
      });
    }
  } else if (rows.length > 20) {
    rows = rows.slice(0,20);
  }

  // カード描画
  await renderCard(browser, rows);

  await browser.close();
  console.log('✅ Done: leaderboard_card.png / raw_page.png / ocr.txt / debug/ocr_dump.txt');
})();