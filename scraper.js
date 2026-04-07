/**
 * scraper.js — Virtuoso Price Tracker v5
 * Folosește puppeteer-extra + stealth plugin pentru a ocoli Cloudflare.
 */

const puppeteer       = require('puppeteer-extra');
const StealthPlugin   = require('puppeteer-extra-plugin-stealth');
const fs              = require('fs');
const path            = require('path');

puppeteer.use(StealthPlugin());

const TARGET_URL  = 'https://www.virtuoso.ro/modele-porti-metalice-aluminiu/seturi-porti';
const PRICES_FILE = path.join(__dirname, 'prices.json');
const HISTORY_DIR = path.join(__dirname, 'history');
const REPORT_FILE = path.join(__dirname, 'report.md');

const args      = process.argv.slice(2);
const saveJSON  = args.includes('--json') || args.includes('-j');
const watchMode = args.includes('--watch');

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
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
  });

  try {
    const page = await browser.newPage();

    // Setări realiste de browser
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    });

    console.log('⏳ Se încarcă pagina…');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Așteaptă să treacă de Cloudflare (poate dura 5-10 secunde)
    console.log('⏳ Așteptăm să treacă verificarea Cloudflare…');
    await new Promise(r => setTimeout(r, 6000));

    // Verifică titlul — dacă e încă Cloudflare, mai așteptăm
    let title = await page.title();
    console.log(`   Titlu după 6s: "${title}"`);

    if (/one moment|just a moment|checking|cloudflare/i.test(title)) {
      console.log('   Cloudflare activ, mai așteptăm 10s…');
      await new Promise(r => setTimeout(r, 10000));
      title = await page.title();
      console.log(`   Titlu după 16s: "${title}"`);
    }

    // Scroll pentru lazy-load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
        }, 120);
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── Extrage produsele ────────────────────────────────────────────────────
    const { products, debugInfo } = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      const debugInfo = {
        title:            document.title,
        bodyLen:          document.body.innerHTML.length,
        priceprodold:     document.querySelectorAll('.priceprodold').length,
        priceprodspecial: document.querySelectorAll('.priceprodspecial').length,
        priceprodnormal:  document.querySelectorAll('.priceprodnormal').length,
        pretprod:         document.querySelectorAll('[class*="pretprod"]').length,
        allClasses: [...new Set(
          Array.from(document.querySelectorAll('[class*="price"],[class*="pret"],[class*="prod"]'))
            .flatMap(el => (el.className || '').split(/\s+/))
            .filter(c => c.length > 2)
        )].slice(0, 30),
      };

      const results = [];
      const seenNames = new Set();

      // Pornește de la elementele de preț cunoscute
      const priceSelectors = [
        '.priceprodspecial',
        '.priceprodnormal',
        '.priceprodold',
        '[class*="priceprod"]',
        '[class*="pretprod"]',
      ];

      let priceEls = [];
      for (const sel of priceSelectors) {
        priceEls = Array.from(document.querySelectorAll(sel));
        if (priceEls.length > 0) break;
      }

      priceEls.forEach(priceEl => {
        // Urcă prin DOM căutând containerul cu titlu + link
        let container = priceEl.parentElement;
        for (let i = 0; i < 12; i++) {
          if (!container || container === document.body) break;
          const hasTitle = container.querySelector('h1,h2,h3,h4,h5,a[title],.product-title,[class*="title"],[class*="name"]');
          const hasLink  = container.querySelector('a[href]');
          if (hasTitle && hasLink) break;
          container = container.parentElement;
        }
        if (!container || container === document.body) return;

        const titleEl = container.querySelector('h1,h2,h3,h4,h5,a[title],.product-title,[class*="title"],[class*="name"]');
        const name = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim().replace(/\s+/g, ' ');
        if (!name || seenNames.has(name)) return;
        seenNames.add(name);

        const href = container.querySelector('a[href]')?.href || '';
        const sku  = (container.querySelector('[class*="reference"],[class*="cod"]')?.textContent || '')
          .replace(/^(Cod|Ref|SKU)[\s:.]+/i, '').trim();

        const priceNormal = parseP(container.querySelector('.priceprodold')?.textContent);
        const priceSaleEl = container.querySelector('.priceprodspecial') || container.querySelector('.priceprodnormal');
        const priceSale   = parseP(priceSaleEl?.textContent);

        if (priceNormal == null && priceSale == null) return;

        results.push({ name, href, sku, priceNormal, priceSale, inStock: true });
      });

      return { products: results, debugInfo };
    });

    console.log(`\n📊 POST-CLOUDFLARE DEBUG:`);
    console.log(`   Titlu: ${debugInfo.title}`);
    console.log(`   Body length: ${debugInfo.bodyLen}`);
    console.log(`   .priceprodold: ${debugInfo.priceprodold}`);
    console.log(`   .priceprodspecial: ${debugInfo.priceprodspecial}`);
    console.log(`   .priceprodnormal: ${debugInfo.priceprodnormal}`);
    console.log(`   [*pretprod*]: ${debugInfo.pretprod}`);
    console.log(`   Clase găsite: ${debugInfo.allClasses.join(', ')}`);
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
  if (!products.length) { console.log('  ✗ 0 produse găsite.\n'); return; }
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
  if (diff?.changed.length || diff?.added.length || diff?.removed.length) {
    console.log('⚡ MODIFICĂRI:');
    diff.changed.forEach(d => {
      console.log(`  • ${d.name}`);
      if (d.oldNormal !== d.newNormal) console.log(`    Preț normal:  ${fmtPrice(d.oldNormal)} → ${fmtPrice(d.newNormal)}`);
      if (d.oldSale   !== d.newSale)   console.log(`    Preț vânzare: ${fmtPrice(d.oldSale)} → ${fmtPrice(d.newSale)}`);
    });
    diff.added.forEach(p   => console.log(`  ✚ NOU: ${p.name}`));
    diff.removed.forEach(p => console.log(`  ✖ DISPĂRUT: ${p.name}`));
  }
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
  if (diff?.changed.length || diff?.added.length || diff?.removed.length) {
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
    lines.push(`> ✅ Nicio modificare față de ziua anterioară.\n`);
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
