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

    // address（"xxxx