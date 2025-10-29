// snapshot.js (fail-safe版) — API/DOM/全文正規表現 + 自動スクロール + 診断出力 + レイアウト修正
const { chromium } = require('playwright');
const fs = require('fs');
const { createCanvas } = require('canvas');

const URL = 'https://www.flash.trade/leaderboard';

// --------- helpers ----------
const nowTag = () => `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
const num = v => Number(String(v).replace(/[^\d.-]/g, ''));
const fmt = v => { const n = num(v); return isNaN(n) ? '' : n.toLocaleString('en-US'); };
function fitText(ctx, text, maxW){ if(!text) return ''; if(ctx.measureText(text).width<=maxW) return text;
  let lo=0,hi=text.length; while(lo<hi){const m=(lo+hi)/2|0; const s=text.slice(0,m)+'…';
    if(ctx.measureText(s).width<=maxW) lo=m+1; else hi=m;} return text.slice(0,Math.max(0,lo-1))+'…'; }
async function autoScroll(page){ await page.evaluate(async ()=>{
  await new Promise(res=>{ let y=0; const step=400; const timer=setInterval(()=>{
    const sh=document.scrollingElement.scrollHeight; window.scrollTo(0,y+=step);
    if(y+window.innerHeight>=sh){clearInterval(timer); setTimeout(res,600);} },200);});
});}

// --------- DOM scrape ----------
async function scrapeFromDOM(page){
  // 表示完了を待ちながらテーブル or role=row を試す
  const viaTable = await page.$$eval('table tbody tr', trs => trs.slice(0,20).map((tr,i)=>{
    const tds=[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\s+/g,' ').trim());
    return {rank:i+1,address:tds[0]||'',level:tds[1]||'',faf:(tds[2]||'').replace(/[^\d,.-]/g,''),volume:(tds[3]||'').replace(/[$,]/g,'')};
  })).catch(()=>[]);
  if(viaTable?.length>=10) return viaTable;

  const viaRole = await page.$$eval('[role="row"]', rows=>{
    const pick=rows.slice(0,25).map(r=>{
      const cells=[...r.querySelectorAll('[role="cell"],td,div')];
      const texts=cells.map(c=>(c.innerText||c.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
      return {texts};
    }).filter(x=>x.texts.length>=4).slice(0,20);
    return pick.map((r,idx)=>({rank:idx+1,address:r.texts[0]||'',level:r.texts[1]||'',
      faf:(r.texts[2]||'').replace(/[^\d,.-]/g,''),volume:(r.texts[3]||'').replace(/[$,]/g,'')}));
  }).catch(()=>[]);
  if(viaRole?.length>=10) return viaRole;
  return [];
}

// --------- MAIN ----------
(async()=>{
  const browser = await chromium.launch({
    headless:true,
    args:[
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
      '--use-gl=swiftshader','--window-size=1500,2200','--lang=en-US,en'
    ]
  });
  const context = await browser.newContext({
    viewport:{width:1500,height:2200}, timezoneId:'UTC', locale:'en-US',
    bypassCSP:true, serviceWorkers:'block',
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    extraHTTPHeaders:{'Cache-Control':'no-cache','Pragma':'no-cache'}
  });
  await context.route('**/*', r=>{
    const req=r.request();
    r.continue({headers:{...req.headers(),'Cache-Control':'no-cache','Pragma':'no-cache'}});
  });
  const page = await context.newPage();

  // APIキャプチャ
  const apiDumps=[];
  page.on('response',async res=>{
    try{
      const ct=(res.headers()['content-type']||'').toLowerCase();
      if(ct.includes('application/json')){
        const u=res.url();
        if(/leader|board|rank|volume|stats/i.test(u)){
          apiDumps.push({u,ts:Date.now(),t:await res.text()});
        }
      }
    }catch{}
  });

  // 1st load + スクロール
  await page.goto(`${URL}?r=${nowTag()}`,{waitUntil:'networkidle',timeout:120000}).catch(()=>{});
  await page.waitForTimeout(1500);
  await autoScroll(page);
  await page.waitForTimeout(1500);

  // 2nd load（同内容なら）
  const probe1 = await page.evaluate(()=>document.body?.innerText?.length||0).catch(()=>0);
  await page.reload({waitUntil:'networkidle'}).catch(()=>{});
  await page.waitForTimeout(1200);
  await autoScroll(page);
  const probe2 = await page.evaluate(()=>document.body?.innerText?.length||0).catch(()=>0);
  if(probe1===probe2){
    await page.goto(`${URL}?fresh=${nowTag()}`,{waitUntil:'networkidle'}).catch(()=>{});
    await page.waitForTimeout(1500);
    await autoScroll(page);
  }

  // API → DOM → 本文 正規表現
  let rows=[];
  if(apiDumps.length){
    apiDumps.sort((a,b)=>b.ts-a.ts);
    for(const d of apiDumps){
      try{
        const obj=JSON.parse(d.t);
        const stack=[obj];
        while(stack.length){
          const v=stack.pop();
          if(Array.isArray(v) && v.length && typeof v[0]==='object'){
            const mapped=v.map((o,i)=>({
              rank:i+1,
              address:o.address||o.wallet||o.addr||o.user||o.owner||'',
              level:o.level?`LVL ${o.level}`:'',
              faf:String(o.faf_staked??o.faf??''),
              volume:String(o.volumeUsd??o.volume_usd??o.volume??o.volUsd??0)
            })).filter(x=>x.address && num(x.volume)>0);
            if(mapped.length>=10){ rows=mapped.slice(0,20); break; }
          }else if(v && typeof v==='object'){ for(const k in v) stack.push(v[k]); }
        }
        if(rows.length) break;
      }catch{}
    }
  }
  if(!rows.length) rows = await scrapeFromDOM(page);

  if(!rows.length){
    // 本文からの最終抽出
    const text = await page.evaluate(()=>document.body.innerText).catch(()=> '');
    fs.writeFileSync('dom.txt', text||'');
    const addrRe=/[1-9A-HJ-NP-Za-km-z]{20,}/;         // Base58っぽい
    const usdRe=/\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?/;    // $x,xxx.xx
    const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
    const out=[];
    for(let i=0;i<lines.length-8 && out.length<20;i++){
      const a=lines[i];
      const vol=lines.slice(i,i+8).find(s=>usdRe.test(s));
      if(addrRe.test(a) && vol){
        out.push({rank:out.length+1,address:a,level:'',faf:'',volume:vol.replace(/[$,]/g,'')});
      }
    }
    rows=out;
  }

  // 診断ファイル（常に残す）
  try{ await page.screenshot({path:'page_full.png',fullPage:true}); }catch{}
  try{
    const html = await page.evaluate(()=>document.querySelector('table')?.outerHTML || document.body.outerHTML);
    fs.writeFileSync('table.html', html);
  }catch{}

  if(!rows.length){
    // 何も取れない場合でも落とさず、空の表を作る（デバッグしやすくする）
    rows = Array.from({length:20},(_,i)=>({rank:i+1,address:'',level:'',faf:'',volume:'0'}));
  }else{
    rows = rows.slice(0,20);
  }

  // -------- 画像生成（重なり防止） --------
  const PAD_L=48, ROW_H=64, HEADER_H=170, FOOT_H=50;
  const COL={ rank:70, medal:28, addr:520, level:140, faf:180, vol:240 };
  const W=PAD_L+COL.rank+COL.medal+COL.addr+COL.level+COL.faf+COL.vol+PAD_L;
  const H=HEADER_H+rows.length*ROW_H+FOOT_H;
  const {createCanvas}=require('canvas');
  const canvas=createCanvas(W,H); const ctx=canvas.getContext('2d');

  ctx.fillStyle='#182428'; ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#EFFFF9'; ctx.font='bold 46px Arial'; ctx.textAlign='left';
  ctx.fillText('⚡ FlashTrade Leaderboard — Top 20', PAD_L,58);
  ctx.font='22px Arial'; ctx.fillStyle='#AFC3BE';
  const ts=new Date().toISOString().slice(0,16).replace('T',' ');
  ctx.fillText(`Snapshot (UTC): ${ts}`, PAD_L,92);

  const totalVol=rows.reduce((s,r)=>s+(num(r.volume)||0),0);
  ctx.font='bold 28px Arial'; ctx.fillStyle='#FFEBAA';
  ctx.fillText(`Total Volume Traded (Today): $${fmt(totalVol)} (– vs Yesterday)`, PAD_L,130);

  ctx.fillStyle='#D4E4DF'; ctx.font='bold 24px Arial';
  let x=PAD_L; ctx.textAlign='right'; ctx.fillText('Rank',x+COL.rank,164); x+=COL.rank+10;
  ctx.textAlign='left'; x+=COL.medal+10; ctx.fillText('Address',x,164); x+=COL.addr;
  ctx.fillText('Level',x,164); x+=COL.level; ctx.textAlign='right';
  ctx.fillText('FAF',x+COL.faf,164); x+=COL.faf+20; ctx.fillText('Volume',x+COL.vol,164);

  let y=HEADER_H+4;
  for(const r of rows){
    if(r.rank%2===0){ ctx.fillStyle='#1E2E32'; ctx.fillRect(PAD_L-10,y-28,W-PAD_L*2+20,ROW_H-8); }
    x=PAD_L;
    ctx.textAlign='right'; ctx.font='26px Arial'; ctx.fillStyle='#CFE1DC';
    ctx.fillText(String(r.rank).padStart(2,'0'), x+COL.rank, y); x+=COL.rank+10;
    ctx.textAlign='left'; ctx.font='26px Arial';
    if(r.rank===1) ctx.fillText('🥇',x,y); else if(r.rank===2) ctx.fillText('🥈',x,y); else if(r.rank===3) ctx.fillText('🥉',x,y);
    x+=COL.medal+10;
    ctx.fillStyle='#E8F4F1';
    ctx.fillText(fitText(ctx,(r.address||'').replace(/\s+/g,' '), COL.addr-6), x, y); x+=COL.addr;
    ctx.textAlign='left'; ctx.fillStyle='#B5CBC6'; ctx.font='24px Arial';
    ctx.fillText(r.level||'', x, y); x+=COL.level;
    ctx.textAlign='right'; ctx.fillStyle='#B5CBC6';
    ctx.fillText(r.faf?fmt(r.faf):'', x+COL.faf, y); x+=COL.faf+20;
    ctx.fillStyle='#F6FFFC'; ctx.font='26px Arial';
    ctx.fillText(`$${fmt(r.volume)}`, x+COL.vol, y);
    y+=ROW_H;
  }
  ctx.strokeStyle='#586B6F'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(PAD_L-10,y-20); ctx.lineTo(W-PAD_L+10,y-20); ctx.stroke();
  ctx.fillStyle='#AABBB7'; ctx.font='18px Arial'; ctx.textAlign='left';
  ctx.fillText('If data looks stale, artifacts include page_full.png / dom.txt / table.html for debugging.', PAD_L, y+18);

  fs.writeFileSync('leaderboard_snapshot.png', canvas.toBuffer('image/png'));
  console.log('✅ Saved: leaderboard_snapshot.png');

  await browser.close();
})();
