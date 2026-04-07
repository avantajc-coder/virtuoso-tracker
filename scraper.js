const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs            = require('fs');
const path          = require('path');

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

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ro-RO,ro;q=0.9' });

    console.log('⏳ Se încarcă pagina…');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Așteaptă Cloudflare
    await new Promise(r => setTimeout(r, 6000));
    let title = await page.title();
    if (/one moment|just a moment|checking|cloudflare/i.test(title)) {
      console.log('   Cloudflare activ, mai așteptăm…');
      await new Promise(r => setTimeout(r, 10000));
    }

    // Scroll lazy-load
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

    const products = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      // Containerul principal al fiecărui produs este .product-thumb
      const items = Array.from(document.querySelectorAll('.product-thumb'));
      console.log('[eval] .product-thumb găsite:', items.length);

      return items.map(item => {
        // Titlu — .productname sau primul link cu text
        const nameEl = item.querySelector('.productname, [class*="productname"], [class*="numeprod"]');
        const linkEl = item.querySelector('a[href]');
        const name   = (nameEl?.textContent || linkEl?.getAttribute('title') || linkEl?.textContent || '').trim().replace(/\s+/g, ' ');
        if (!name) return null;

        const href = linkEl?.href || '';

        // Prețuri
        // .priceprodold  = preț original (tăiat)
        // .priceprodspecial = preț redus
        // .priceprodnormal  = preț fără reducere
        const oldEl    = item.querySelector('.priceprodold');
        const saleEl   = item.querySelector('.priceprodspecial');
        const normEl   = item.querySelector('.priceprodnormal');

        let priceNormal = parseP(oldEl?.textContent);
        let priceSale   = parseP(saleEl?.textContent);

        // Dacă nu e reducere, priceprodnormal e prețul de bază
        if (priceNormal == null && priceSale == null) {
          priceNormal = parseP(normEl?.textContent);
        }

        if (priceNormal == null && priceSale == null) return null;

        const sku = (item.querySelector('[class*="reference"],[class*="cod"]')?.textContent || '')
          .replace(/^(Cod|Ref|SKU)[\s:.]+/i, '').trim();

        return { name, href, sku, priceNormal, priceSale, inStock: true };
      }).filter(Boolean);
    });

    console.log(`✅ Produse extrase: ${products.length}`);
    // Afișează primele 3 pentru verificare
    products.slice(0, 3).forEach(p => {
      console.log(`   • ${p.name.substring(0, 60)}`);
      console.log(`     Normal: ${p.priceNormal}  |  Vânzare: ${p.priceSale}`);
    });

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

  const onSale    = products.filter(p => discount(p.priceNormal, p.priceSale) !== null);
  const salePrices= onSale.map(p => p.priceSale).filter(Boolean);
  const discounts = products.map(p => discount(p.priceNormal, p.priceSale)).filter(Boolean);
  console.log('─'.repeat(70));
  console.log(`  Total: ${products.length} produse  |  Cu reducere: ${onSale.length}`);
  if (salePrices.length) {
    console.log(`  Preț minim vânzare: ${fmtPrice(Math.min(...salePrices))}`);
    console.log(`  Reducere maximă:    ${Math.max(...discounts)}%`);
  }

  if (diff?.changed.length || diff?.added.length || diff?.removed.length) {
    console.log('\n  ⚡ MODIFICĂRI față de ultima salvare:');
    diff.changed.forEach(d => {
      console.log(`  • ${d.name}`);
      if (d.oldNormal !== d.newNormal) console.log(`    Preț normal:  ${fmtPrice(d.oldNormal)} → ${fmtPrice(d.newNormal)}`);
      if (d.oldSale   !== d.newSale)   console.log(`    Preț vânzare: ${fmtPrice(d.oldSale)} → ${fmtPrice(d.newSale)}`);
    });
    diff.added.forEach(p   => console.log(`  ✚ NOU: ${p.name}`));
    diff.removed.forEach(p => console.log(`  ✖ DISPĂRUT: ${p.name}`));
  } else if (diff) {
    console.log('\n  ✓ Nicio modificare față de ultima verificare.');
  }
  console.log();
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
    lines.push(`## ⚡ Modificări față de ziua anterioară`);
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
    fs.writeFileSync(
      path.join(HISTORY_DIR, `${new Date().toISOString().slice(0,10)}.json`),
      JSON.stringify(payload, null, 2), 'utf8'
    );
    fs.writeFileSync(REPORT_FILE, generateReport(products, diff, timestamp), 'utf8');
    console.log(`✓ prices.json și report.md salvate.`);
  }

  if (watchMode) setTimeout(run, 60 * 60 * 1000);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
