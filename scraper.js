/**
 * scraper.js — Virtuoso Price Tracker
 * Funcționează local (npm start) sau pe GitHub Actions (node scraper.js --json --ci)
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_URL   = 'https://www.virtuoso.ro/modele-porti-metalice-aluminiu/seturi-porti';
const PRICES_FILE  = path.join(__dirname, 'prices.json');
const HISTORY_DIR  = path.join(__dirname, 'history');
const REPORT_FILE  = path.join(__dirname, 'report.md');

const args     = process.argv.slice(2);
const saveJSON = args.includes('--json') || args.includes('-j');
const ciMode   = args.includes('--ci');          // mod silențios pentru GitHub Actions
const watchMode= args.includes('--watch');

// ── UTILS ─────────────────────────────────────────────────────────────────────
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', white:'\x1b[37m'
};
const c = (col, s) => ciMode ? s : `${C[col]}${s}${C.reset}`;

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
  console.log(c('cyan', '\n🔍 Se pornește browserul…'));

  // Pe GitHub Actions chromium e instalat de sistem; local caută în PATH
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (process.platform === 'linux'
      ? '/usr/bin/chromium-browser'
      : undefined); // local: puppeteer-core va folosi Chrome instalat

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=ro-RO',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ro-RO,ro;q=0.9' });

    console.log(c('dim', `  ⏳ Se încarcă pagina…`));
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Acceptă cookie banner dacă există
    try {
      const cookieBtn = await page.$('[id*="accept"], [class*="accept-cookie"], .cookieBtn, #CybotCookiebotDialogBodyButtonAccept');
      if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(600); }
    } catch (_) {}

    // Scroll jos pentru lazy-load
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 500);
          total += 500;
          if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
        }, 150);
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── Extrage produsele ──────────────────────────────────────────────────
    const products = await page.evaluate((parsePrice_src) => {
      // Reconstruieste parsePrice în contextul browserului
      const parsePrice = new Function('str', `
        if (!str) return null;
        const clean = str.replace(/[^\\d,.]/g, '').replace(/\\.(?=\\d{3})/g, '').replace(',', '.');
        const n = parseFloat(clean);
        return isNaN(n) || n < 100 ? null : n;
      `);

      const results = [];

      // Încearcă mai mulți selectori posibili pentru containerele de produs
      const ITEM_SELECTORS = [
        '.js-product-miniature',
        '.product-miniature',
        '.product_miniature',
        '[class*="product-miniature"]',
        '[class*="productMiniature"]',
        'article[class*="product"]',
        'li[class*="product"]',
        '.product-item-container',
        '[id*="product_miniature"]',
        '[data-id-product]',
      ];

      let items = [];
      for (const sel of ITEM_SELECTORS) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 1) { items = found; break; }
      }

      // Fallback amplu: caută orice element cu link + price în interior
      if (items.length === 0) {
        const allLinks = Array.from(document.querySelectorAll('a[href*="set-porti"], a[href*="seturi"]'));
        const seen = new Set();
        allLinks.forEach(a => {
          // Urcă maxim 5 niveluri să găsim containerul produsului
          let el = a;
          for (let i = 0; i < 5; i++) {
            el = el.parentElement;
            if (!el) break;
            const hasPrices = el.querySelectorAll('[class*="price"], [class*="pret"]').length > 0;
            if (hasPrices && !seen.has(el)) {
              seen.add(el);
              items.push(el);
              break;
            }
          }
        });
      }

      items.forEach(item => {
        // Titlu
        const titleEl = item.querySelector([
          '.product-title', '.product_title', 'h1','h2','h3','h4',
          '[class*="product-title"]', '[class*="ProductTitle"]',
          'a[title]', '.product-name',
        ].join(', '));
        const name = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();
        if (!name) return;

        // Link
        const href = item.querySelector('a[href]')?.href || '';

        // SKU / Cod
        const skuEl = item.querySelector('[class*="reference"], [class*="sku"], [class*="product-reference"]');
        const sku   = (skuEl?.textContent || '').replace(/^(Cod|SKU|Ref\.?)[\s:]+/i,'').trim();

        // ── Prețuri ──────────────────────────────────────────────────────────
        // Preț barat (original)
        const oldEl = item.querySelector([
          '.regular-price', '.price-regular', '[class*="regular-price"]',
          '.old-price', '[class*="old-price"]',
          'del span', 'del .price', 's .price', 'strike .price',
          '[class*="price-old"]', '[class*="crossed"]', '.was',
        ].join(', '));

        // Preț de vânzare (curent)
        const saleEl = item.querySelector([
          '.price:not(.regular-price):not(.old-price)',
          '.current-price span', '.current-price-value',
          '[class*="current-price"]', '[class*="sale-price"]',
          '[class*="special-price"]', '[class*="price-sale"]',
          'ins .price', 'ins span',
          '.product-price',
        ].join(', '));

        let priceNormal = parsePrice(oldEl?.textContent);
        let priceSale   = parsePrice(saleEl?.textContent);

        // Dacă nu am distincție, colectează toate prețurile vizibile
        if (priceNormal === null && priceSale === null) {
          const allPriceEls = Array.from(item.querySelectorAll('[class*="price"], [class*="pret"]'));
          const nums = allPriceEls
            .map(el => parsePrice(el.textContent))
            .filter(n => n !== null);

          if (nums.length === 1) priceSale   = nums[0];
          if (nums.length >= 2) {
            priceNormal = Math.max(...nums);
            priceSale   = Math.min(...nums);
            if (priceNormal === priceSale) { priceSale = null; }
          }
        }

        if (priceNormal == null && priceSale == null) return;

        // Badge % reducere
        const badgeEl = item.querySelector('[class*="discount"], [class*="reducere"], [class*="promo-badge"], .badge');
        const badge   = (badgeEl?.textContent || '').trim();

        // Stoc
        const stockEl = item.querySelector('[class*="product-availability"], [class*="stock"], [class*="stoc"]');
        const inStock  = !stockEl || !/epuizat|indisponibil|out.of.stock/i.test(stockEl.textContent);

        results.push({ name, href, sku, priceNormal, priceSale, badge, inStock });
      });

      return results;
    });

    return products;

  } finally {
    await browser.close();
  }
}

// ── DIFF ──────────────────────────────────────────────────────────────────────
function computeDiff(oldList, newList) {
  if (!oldList || !oldList.length) return { added: [], removed: [], changed: [] };

  const oldMap = {};
  oldList.forEach(p => { oldMap[p.name] = p; });
  const newNames = new Set(newList.map(p => p.name));

  const added   = newList.filter(p => !oldMap[p.name]);
  const removed = oldList.filter(p => !newNames.has(p.name));
  const changed = [];

  newList.forEach(p => {
    const old = oldMap[p.name];
    if (!old) return;
    const oldSale   = old.priceSale   ?? old.priceNormal;
    const newSale   = p.priceSale     ?? p.priceNormal;
    const oldNormal = old.priceNormal;
    const newNormal = p.priceNormal;

    if (oldSale !== newSale || oldNormal !== newNormal) {
      changed.push({ name: p.name, href: p.href, oldNormal, newNormal, oldSale, newSale });
    }
  });

  return { added, removed, changed };
}

// ── PRINT în terminal ─────────────────────────────────────────────────────────
function printResults(products, diff) {
  console.log(c('cyan', '\n' + '═'.repeat(70)));
  console.log(c('bold', '  💰  VIRTUOSO · Seturi Porți — Prețuri'));
  console.log(c('dim', `  ${TARGET_URL}`));
  console.log(c('cyan', '═'.repeat(70)));

  if (!products.length) {
    console.log(c('red', '\n  ✗ Nu au fost găsite produse.\n'));
    return;
  }

  console.log();
  products.forEach(p => {
    const disc    = discount(p.priceNormal, p.priceSale);
    const hasSale = disc !== null;

    const name  = (p.name || '').substring(0, 50);
    const pNorm = fmtPrice(p.priceNormal);
    const pSale = hasSale ? fmtPrice(p.priceSale) : null;
    const stock = p.inStock ? c('green','✓ stoc') : c('red','✗ fără stoc');

    if (hasSale) {
      console.log(`  ${c('bold', name)}`);
      console.log(`    ${c('dim', pNorm + ' →')} ${c('yellow', c('bold', pSale))}  ${c('green', `-${disc}%`)}  ${stock}`);
    } else {
      console.log(`  ${c('bold', name)}`);
      console.log(`    ${c('white', fmtPrice(p.priceNormal ?? p.priceSale))}  ${stock}`);
    }
    if (p.sku) console.log(c('dim', `    Cod: ${p.sku}`));
    console.log();
  });

  // Statistici
  const onSale    = products.filter(p => discount(p.priceNormal, p.priceSale) !== null);
  const salePrices= onSale.map(p => p.priceSale).filter(Boolean);
  const discounts = products.map(p => discount(p.priceNormal, p.priceSale)).filter(Boolean);

  console.log(c('dim', '─'.repeat(70)));
  console.log(`  Total: ${c('cyan', products.length)} produse  |  Cu reducere: ${c('yellow', onSale.length)}`);
  if (salePrices.length) {
    console.log(`  Preț minim vânzare: ${c('green', fmtPrice(Math.min(...salePrices)))}`);
    console.log(`  Reducere maximă:    ${c('green', Math.max(...discounts) + '%')}`);
  }

  // Diff
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    console.log(c('yellow', '\n  ⚡ MODIFICĂRI față de ultima salvare:'));
    diff.changed.forEach(d => {
      console.log(`  • ${d.name}`);
      if (d.oldNormal !== d.newNormal)
        console.log(`    Preț normal:  ${c('dim', fmtPrice(d.oldNormal))} → ${c('white', fmtPrice(d.newNormal))}`);
      if (d.oldSale !== d.newSale)
        console.log(`    Preț vânzare: ${c('dim', fmtPrice(d.oldSale))}  → ${c('cyan',  fmtPrice(d.newSale))}`);
    });
    diff.added.forEach(p   => console.log(c('green', `  ✚ NOU:       ${p.name}`)));
    diff.removed.forEach(p => console.log(c('red',   `  ✖ DISPĂRUT:  ${p.name}`)));
  } else if (diff) {
    console.log(c('dim', '\n  ✓ Nicio modificare față de ultima verificare.'));
  }
  console.log();
}

// ── GENERARE RAPORT Markdown ──────────────────────────────────────────────────
function generateReport(products, diff, timestamp) {
  const lines = [
    `# 💰 Virtuoso Price Report`,
    ``,
    `**Pagina:** [seturi-porti](${TARGET_URL})`,
    `**Actualizat:** ${timestamp}`,
    ``,
  ];

  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    lines.push(`## ⚡ Modificări`);
    diff.changed.forEach(d => {
      lines.push(`### ${d.name}`);
      if (d.oldNormal !== d.newNormal)
        lines.push(`- Preț normal: ~~${fmtPrice(d.oldNormal)}~~ → **${fmtPrice(d.newNormal)}**`);
      if (d.oldSale !== d.newSale)
        lines.push(`- Preț vânzare: ~~${fmtPrice(d.oldSale)}~~ → **${fmtPrice(d.newSale)}**`);
    });
    diff.added.forEach(p   => lines.push(`- ✅ **NOU:** ${p.name}`));
    diff.removed.forEach(p => lines.push(`- ❌ **Dispărut:** ${p.name}`));
    lines.push('');
  }

  lines.push(`## 📋 Toate produsele`);
  lines.push(`| Produs | Preț normal | Preț vânzare | Reducere | Stoc |`);
  lines.push(`|--------|------------|--------------|----------|------|`);

  products.forEach(p => {
    const disc    = discount(p.priceNormal, p.priceSale);
    const hasSale = disc !== null;
    const name    = p.name.substring(0, 50);
    const link    = p.href ? `[${name}](${p.href})` : name;
    const pNorm   = fmtPrice(p.priceNormal);
    const pSale   = hasSale ? fmtPrice(p.priceSale) : '—';
    const pDisc   = hasSale ? `-${disc}%` : '—';
    const stock   = p.inStock ? '✅' : '❌';
    lines.push(`| ${link} | ${pNorm} | ${pSale} | ${pDisc} | ${stock} |`);
  });

  return lines.join('\n');
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  // Citește datele anterioare
  let previousData = null;
  if (fs.existsSync(PRICES_FILE)) {
    try {
      const stored = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
      if (stored.products) previousData = stored.products;
    } catch (_) {}
  }

  const timestamp = new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
  console.log(c('dim', `\n📅 ${timestamp}`));

  let products;
  try {
    products = await scrape();
  } catch (err) {
    console.error(c('red', `\n✗ Eroare la scraping: ${err.message}\n`));
    process.exit(1);
  }

  const diff = computeDiff(previousData, products);
  printResults(products, diff);

  // Salvează JSON
  if (saveJSON || watchMode) {
    const payload = {
      timestamp,
      url: TARGET_URL,
      totalProducts: products.length,
      productsOnSale: products.filter(p => discount(p.priceNormal, p.priceSale) !== null).length,
      products,
    };
    fs.writeFileSync(PRICES_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log(c('green', `✓ Salvat în prices.json`));

    // Salvează istoric zilnic
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(HISTORY_DIR, `${dateStr}.json`),
      JSON.stringify(payload, null, 2),
      'utf8'
    );

    // Generează raport Markdown
    const report = generateReport(products, diff, timestamp);
    fs.writeFileSync(REPORT_FILE, report, 'utf8');
    console.log(c('green', `✓ Raport salvat în report.md`));
  }

  if (watchMode) {
    const mins = 60;
    console.log(c('dim', `\n⏰ Urmărire activă. Verificare din nou în ${mins} minute…\n`));
    setTimeout(run, mins * 60 * 1000);
  }
}

run();
