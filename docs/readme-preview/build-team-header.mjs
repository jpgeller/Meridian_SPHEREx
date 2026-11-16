import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

// First and last names from the supplied team reference; edit this list to change the order.
const members = [
  ['George Lawendy', 'george.png'],
  ['Halytza Dutra', 'halytza.jpeg'],
  ['Janisha Hota', 'janisha.png'],
  ['João Caldeira', 'joao_caldeira.png'],
  ['João Geller', 'joao_paulo.png'],
  ['Yassin Abdelal', 'yassin.png'],
];
const output = new URL('../img/readme/', import.meta.url);
await mkdir(output, { recursive: true });
let svg = await readFile(new URL('team-header.svg', import.meta.url), 'utf8');
const cards = members.map(([name, photo], i) => {
  const x = 48 + i * 216;
  return `<g transform="translate(${x} 439)">
 <rect width="200" height="291" rx="12" fill="#0b1126" stroke="#26325a"/>
 <defs><clipPath id="portrait-${i}"><rect x="12" y="12" width="176" height="220" rx="7"/></clipPath></defs>
 <image href="../members_pictures/${photo}" x="12" y="12" width="176" height="220" preserveAspectRatio="xMidYMid slice" clip-path="url(#portrait-${i})"/>
 <rect x="12" y="12" width="176" height="220" rx="7" fill="none" stroke="#26325a"/>
 <rect x="12" y="248" width="3" height="27" rx="1.5" fill="#ffb547"/>
 <text x="25" y="266" font-size="17" font-weight="600">${name}</text>
 </g>`;
}).join('\n');
const start = svg.indexOf('<g transform="translate(48 439)">');
const end = svg.indexOf('<path d="M48 722H1352"');
if (start < 0 || end < start) throw new Error('Cannot locate template team section');
svg = svg.slice(0, start) + cards + '\n ' + svg.slice(end);
svg = svg.replace('height="800" viewBox="0 0 1400 800"', 'height="840" viewBox="0 0 1400 840"')
  .replaceAll('height="752"', 'height="792"')
  .replace('width="1400" height="800"', 'width="1400" height="840"')
  .replace('M48 722H1352', 'M48 762H1352').replaceAll('y="752"', 'y="792"')
  .replace('team preview</title>', 'team</title>')
  .replace('followed by six team photo and name placeholders.', `with portraits of ${members.map(([name]) => name).join(', ')}.`);
await writeFile(new URL('team-header.svg', output), svg);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 840 }, deviceScaleFactor: 2 });
  await page.goto(new URL('team-header.svg', output).href);
  // Validate the linked portraits and wait for decoding before rendering.
  await page.evaluate(async () => {
    const portraits = [...document.querySelectorAll('image')];
    if (portraits.length !== 6) throw new Error('Expected six portraits');
    await Promise.all(portraits.map(async (portrait) => {
      const img = new Image();
      img.src = new URL(portrait.getAttribute('href'), document.baseURI).href;
      await img.decode();
    }));
    await document.fonts.ready;
  });
  await page.screenshot({ path: fileURLToPath(new URL('team-header.png', output)) });
} finally {
  await browser.close();
}
console.log('Rendered docs/img/readme/team-header.png with six portraits.');
