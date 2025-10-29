// snapshot.js — robust DOM scraper + renderer (v3)
const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const URL = "https://www.flash.trade/leaderboard";

const toUsd = (n) =>
  "$" + Math.round(Math.max(0, Number(n || 0))).toLocaleString("en-US");
const num = (v) => {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  const m = String(v).match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : 0;
};
const medal = (r) => (r === 1 ? "🥇 " : r === 2 ? "🥈 " : r === 3 ? "🥉 " : "");
const tsUTC = () => new Date().toISOString().slice(0,16).replace("T"," ");

function fixed(s, n){ s=String(s??""); return s.length<=n?s:s.slice(0,n-1)+"…"; }

(async () => {
  await fs.mkdir("data", { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 2500 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "UTC",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36",
  });
  const page = await context.newPage();

  // ---- ページ読み込み（人間っぽい待機＋再試行）----
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${URL}?_=${Date.now()}_${attempt}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
    // 画面にアドレスが十分出るまで待つ（≒描画完了）
    const ok = await page.waitForFunction(() => {
      const t = document.body.innerText || "";
      const m = t.match(/[1-9A-HJ-NP-Za-km-z]{25,}/g);
      return m && m.length >= 10;
    }, { timeout: 20000 }).catch(()=>false);
    if (ok) break;
  }

  // ---- “Total Volume Traded (Today)” をページ上部から抽出 ----
  let totalTodayStr = "—";
  try {
    const allText = await page.evaluate(() => document.body.innerText);
    // 例) "Total Volume Traded (Today):  $167,930,880"
    const m = allText.match(/Total\s+Volume\s+Traded\s*\(Today\)\s*:\s*\$[\d,]+/i);
    if (m) {
      const m2 = m[0].match(/\$[\d,]+/);
      if (m2) totalTodayStr = m2[0];
    }
  } catch {}

  // ---- テーブル行を「DOM の見た目」から強靭に抽出 ----
  const rows = await page.evaluate(() => {
    // 1) まず画面に並ぶ「行」候補をフラットに集める
    //    Flash のLBは table / [role=row] / div列 など時期で変わるため広めに取る
    const candidates = [];
    const qAll = (sel) => Array.from(document.querySelectorAll(sel));
    // 表に見える行（rank が "01"〜"20" のような2桁が先頭にある）
    qAll("*").forEach((el) => {
      const txt = (el.innerText || "").trim();
      // 行らしい＆ほどよい長さ
      if (txt && txt.length < 400 && /^\d{1,2}\s/.test(txt)) {
        candidates.push(txt);
      }
    });

    // 2) そのままだと他の行も混じるので、アドレスや数値の出現でフィルタ
    const looksLikeAddr = (s) => /[1-9A-HJ-NP-Za-km-z]{25,}/.test(s);
    const cleaned = candidates
      .map((t) => t.replace(/\u00A0/g, " ").replace(/\s{2,}/g, " ").trim())
      .filter((t) => looksLikeAddr(t) && /\$\d|,\d{3}/.test(t)); // 金額/数値も含む

    // 3) さらに rank 昇順でユニーク化し、上位20だけ残す
    const seen = new Set();
    const lines = [];
    cleaned.forEach((t) => {
      const m = t.match(/^(\d{1,2})\s/);
      if (!m) return;
      const r = Number(m[1]);
      if (r>=1 && r<=50 && !seen.has(r)) { seen.add(r); lines.push({rank:r, line:t}); }
    });
    lines.sort((a,b)=>a.rank-b.rank);
    return lines.slice(0, 20);
  });

  // rows が空の場合に備えてフルページスクショを保存（デバッグ用）
  if (!rows.length) {
    await page.screenshot({ path: "raw_page.png", fullPage: true }).catch(()=>{});
  }

  // ---- 1行のテキストから各列を復元（正規表現ベース）----
  const parsed = rows.map(({ rank, line }) => {
    // アドレス
    const addrM = line.match(/[1-9A-HJ-NP-Za-km-z]{25,}/);
    const address = addrM ? addrM[0] : "";

    // Level と FAF（例: "LVL 6 6,577,330 FAF staked"）
    const lvlM = line.match(/LVL\s*\d+/i);
    const level = lvlM ? lvlM[0].toUpperCase() : "";

    const fafM = line.match(/([\d,]+)\s*FAF\s*staked/i);
    const faf = fafM ? fafM[1] : "";

    // Voltage Points（金額表示じゃない=素の数値。画面では右端近く）
    // 例: "24,356,207" など。行の末尾付近に複数の数があっても一番大きい値を採用
    const nums = (line.match(/[\d,]{4,}/g) || []).map((x) => Number(x.replace(/,/g,"")));
    const vpNum = nums.length ? Math.max(...nums) : 0;

    return {
      rank,
      address,
      level,
      faf,
      volumeNum: vpNum,         // VP を “Volume” 欄として表示
      volume: toUsd(vpNum),
    };
  }).filter(r => r.address);

  // ---- 前日との差分を付与（なければ null）----
  let y = [];
  try { y = JSON.parse(await fs.readFile("data/last.json","utf8")); } catch {}
  const byAddr = new Map((y||[]).map(r => [r.address, r]));
  const withDiff = parsed.map((r, idx) => {
    const prev = byAddr.get(r.address);
    const dr = prev ? (idx+1) - (prev.rank||0) : null;
    const dv = prev ? r.volumeNum - (prev.volumeNum||0) : null;
    return {...r, deltaRank: dr, deltaVP: dv};
  });

  // 保存（次回の差分計算用）
  if (withDiff.length) {
    await fs.mkdir("data",{recursive:true});
    await fs.writeFile("data/last.json",
      JSON.stringify(withDiff.map(({deltaRank,deltaVP, ...rest})=>rest), null, 2));
  }

  // ---- 画像を描画（列幅固定で重なり防止）----
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#89a1b1;--text:#e6f0f7}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,Segoe UI,Roboto,Arial}
    .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline}
    .title{font-size:24px;font-weight:700}
    .total{margin-left:auto;font-weight:700}
    .total small{color:var(--muted);font-weight:500;margin-right:8px}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{background:#0e151b;color:var(--muted);font-weight:600;text-align:left}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:110px}
    th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:120px}
    th:nth-child(4),td:nth-child(4){width:140px}
    th:nth-child(5),td:nth-child(5){width:170px;text-align:right}
    th:nth-child(6),td:nth-child(6){width:150px;text-align:right}
    th:nth-child(7),td:nth-child(7){width:90px;text-align:right}
  </style></head><body>
  <div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total"><small>Total Volume Traded (Today):</small>${totalTodayStr}</div>
    </div>
    <table>
      <thead><tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Voltage Points</th><th>ΔVP</th><th>ΔRank</th></tr></thead>
      <tbody>
        ${withDiff.length ? withDiff.map(r=>{
          const dVP = r.deltaVP==null ? "–" : `${r.deltaVP>=0?"+":"-"}${toUsd(Math.abs(r.deltaVP))}`;
          const dR  = r.deltaRank==null ? "–" : (r.deltaRank<0?`▲${Math.abs(r.deltaRank)}`:r.deltaRank>0?`▼${r.deltaRank}`:"＝");
          const dRC = r.deltaRank==null ? "#89a1b1" : r.deltaRank<0 ? "#2ecc71" : r.deltaRank>0 ? "#e74c3c" : "#89a1b1";
          return `<tr>
            <td>${medal(r.rank)}${String(r.rank).padStart(2,"0")}</td>
            <td title="${r.address}">${fixed(r.address,48)}</td>
            <td title="${r.level}">${fixed(r.level,12)}</td>
            <td title="${r.faf}">${fixed(r.faf,14)}</td>
            <td style="text-align:right">${r.volume}</td>
            <td style="text-align:right">${dVP}</td>
            <td style="text-align:right;color:${dRC}">${dR}</td>
          </tr>`;
        }).join("") : new Array(20).fill(0).map((_,i)=>`<tr>
            <td>${String(i+1).padStart(2,"0")}</td><td></td><td></td><td></td>
            <td style="text-align:right">–</td><td style="text-align:right">–</td><td style="text-align:right">–</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <div style="padding:10px 14px;color:#89a1b1;font-size:12px">Snapshot (UTC) ${tsUTC()} ・ Source: flash.trade/leaderboard</div>
  </div></body></html>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: "load" });
  await card.screenshot({ path: "leaderboard_card.png", fullPage: true });

  // 元ページのフルスクショも（確認用）
  await page.screenshot({ path: "raw_page.png", fullPage: true }).catch(()=>{});

  await browser.close();
  console.log("✅ Done: leaderboard_card.png / raw_page.png / data/last.json");
})();
