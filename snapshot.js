// snapshot_hybrid.js
const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const URL = "https://www.flash.trade/leaderboard";

// -------------- helpers --------------
const medal = (r) => (r === 1 ? "🥇 " : r === 2 ? "🥈 " : r === 3 ? "🥉 " : "");
const toUsd = (n) =>
  "$" + Math.round(Math.max(0, Number(n || 0))).toLocaleString("en-US");
const num = (v) => {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  const m = String(v).match(/[\d,]+(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : 0;
};
const tsUTC = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const looksLikeAddress = (s) => /[1-9A-HJ-NP-Za-km-z]{24,}/.test(String(s || ""));

function fixed(str, max) {
  str = String(str ?? "");
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

// -------------- main --------------
(async () => {
  await fs.mkdir("debug", { recursive: true });
  await fs.mkdir("data", { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 2200 },
    deviceScaleFactor: 2,
    timezoneId: "UTC",
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36",
  });

  // 多少の bot 回避
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });

  const page = await context.newPage();

  // ---- ナビゲーション & 強化待機 ----
  let ok = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${URL}?_=${Date.now()}_${attempt}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch {}

    // 人間ぽさ & レイジーロード促進
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(500);
    }
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -900);
      await page.waitForTimeout(300);
    }

    // Visit Profile が 20 個以上出るまで待つ（このサイト固有の安定シグナル）
    const ready = await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll("a,button"))
            .filter((el) => /visit profile/i.test(el.textContent || "")).length >= 20,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (ready) { ok = true; break; }

    await page.waitForTimeout(1500);
  }

  // 証拠スクショは毎回残す
  try { await page.screenshot({ path: "raw_page.png", fullPage: true }); } catch {}

  // ---- DOM 抽出（Visit Profile 行を基準に拾う）----
  let rows = [];
  try {
    rows = await page.evaluate(() => {
      const isAddr = (s) => /[1-9A-HJ-NP-Za-km-z]{24,}/.test(s);
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      const candidates = Array.from(document.querySelectorAll("a,button"))
        .filter((el) => /visit profile/i.test(el.textContent || ""));

      const got = [];
      for (const btn of candidates) {
        // 行コンテナを上方向に辿る
        let node = btn;
        for (let k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (!node) break;

          const text = clean(node.innerText || "");
          if (!text) continue;

          // Rank: 例 "< 01 >"
          const mRank = text.match(/<\s*(\d{2})\s*>/);
          const rank = mRank ? Number(mRank[1]) : null;

          const mAddr = text.match(/[1-9A-HJ-NP-Za-km-z]{24,}/);
          const address = mAddr ? mAddr[0] : null;

          // Level
          const mLevel = text.match(/(?:LVL|LV)\s*\.?\s*(\d+)/i);
          const level = mLevel ? `LVL ${mLevel[1]}` : "";

          // FAF
          const mFaf = text.match(/([\d,]+)\s*FAF\s*staked/i);
          const faf = mFaf ? mFaf[1] : "";

          // Volume（$なしでもOK。列中の一番大きい数値を採用）
          const nums = (text.match(/[\d,]+(?:\.\d+)?/g) || [])
            .map((s) => Number(s.replace(/,/g, "")))
            .filter((v) => v > 0);
          const volumeNum = nums.length ? Math.max(...nums) : 0;

          if (address && volumeNum > 0) {
            got.push({ rank, address, level, faf, volumeNum });
            break;
          }
        }
      }
      // rank が null の行は volume 降順で並び直して rank 付与
      got.sort((a, b) => b.volumeNum - a.volumeNum);
      let r = 1;
      for (const g of got) g.rank = g.rank ?? r++;
      // 同一 address の重複排除
      const uniq = [];
      const seen = new Set();
      for (const g of got) {
        if (seen.has(g.address)) continue;
        seen.add(g.address);
        uniq.push(g);
      }
      return uniq.slice(0, 30); // 多めに返す
    });
  } catch {}

  // ---- fallback: 全文テキストから大雑把に拾う ----
  if (!rows || rows.length < 10) {
    try {
      const t = await page.evaluate(() => document.body.innerText);
      await fs.writeFile("data/raw_text.txt", t, "utf8");

      const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const idx = [];
      lines.forEach((s, i) => { if (/[1-9A-HJ-NP-Za-km-z]{24,}/.test(s)) idx.push(i); });

      const got = [];
      for (const i of idx) {
        const address = lines[i];
        const neigh = lines.slice(Math.max(0, i - 6), i + 8).join(" ");
        const mLevel = neigh.match(/(?:LVL|LV)\s*\.?\s*(\d+)/i);
        const level = mLevel ? `LVL ${mLevel[1]}` : "";
        const mFaf = neigh.match(/([\d,]+)\s*FAF\s*staked/i);
        const faf = mFaf ? mFaf[1] : "";
        const nums = (neigh.match(/[\d,]+(?:\.\d+)?/g) || [])
          .map((s) => Number(s.replace(/,/g, "")))
          .filter((v) => v > 0);
        const volumeNum = nums.length ? Math.max(...nums) : 0;
        if (address && volumeNum > 0) got.push({ address, level, faf, volumeNum });
      }
      got.sort((a, b) => b.volumeNum - a.volumeNum);
      rows = got.slice(0, 30).map((x, i) => ({ ...x, rank: i + 1 }));
    } catch {}
  }

  // ---- トータル（上部カード） ----
  let totalNum = null;
  try {
    const all = await page.evaluate(() => document.body.innerText);
    const m = all.match(/Epoch\s*#\s*\d+\s*Volume\s*Traded\s*\$?([\d,]+(?:\.\d+)?)/i);
    if (m) totalNum = Number(m[1].replace(/,/g, ""));
  } catch {}

  if (!rows || !rows.length) {
    // 完全にダメだった場合は HTML を保存して終了
    try { await fs.writeFile("debug/page.html", await page.content(), "utf8"); } catch {}
  }

  // 20件に整形
  rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || b.volumeNum - a.volumeNum);
  const top20 = rows.slice(0, 20).map((r, i) => ({
    rank: i + 1,
    address: r.address,
    level: r.level || "",
    faf: r.faf || "",
    volumeNum: r.volumeNum,
    volume: toUsd(r.volumeNum),
  }));

  // 前日差分
  let yday = [];
  try { yday = JSON.parse(await fs.readFile("data/last.json", "utf8")); } catch {}
  const mapY = new Map((yday || []).map((x) => [x.address, x]));
  const withDiff = top20.map((r, i) => {
    const y = mapY.get(r.address);
    const rank = i + 1;
    return {
      ...r,
      deltaVP: y ? r.volumeNum - (y.volumeNum || 0) : null,
      deltaRank: y ? rank - (y.rank || 0) : null,
    };
  });
  if (withDiff.length) {
    await fs.writeFile(
      "data/last.json",
      JSON.stringify(withDiff.map(({ deltaVP, deltaRank, ...rest }) => rest), null, 2)
    );
  }
  await fs.writeFile("data/top20.json", JSON.stringify(withDiff, null, 2), "utf8");

  // ---- カード描画 ----
  const totalStr = totalNum != null ? toUsd(totalNum) : "—";
  const rowsHtml = (withDiff.length ? withDiff : new Array(20).fill(null))
    .slice(0, 20)
    .map((r, idx) => {
      if (!r) {
        return `<tr><td>${String(idx + 1).padStart(2, "0")}</td><td></td><td></td><td></td><td class="r">-</td><td class="r">-</td><td class="r">-</td></tr>`;
      }
      const dVP = r.deltaVP == null ? "–" : `${r.deltaVP >= 0 ? "+" : "-"}${toUsd(Math.abs(r.deltaVP))}`;
      const dr = r.deltaRank == null ? "–" : r.deltaRank < 0 ? `▲${Math.abs(r.deltaRank)}` : r.deltaRank > 0 ? `▼${r.deltaRank}` : "＝";
      const drColor = r.deltaRank == null ? "#8aa1b1" : r.deltaRank < 0 ? "#2ecc71" : r.deltaRank > 0 ? "#e74c3c" : "#8aa1b1";
      return `<tr>
        <td>${medal(r.rank)}${String(r.rank).padStart(2, "0")}</td>
        <td title="${r.address}">${fixed(r.address, 48)}</td>
        <td title="${r.level}">${fixed(r.level, 10)}</td>
        <td title="${r.faf}">${fixed(r.faf, 14)}</td>
        <td class="r">${r.volume}</td>
        <td class="r">${dVP}</td>
        <td class="r" style="color:${drColor}">${dr}</td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html><meta charset="utf-8"/>
  <style>
    :root{--bg:#0b1217;--panel:#0f151a;--line:#15202b;--muted:#8aa1b1;--text:#e6f0f7}
    body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{width:1200px;margin:24px auto;background:var(--panel);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
    .head{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline}
    .title{font-size:24px;font-weight:700}
    .total{margin-left:auto;font-weight:700}
    .total small{color:var(--muted);font-weight:500;margin-right:10px}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    th{text-align:left;background:#0e151b;color:var(--muted);font-weight:600}
    tr:nth-child(even){background:#0e151b}
    th:nth-child(1),td:nth-child(1){width:120px}
    th:nth-child(2),td:nth-child(2){width:420px;font-family:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace}
    th:nth-child(3),td:nth-child(3){width:110px}
    th:nth-child(4),td:nth-child(4){width:160px}
    th:nth-child(5),td:nth-child(5){width:170px;text-align:right}
    th:nth-child(6),td:nth-child(6){width:160px;text-align:right}
    th:nth-child(7),td:nth-child(7){width:110px;text-align:right}
    .r{text-align:right}
    .foot{padding:10px 14px;color:var(--muted);font-size:12px}
  </style>
  <div class="wrap">
    <div class="head">
      <div class="title">FlashTrade Leaderboard — Top 20</div>
      <div class="total"><small>Total Volume Traded (Today):</small>${totalStr}</div>
    </div>
    <table>
      <thead><tr><th>Rank</th><th>Address</th><th>Level</th><th>FAF</th><th>Volume</th><th>ΔVP</th><th>ΔRank</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="foot">Snapshot (UTC) ${tsUTC()} ・ Source: flash.trade/leaderboard</div>
  </div>`;

  const card = await context.newPage();
  await card.setContent(html, { waitUntil: "load" });
  await card.screenshot({ path: "leaderboard_card.png", fullPage: true });

  await browser.close();
  console.log("✅ Done: leaderboard_card.png / raw_page.png / data/top20.json / data/last.json / debug/page.html");
})();