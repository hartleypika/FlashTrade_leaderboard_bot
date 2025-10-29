// snapshot.js
// 1) Playwrightでページの表データだけ抜く
// 2) node-canvas でTop20のランキング画像を生成（Discordに貼れるPNG）

import { chromium } from "playwright";   // package: playwright
import fs from "fs";
import { createCanvas } from "canvas";   // package: canvas

const URL = "https://www.flash.trade/leaderboard";

function fmt(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return "";
  return Number(n).toLocaleString("en-US");
}

(async () => {
  // ===== 1) 取得 =====
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });

  await page.goto(URL, { waitUntil: "networkidle", timeout: 120000 });

  // SPA描画待ち：テーブル行が現れるまで待機（最大60秒）
  await page.waitForFunction(() => {
    const rows =
      document.querySelectorAll("table tbody tr").length ||
      document.querySelectorAll("[data-testid*=row], .row").length;
    return rows >= 10;
  }, { timeout: 60000 });

  // ページのDOMからTop20を抽出
  const rows = await page.evaluate(() => {
    // まずテーブル想定
    const trs = Array.from(document.querySelectorAll("table tbody tr")).slice(0, 20);
    if (trs.length) {
      return trs.map((tr, i) => {
        const tds = Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim());
        // ページの列構成に合わせて並びを調整（必要ならここを微修正）
        // 期待: [Address, Level, FAF Staked, Total Volume Traded, ...] のような並び
        return {
          rank: i + 1,
          address: tds[0] || "",
          level: tds[1] || "",
          faf: tds[2] || "",
          volume: (tds[3] || "").replace(/[$,]/g, ""),
        };
      });
    }
    // Fallback: カスタム行要素（data-testid等）
    const els = Array.from(document.querySelectorAll("[data-testid*=row], .row")).slice(0, 20);
    return els.map((el, i) => {
      const text = el.innerText.split("\n").map(s => s.trim()).filter(Boolean);
      const address = text[0] || "";
      const level = (text.find(t => t.startsWith("LVL")) || "").trim();
      const faf = (text.find(t => /^[0-9,]+ FAF/.test(t)) || "").replace(/[^\d,]/g, "");
      const volStr = (text.find(t => t.includes("$")) || "").replace(/[$,]/g, "");
      return { rank: i + 1, address, level, faf, volume: volStr };
    });
  });

  await browser.close();

  // 万一0件なら、空の画像を出さずログだけ
  if (!rows || rows.length === 0) {
    console.log("No rows captured. The page structure may have changed.");
    process.exit(0);
  }

  // ===== 2) 画像生成 =====
  const W = 1300, H = 1600;                 // 画像サイズ（Discord向け）
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // 背景
  ctx.fillStyle = "#182428";
  ctx.fillRect(0, 0, W, H);

  // タイトル
  ctx.fillStyle = "#EFFFF9";
  ctx.font = "bold 48px Arial";
  ctx.fillText("⚡ FlashTrade Leaderboard — Top 20", 50, 60);

  // スナップショット時刻（UTC表示）
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  ctx.font = "22px Arial";
  ctx.fillStyle = "#ABBDB6";
  ctx.fillText(`Snapshot: UTC ${ts}`, 50, 95);

  // 合計（Total Volume Traded）
  const totalVol = rows.reduce((s, r) => s + (Number(r.volume) || 0), 0);
  ctx.font = "bold 30px Arial";
  ctx.fillStyle = "#FFEBAA";
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, 50, 130);

  // ヘッダー
  const X = { rank: 60, addr: 160, level: 520, faf: 640, vol: 860 };
  ctx.fillStyle = "#D2E6E1";
  ctx.font = "bold 28px Arial";
  ctx.fillText("Rank",   X.rank,  170);
  ctx.fillText("Address",X.addr,  170);
  ctx.fillText("Level",  X.level, 170);
  ctx.fillText("FAF",    X.faf,   170);
  ctx.fillText("Volume", X.vol,   170);

  // 行描画
  let y = 210;
  const rowH = 60;
  for (const r of rows) {
    // 偶数行ストライプ
    if (r.rank % 2 === 0) {
      ctx.fillStyle = "#1E2E32";
      ctx.fillRect(40, y - 30, W - 80, rowH - 10);
    }
    // メダル or ランク
    ctx.font = "26px Arial";
    if (r.rank === 1) { ctx.fillStyle = "#FFD700"; ctx.fillText("🥇", X.rank, y); }
    else if (r.rank === 2) { ctx.fillStyle = "#C0C0C0"; ctx.fillText("🥈", X.rank, y); }
    else if (r.rank === 3) { ctx.fillStyle = "#CD7F32"; ctx.fillText("🥉", X.rank, y); }
    else { ctx.fillStyle = "#C8DCD7"; ctx.fillText(String(r.rank).padStart(2,"0"), X.rank, y); }

    // 文字列
    ctx.fillStyle = "#E0EBE7";
    ctx.fillText((r.address || "").slice(0, 20) + (r.address?.length > 20 ? "…" : ""), X.addr, y);
    ctx.fillStyle = "#B5D2CC";
    ctx.fillText(r.level || "", X.level, y);
    ctx.fillText(r.faf ? fmt(r.faf) : "", X.faf, y);
    ctx.fillStyle = "#F0FFFA";
    ctx.fillText(`$${fmt(r.volume)}`, X.vol, y);

    y += rowH;
  }

  // 備考
  ctx.strokeStyle = "#587072"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(40, y + 10); ctx.lineTo(W - 40, y + 10); ctx.stroke();
  ctx.fillStyle = "#ADBFBA"; ctx.font = "20px Arial";
  ctx.fillText("Medals for Top 3. Δ/Rank Diff will appear from the second day.", 50, y + 40);

  // 保存
  fs.writeFileSync("leaderboard_snapshot.png", canvas.toBuffer("image/png"));
  console.log("✅ Saved: leaderboard_snapshot.png");
})();
