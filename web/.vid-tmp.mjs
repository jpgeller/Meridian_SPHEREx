import { chromium } from 'playwright';
const [out, url, tag] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await p.goto(url);
await p.waitForFunction(() => window.meridian?.store);
const t0 = Date.now();
await p.evaluate(() => meridian.run('set_show', { show: 'video' }));
await p.waitForTimeout(500);
await p.click('#p-play');
let lastDate = '';
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({
    playing: meridian.store.get().playing,
    loading: !document.querySelector('#player-loading').hidden ? document.querySelector('#pl-text').textContent : '',
    msg: document.querySelector('#player-msg').textContent.slice(0, 80),
    seq: meridian.player.getSequence().length,
    date: meridian.player.getShownFrame()?.meta?.date_iso?.slice(0, 10) ?? '',
  }));
  console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(st));
  if (i === 1) await p.screenshot({ path: `${out}/vid-${tag}-early.png` });
}
await p.screenshot({ path: `${out}/vid-${tag}-late.png` });
await b.close();
