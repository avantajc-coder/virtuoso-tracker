/**
 * scraper.js — Virtuoso Price Tracker
 * Selectori corecți: .priceprodold / .priceprodspecial / .priceprodnormal
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

const TARGET_URL  = 'https://www.virtuoso.ro/modele-porti-metalice-aluminiu/seturi-porti';
const PRICES_FILE = path.join(__dirname, 'prices.json');
const HISTORY_DIR = path.join(__dirname, 'history');
const REPORT_FILE = path.join(__dirname, 'report.md');

const args     = process.argv.slice(2);
const saveJSON = args.includes('--json') || args.includes('-j');
const ciMode   = args.includes('--ci');
const watchMode= args.includes('--watch');

// ── UTILS ─────────────────────────────────────────────────────────────────────
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

// ── SCRAPER ───────────────────────────────────────────────────────────────────
async function scrape() {
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined);

  console.log(`🌐 Chromium: ${executablePath || 'auto-detect'}`);

  const browser = await puppeteer.launch({
    headless: 'new',
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
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1440, height: 900 });

    console.log('⏳ Se încarcă pagina…');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll pentru lazy-load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          total += 400;
          if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
        }, 100);
      });
    });
    await new Promise(r => setTimeout(r, 2500));

    // ── Extrage produsele ────────────────────────────────────────────────────
    const products = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      // Containerul fiecărui produs — găsit prin elementul de preț custom
      // .pretprod este clasa parinte care conține toate prețurile
      const priceContainers = Array.from(document.querySelectorAll('.pretprod'));
      const seen = new Set();
      const items = [];

      priceContainers.forEach(pc => {
        // Urcă până la containerul produsului (cel care are și titlul + link-ul)
        let el = pc;
        for (let i = 0; i < 8; i++) {
          el = el.parentElement;
          if (!el) break;
          const hasTitle = el.querySelector('h1,h2,h3,h4,h5,a[title],[class*="title"],[class*="name"]');
          const hasLink  = el.querySelector('a[href]');
          if (hasTitle && hasLink && !seen.has(el)) {
            seen.add(el);
            items.push(el);
            break;
          }
        }
      });

      // Fallback: dacă pretprod nu există, caută direct după clasele de preț
      if (items.length === 0) {
        document.querySelectorAll('.priceprodold, .priceprodspecial, .priceprodnormal').forEach(pc => {
          let el = pc;
          for (let i = 0; i < 8; i++) {
            el = el.parentElement;
            if (!el) break;
            if (el.querySelector('a[href]') && !seen.has(el)) {
              seen.add(el);
              items.push(el);
              break;
            }
          }
        });
      }

      console.log(`[scraper] containere produse găsite: ${items.length}`);

      return items.map(item => {
        // Titlu
        const titleEl = item.querySelector(
          'h1,h2,h3,h4,h5,[class*="title"],[class*="name"],a[title]'
        );
        const name = (titleEl?.getAttribute('title') || titleEl?.textContent || '')
          .trim().replace(/\s+/g, ' ');
        if (!name) return null;

        const href = item.querySelector('a[href]')?.href || '';
        const sku  = (item.querySelector('[class*="reference"],[class*="cod"]')?.textContent || '')
          .replace(/^(Cod|Ref|SKU)[\s:.]+/i, '').trim();

        // ── Prețuri cu selectorii exacți ────────────────────────────────────
        // Preț tăiat (prețul original / listare)
        const oldEl     = item.querySelector('.priceprodold');
        // Preț de vânzare (redus)
        const saleEl    = item.querySelector('.priceprodspecial');
        // Preț normal (fără reducere)
        const normalEl  = item.querySelector('.priceprodnormal');

        let priceNormal = parseP(oldEl?.textContent);
        let priceSale   = parseP(saleEl?.textContent);

        // Dacă nu e reducere activă, prețul normal e în .priceprodnormal
        if (priceNormal === null && priceSale === null) {
          priceNormal = parseP(normalEl?.textContent);
        }

        // Dacă avem preț tăiat dar nu special, poate fi invers
        if (priceNormal !== null && priceSale === null && normalEl) {
          const normalVal = parseP(normalEl.textContent);
          if (normalVal !== null && normalVal < priceNormal) {
            priceSale = normalVal;
          }
        }

        if (priceNormal == null && priceSale == null) return null;

        const stockEl = item.querySelector('[class*="stock"],[class*="stoc"],[class*="disponib"]');
        const inStock = !/(epuizat|indisponibil|out.of.stock)/i.test(stockEl?.textContent || '');

        return { name, href, sku, priceNormal, priceSale, inStock };
      }).filter(Boolean);
    });

    console.log(`✅ Produse extrase: ${products.length}`);
    return products;

  } finally {
    await browser.close();
  }
}

// ── DIFF ──────────────────────────────────────────────────────────────────────
function computeDiff(oldList, newList) {
  if (!oldList?.length) return { added: [], removed: [], changed: [] };
  const oldMap   = Object.fromEntries(oldList.map(p => [p.name, p]));
  const newNames = new Set(newList.map(p => p.name));
  const added    = newList.filter(p => !oldMap[p.name]);
  const removed  = oldList.filter(p => !newNames.has(p.name));
  const changed  = [];
  newList.forEach(p => {
    const old = oldMap[p.name];
    if (!old) return;
    if ((old.priceSale ?? old.priceNormal) !== (p.priceSale ?? p.priceNormal) ||
        old.priceNormal !== p.priceNormal) {
      changed.push({
        name: p.name, href: p.href,
        oldNormal: old.priceNormal, newNormal: p.priceNormal,
        oldSale: old.priceSale,   newSale: p.priceSale,
      });
    }
  });
  return { added, removed, changed };
}

// ── PRINT în terminal ─────────────────────────────────────────────────────────
function printResults(products, diff) {
  console.log('\n' + '═'.repeat(70));
  console.log('  💰  VIRTUOSO · Seturi Porți — Prețuri');
  console.log(`  ${TARGET_URL}`);
  console.log('═'.repeat(70) + '\n');

  if (!products.length) {
    console.log('  ✗ Nu au fost găsite produse.\n');
    return;
  }

  products.forEach(p => {
    const disc    = discount(p.priceNormal, p.priceSale);
    const hasSale = disc !== null;
    console.log(`  📦 ${p.name.substring(0, 65)}`);
    if (p.sku) console.log(`     Cod: ${p.sku}`);
    if (hasSale) {
      console.log(`     Preț normal:  ${fmtPrice(p.priceNormal)}`);
      console.log(`     Preț vânzare: ${fmtPrice(p.priceSale)}  (-${disc}%)`);
    } else {
      console.log(`     Preț: ${fmtPrice(p.priceNormal ?? p.priceSale)}`);
    }
    console.log(`     Stoc: ${p.inStock ? '✅ în stoc' : '❌ fără stoc'}`);
    console.log();
  });

  // Statistici sumar
  const onSale     = products.filter(p => discount(p.priceNormal, p.priceSale) !== null);
  const salePrices = onSale.map(p => p.priceSale).filter(Boolean);
  const discounts  = products.map(p => discount(p.priceNormal, p.priceSale)).filter(Boolean);

  console.log('─'.repeat(70));
  console.log(`  Total: ${products.length} produse  |  Cu reducere: ${onSale.length}`);
  if (salePrices.length) {
    console.log(`  Preț minim vânzare: ${fmtPrice(Math.min(...salePrices))}`);
    console.log(`  Reducere maximă:    ${Math.max(...discounts)}%`);
  }

  // Modificări față de rularea anterioară
  if (diff && (diff.changed.length || diff.added.length || diff.removed.length)) {
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

// ── RAPORT MARKDOWN ───────────────────────────────────────────────────────────
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
    lines.push(`## ⚡ Modificări față de ziua anterioară`);
    diff.changed.forEach(d => {
      lines.push(`\n### ${d.name}`);
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

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  let previousData = null;
  if (fs.existsSync(PRICES_FILE)) {
    try { previousData = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')).products; } catch (_) {}
  }

  const timestamp = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
  console.log(`\n📅 ${timestamp}`);

  let products;
  try {
    products = await scrape();
  } catch (err) {
    console.error(`\n✗ Eroare fatală: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  const diff = computeDiff(previousData, products);
  printResults(products, diff);

  if ((saveJSON || watchMode) && products.length > 0) {
    const payload = { timestamp, url: TARGET_URL, totalProducts: products.length, products };
    fs.writeFileSync(PRICES_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`✓ Salvat în prices.json`);

    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(HISTORY_DIR, `${new Date().toISOString().slice(0,10)}.json`),
      JSON.stringify(payload, null, 2), 'utf8'
    );

    fs.writeFileSync(REPORT_FILE, generateReport(products, diff, timestamp), 'utf8');
    console.log(`✓ Raport salvat în report.md`);
  }

  if (watchMode) setTimeout(run, 60 * 60 * 1000);
}

run();
