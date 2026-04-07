/**
 * scraper.js — Virtuoso Price Tracker v4
 * Abordare directă: pornește de la .priceprodold/.priceprodspecial/.priceprodnormal
 * și extrage datele fără să mai urce prin DOM după container.
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

const TARGET_URL  = 'https://www.virtuoso.ro/modele-porti-metalice-aluminiu/seturi-porti';
const PRICES_FILE = path.join(__dirname, 'prices.json');
const HISTORY_DIR = path.join(__dirname, 'history');
const REPORT_FILE = path.join(__dirname, 'report.md');
const DEBUG_HTML  = path.join(__dirname, 'debug-page.html');
const DEBUG_PNG   = path.join(__dirname, 'debug-screenshot.png');

const args     = process.argv.slice(2);
const saveJSON = args.includes('--json') || args.includes('-j');
const watchMode= args.includes('--watch');

function fmtPrice(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' lei';
}
function discount(normal, sale) {
  if (!normal || !sale || sale >= normal) return null;
  return Math.round((1 - sale / normal) * 100);
}
function parsePrice(str) {
  if (!str) return null;
  const clean = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) || n < 100 ? null : n;
}

async function scrape() {
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined);

  console.log(`🌐 Chromium: ${executablePath || 'auto-detect'}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    console.log('⏳ Se încarcă pagina…');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Scroll complet
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const h = document.body.scrollHeight;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= h) { clearInterval(timer); resolve(); }
        }, 120);
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── DEBUG: afișează tot ce găsim în pagină ──────────────────────────────
    const debugData = await page.evaluate(() => {
      const info = {};

      // Câte elemente cu fiecare clasă de preț
      info.priceprodold      = document.querySelectorAll('.priceprodold').length;
      info.priceprodspecial  = document.querySelectorAll('.priceprodspecial').length;
      info.priceprodnormal   = document.querySelectorAll('.priceprodnormal').length;
      info.pretprod          = document.querySelectorAll('.pretprod').length;
      info.pretprodAlignItems= document.querySelectorAll('[class*="pretprod"]').length;

      // Conținut text al primelor 3 elemente găsite
      const getTexts = sel => Array.from(document.querySelectorAll(sel))
        .slice(0, 3).map(el => el.textContent.trim().substring(0, 60));

      info.sampleOld     = getTexts('.priceprodold');
      info.sampleSpecial = getTexts('.priceprodspecial');
      info.sampleNormal  = getTexts('.priceprodnormal');
      info.samplePretprod= getTexts('[class*="pretprod"]');

      // HTML al primului element .priceprodold + 3 niveluri sus
      const firstOld = document.querySelector('.priceprodold');
      if (firstOld) {
        let el = firstOld;
        for (let i = 0; i < 6; i++) el = el.parentElement || el;
        info.ancestorHTML = el.outerHTML.substring(0, 2000);
      }

      // Toate clasele unice pe elementele cu termen "prod" sau "product" în clasă
      const allClasses = new Set();
      document.querySelectorAll('[class*="prod"],[class*="product"],[class*="item"]').forEach(el => {
        (el.className || '').split(/\s+/).forEach(c => { if (c) allClasses.add(c); });
      });
      info.allProdClasses = [...allClasses].slice(0, 40);

      // Titlu pagină + nr total elemente
      info.title = document.title;
      info.bodyLength = document.body.innerHTML.length;

      return info;
    });

    console.log('\n🔍 DEBUG INFO:');
    console.log(`   Titlu: ${debugData.title}`);
    console.log(`   Body HTML length: ${debugData.bodyLength}`);
    console.log(`   .priceprodold:     ${debugData.priceprodold} elemente`);
    console.log(`   .priceprodspecial: ${debugData.priceprodspecial} elemente`);
    console.log(`   .priceprodnormal:  ${debugData.priceprodnormal} elemente`);
    console.log(`   [class*="pretprod"]: ${debugData.pretprodAlignItems} elemente`);
    console.log(`\n   Sample .priceprodold:    ${JSON.stringify(debugData.sampleOld)}`);
    console.log(`   Sample .priceprodspecial: ${JSON.stringify(debugData.sampleSpecial)}`);
    console.log(`   Sample .priceprodnormal:  ${JSON.stringify(debugData.sampleNormal)}`);
    console.log(`   Sample [*pretprod*]:      ${JSON.stringify(debugData.samplePretprod)}`);
    console.log(`\n   Clase prod/item găsite: ${debugData.allProdClasses.join(', ')}`);
    if (debugData.ancestorHTML) {
      console.log(`\n   HTML ancestor (primul .priceprodold +6 niveluri sus):\n`);
      console.log(debugData.ancestorHTML);
    }

    // Salvează HTML complet + screenshot pentru inspecție
    const html = await page.content();
    fs.writeFileSync(DEBUG_HTML, html, 'utf8');
    await page.screenshot({ path: DEBUG_PNG, fullPage: false });
    console.log(`\n💾 debug-page.html (${Math.round(html.length/1024)}KB) și debug-screenshot.png salvate.`);

    // ── Extragere produse: abordare directă fără container ──────────────────
    const products = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      // Găsește cel mai mic ancestor comun între titlu și preț
      // Strategie: pornește de la fiecare element de preț și găsește titlul cel mai apropiat
      const results = [];
      const seenNames = new Set();

      // Selectori pentru prețuri (în ordinea preferinței)
      const priceEls = [
        ...Array.from(document.querySelectorAll('.priceprodspecial')),
        ...Array.from(document.querySelectorAll('.priceprodnormal')),
      ];

      priceEls.forEach(priceEl => {
        // Caută titlul urcând prin DOM
        let container = priceEl;
        let titleEl = null;
        let linkEl  = null;

        for (let i = 0; i < 10; i++) {
          container = container.parentElement;
          if (!container || container === document.body) break;

          titleEl = container.querySelector('h1,h2,h3,h4,h5,h6,.product-title,.product_title,[class*="title"],[class*="name"]');
          linkEl  = container.querySelector('a[href*="porti"], a[href*="set-"], a[href*="seturi"]');

          if (titleEl && linkEl) break;
        }

        if (!titleEl) return;

        const name = (titleEl.getAttribute('title') || titleEl.textContent || '')
          .trim().replace(/\s+/g, ' ');
        if (!name || seenNames.has(name)) return;
        seenNames.add(name);

        const href = linkEl?.href || container?.querySelector('a[href]')?.href || '';

        // Prețuri din container
        const oldEl    = container.querySelector('.priceprodold');
        const specEl   = container.querySelector('.priceprodspecial');
        const normEl   = container.querySelector('.priceprodnormal');

        let priceNormal = parseP(oldEl?.textContent);
        let priceSale   = parseP(specEl?.textContent);

        if (priceNormal === null && priceSale === null) {
          priceNormal = parseP(normEl?.textContent);
        }

        if (priceNormal === null && priceSale === null) return;

        const sku = (container.querySelector('[class*="reference"],[class*="cod"]')?.textContent || '')
          .replace(/^(Cod|Ref|SKU)[\s:.]+/i, '').trim();

        results.push({ name, href, sku, priceNormal, priceSale, inStock: true });
      });

      return results;
    });

    console.log(`\n✅ Produse extrase: ${products.length}`);
    return products;

  } finally {
    await browser.close();
  }
}

function computeDiff(oldList, newList) {
  if (!oldList?.length) return { added: [], removed: [], changed: [] };
  const oldMap   = Object.fromEntries(oldList.map(p => [p.name, p]));
  const newNames = new Set(newList.map(p => p.name));
  return {
    added:   newList.filter(p => !oldMap[p.name]),
    removed: oldList.filter(p => !newNames.has(p.name)),
    changed: newList.filter(p => {
      const o = oldMap[p.name];
      return o && ((o.priceSale ?? o.priceNormal) !== (p.priceSale ?? p.priceNormal) || o.priceNormal !== p.priceNormal);
    }).map(p => {
      const o = oldMap[p.name];
      return { name: p.name, href: p.href, oldNormal: o.priceNormal, newNormal: p.priceNormal, oldSale: o.priceSale, newSale: p.priceSale };
    }),
  };
}

function printResults(products, diff) {
  console.log('\n' + '═'.repeat(70));
  console.log('  💰  VIRTUOSO · Seturi Porți — Prețuri');
  console.log('═'.repeat(70) + '\n');
  products.forEach(p => {
    const disc = discount(p.priceNormal, p.priceSale);
    console.log(`  📦 ${p.name.substring(0, 65)}`);
    if (p.sku) console.log(`     Cod: ${p.sku}`);
    if (disc) {
      console.log(`     Preț normal:  ${fmtPrice(p.priceNormal)}`);
      console.log(`     Preț vânzare: ${fmtPrice(p.priceSale)}  (-${disc}%)`);
    } else {
      console.log(`     Preț: ${fmtPrice(p.priceNormal ?? p.priceSale)}`);
    }
    console.log();
  });
  if (!products.length) console.log('  ✗ 0 produse găsite.\n');
}

function generateReport(products, diff, timestamp) {
  const lines = [
    `# 💰 Virtuoso Price Report`,
    ``,
    `**Pagina:** [seturi-porti](${TARGET_URL})  `,
    `**Actualizat:** ${timestamp}  `,
    `**Total produse:** ${products.length}`,
    ``,
  ];
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    lines.push(`## ⚡ Modificări`);
    diff.changed.forEach(d => {
      lines.push(`### ${d.name}`);
      if (d.oldNormal !== d.newNormal) lines.push(`- Preț normal: ~~${fmtPrice(d.oldNormal)}~~ → **${fmtPrice(d.newNormal)}**`);
      if (d.oldSale   !== d.newSale)   lines.push(`- Preț vânzare: ~~${fmtPrice(d.oldSale)}~~ → **${fmtPrice(d.newSale)}**`);
    });
    diff.added.forEach(p   => lines.push(`- ✅ **NOU:** ${p.name}`));
    diff.removed.forEach(p => lines.push(`- ❌ **Dispărut:** ${p.name}`));
    lines.push('');
  } else if (diff) {
    lines.push(`> ✅ Nicio modificare de preț față de ziua anterioară.\n`);
  }
  lines.push(`## 📋 Toate produsele`);
  lines.push(`| Produs | Preț normal | Preț vânzare | Reducere | Stoc |`);
  lines.push(`|--------|------------|--------------|----------|------|`);
  products.forEach(p => {
    const disc = discount(p.priceNormal, p.priceSale);
    const link = p.href ? `[${p.name.substring(0,50)}](${p.href})` : p.name.substring(0,50);
    lines.push(`| ${link} | ${fmtPrice(p.priceNormal)} | ${disc ? fmtPrice(p.priceSale) : '—'} | ${disc ? `-${disc}%` : '—'} | ${p.inStock ? '✅' : '❌'} |`);
  });
  return lines.join('\n');
}

async function run() {
  let previousData = null;
  if (fs.existsSync(PRICES_FILE)) {
    try { previousData = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')).products; } catch (_) {}
  }
  const timestamp = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
  console.log(`\n📅 ${timestamp}`);

  const products = await scrape();
  const diff = computeDiff(previousData, products);
  printResults(products, diff);

  if ((saveJSON || watchMode) && products.length > 0) {
    const payload = { timestamp, url: TARGET_URL, totalProducts: products.length, products };
    fs.writeFileSync(PRICES_FILE, JSON.stringify(payload, null, 2), 'utf8');
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(HISTORY_DIR, `${new Date().toISOString().slice(0,10)}.json`), JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(REPORT_FILE, generateReport(products, diff, timestamp), 'utf8');
    console.log(`✓ prices.json și report.md salvate.`);
  }

  if (watchMode) setTimeout(run, 60 * 60 * 1000);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
