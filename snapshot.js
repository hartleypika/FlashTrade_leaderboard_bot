async function scrapeRows(page) {
  // まずは「table > tbody > tr」から試す
  const viaTable = await page.$$eval('table tbody tr', trs => {
    return trs.slice(0, 20).map((tr, i) => {
      const tds = Array.from(tr.querySelectorAll('td')).map(td =>
        td.innerText.replace(/\s+/g, ' ').trim()
      );
      return {
        rank: i + 1,
        address: tds[0] || '',
        level:   tds[1] || '',
        faf:     (tds[2] || '').replace(/[^\d,.-]/g, ''),
        volume:  (tds[3] || '').replace(/[$,]/g, ''),
        _raw: tds
      };
    });
  }).catch(() => []);

  if (viaTable && viaTable.length >= 5 && viaTable.some(r => r._raw.length >= 4)) {
    return viaTable;
  }

  // つぎに、ARIAベース（しばしば使われる）
  const viaRole = await page.$$eval('[role="row"]', rows => {
    const pick = rows.slice(0, 25).map((row, i) => {
      const cells = Array.from(row.querySelectorAll('[role="cell"], td, div'));
      const texts = cells.map(c => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { i, texts };
    }).filter(x => x.texts.length >= 4).slice(0, 20);

    return pick.map((r, idx) => ({
      rank: idx + 1,
      address: r.texts[0] || '',
      level:   r.texts[1] || '',
      faf:     (r.texts[2] || '').replace(/[^\d,.-]/g, ''),
      volume:  (r.texts[3] || '').replace(/[$,]/g, ''),
      _raw:    r.texts
    }));
  }).catch(() => []);

  if (viaRole && viaRole.length >= 5) return viaRole;

  // 最後の手：ページ全テキストをざっくりパース（正規表現）
  const bigText = await page.evaluate(() => document.body.innerText);
  const lines = bigText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 400);

  // アドレスっぽい（Base58短縮表示）+ $金額っぽいものを拾う
  const addrRe = /^[1-9A-HJ-NP-Za-km-z]{2,5}.*[1-9A-HJ-NP-Za-km-z]{2,5}$/; // 省略表示を想定
  const usdRe  = /^\$?\d{1,3}(,\d{3})*(\.\d+)?$/;

  const rowsLoose = [];
  for (let i = 0; i < lines.length - 5 && rowsLoose.length < 20; i++) {
    const a = lines[i];
    const v = lines.slice(i, i + 6).find(s => usdRe.test(s));
    if (addrRe.test(a) && v) {
      rowsLoose.push({
        rank: rowsLoose.length + 1,
        address: a,
        level:   '',
        faf:     '',
        volume:  v.replace(/[$,]/g, ''),
        _raw:    [a, '', '', v]
      });
    }
  }
  return rowsLoose;
}
