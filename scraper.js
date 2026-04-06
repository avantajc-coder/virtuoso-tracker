/**
 * scraper.js — Virtuoso Price Tracker
 * Dacă nu găsește produse, salvează debug-page.html + debug-screenshot.png
 * ca să poți inspecta structura HTML reală a paginii.
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

const TARGET_URL   = 'https://www.virtuoso.ro/modele-porti-metalice-aluminiu/seturi-porti';
const PRICES_FILE  = path.join(__dirname, 'prices.json');
const HISTORY_DIR  = path.join(__dirname, 'history');
const REPORT_FILE  = path.join(__dirname, 'report.md');
const DEBUG_HTML   = path.join(__dirname, 'debug-page.html');
const DEBUG_PNG    = path.join(__dirname, 'debug-screenshot.png');

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

    // Închide cookie banner
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, div'));
        const accept = btns.find(el =>
          /accept|accepta|acept|agree|ok|continua|inchide/i.test(el.textContent) &&
          /cookie|gdpr|consent/i.test(el.closest('[class],[id]')?.className + el.closest('[class],[id]')?.id || '')
        );
        if (accept) accept.click();
      });
      await new Promise(r => setTimeout(r, 800));
    } catch (_) {}

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

    // ── DETECTARE AUTOMATĂ structură HTML ─────────────────────────────────────
    const { products, debugInfo } = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      // ── 1. Găsește containerele de produse ──────────────────────────────────
      // Strategie: caută elemente care conțin ATÂT un link spre produs CÂT ȘI un preț
      const priceKeywords = /price|pret|pret|cost/i;
      const productKeywords = /product|item|miniature|card/i;

      // Colectează toate elementele cu clase relevante
      const allElements = Array.from(document.querySelectorAll('*'));
      const candidateMap = new Map();

      allElements.forEach(el => {
        const cls = (el.className || '') + ' ' + (el.id || '');
        if (productKeywords.test(cls) || el.tagName === 'ARTICLE' || el.tagName === 'LI') {
          const hasLink  = el.querySelector('a[href*="porti"], a[href*="set-"]') !== null;
          const hasPrice = Array.from(el.querySelectorAll('*')).some(c =>
            priceKeywords.test(c.className || '') && parseP(c.textContent) !== null
          );
          if (hasLink && hasPrice && !candidateMap.has(el)) {
            candidateMap.set(el, true);
          }
        }
      });

      let items = Array.from(candidateMap.keys());

      // Filtrare: păstrează doar elementele la cel mai mic nivel (nu părinți care conțin alți candidați)
      items = items.filter(el =>
        !items.some(other => other !== el && el.contains(other))
      );

      // ── Debug info ──────────────────────────────────────────────────────────
      const debugInfo = {
        totalCandidates: items.length,
        sampleClasses: items.slice(0, 3).map(el => ({
          tag: el.tagName,
          class: el.className.substring(0, 120),
          id: el.id,
        })),
        // Snapshot claselor elementelor cu "price" în HTML
        priceClasses: Array.from(new Set(
          Array.from(document.querySelectorAll('[class*="price"],[class*="pret"]'))
            .map(el => el.className.toString().trim().substring(0, 80))
        )).slice(0, 20),
        pageTitle: document.title,
      };

      if (items.length === 0) {
        return { products: [], debugInfo };
      }

      // ── 2. Extrage datele din fiecare container ──────────────────────────────
      const products = [];

      items.forEach(item => {
        // Titlu
        const titleEl = item.querySelector([
          'h1','h2','h3','h4','h5',
          '[class*="title"]', '[class*="name"]',
          'a[title]',
        ].join(','));
        const name = (
          titleEl?.getAttribute('title') ||
          titleEl?.textContent || ''
        ).trim().replace(/\s+/g, ' ');
        if (!name) return;

        const href = item.querySelector('a[href]')?.href || '';
        const sku  = (item.querySelector('[class*="reference"],[class*="sku"],[class*="cod"]')?.textContent || '')
                       .replace(/^(Cod|SKU|Ref)[\s:.]+/i, '').trim();

        // Prețuri — găsește TOATE elementele cu numere mari (>100)
        const allPriceEls = Array.from(item.querySelectorAll('*')).filter(el => {
          if (!el.children.length === 0) return false; // preferă noduri frunzà
          const txt = el.textContent.trim();
          return /lei|ron/i.test(txt) || (parseP(txt) !== null && parseP(txt) > 100);
        });

        // Separă după stil (tăiat vs normal)
        let priceNormal = null, priceSale = null;

        // Căutare explicită old/new
        const oldEl = item.querySelector([
          '[class*="regular"]','[class*="old"]','[class*="crossed"]',
          '[class*="before"]','[class*="was"]','del','s','strike',
        ].join(','));
        const newEl = item.querySelector([
          '[class*="current"]','[class*="sale"]','[class*="special"]',
          '[class*="final"]','[class*="promo"]','ins',
        ].join(','));

        if (oldEl) priceNormal = parseP(oldEl.textContent);
        if (newEl) priceSale   = parseP(newEl.textContent);

        // Fallback: toate prețurile din item
        if (priceNormal === null && priceSale === null) {
          const nums = allPriceEls
            .map(el => parseP(el.textContent))
            .filter(n => n !== null);
          const unique = [...new Set(nums)].sort((a,b) => b - a);
          if (unique.length === 1) priceSale   = unique[0];
          if (unique.length >= 2) { priceNormal = unique[0]; priceSale = unique[1]; }
        }

        if (priceNormal == null && priceSale == null) return;

        const inStock = !/(epuizat|indisponibil|out.of.stock)/i.test(
          item.querySelector('[class*="stock"],[class*="stoc"],[class*="availability"]')?.textContent || ''
        );

        products.push({ name, href, sku, priceNormal, priceSale, inStock });
      });

      return { products, debugInfo };
    });

    console.log(`\n📊 Debug info:`);
    console.log(`   Titlu pagină: ${debugInfo.pageTitle}`);
    console.log(`   Candidați găsiți: ${debugInfo.totalCandidates}`);
    console.log(`   Produse extrase: ${products.length}`);
    if (debugInfo.sampleClasses.length) {
      console.log(`   Clase sample containere:`);
      debugInfo.sampleClasses.forEach(s => console.log(`     <${s.tag}> class="${s.class}"`));
    }
    if (debugInfo.priceClasses.length) {
      console.log(`   Clase cu 'price/pret':`);
      debugInfo.priceClasses.forEach(c => console.log(`     "${c}"`));
    }

    // Dacă nu s-au găsit produse → salvează debug HTML + screenshot
    if (products.length === 0) {
      console.log('\n⚠️  0 produse găsite — se salvează debug-page.html și debug-screenshot.png');
      const html = await page.content();
      fs.writeFileSync(DEBUG_HTML, html, 'utf8');
      await page.screenshot({ path: DEBUG_PNG, fullPage: false });
      console.log('   Descarcă artefactele din GitHub Actions → "debug-snapshot" pentru a inspecta HTML-ul.');
    } else {
      // Curăță debug-urile vechi dacă există
      if (fs.existsSync(DEBUG_HTML)) fs.unlinkSync(DEBUG_HTML);
      if (fs.existsSync(DEBUG_PNG))  fs.unlinkSync(DEBUG_PNG);
    }

    return products;

  } finally {
    await browser.close();
  }
}

// ── DIFF ──────────────────────────────────────────────────────────────────────
function computeDiff(oldList, newList) {
  if (!oldList?.length) return { added: [], removed: [], changed: [] };
  const oldMap  = Object.fromEntries(oldList.map(p => [p.name, p]));
  const newNames = new Set(newList.map(p => p.name));
  const added   = newList.filter(p => !oldMap[p.name]);
  const removed = oldList.filter(p => !newNames.has(p.name));
  const changed = [];
  newList.forEach(p => {
    const old = oldMap[p.name];
    if (!old) return;
    if ((old.priceSale ?? old.priceNormal) !== (p.priceSale ?? p.priceNormal) ||
        old.priceNormal !== p.priceNormal) {
      changed.push({
        name: p.name, href: p.href,
        oldNormal: old.priceNormal, newNormal: p.priceNormal,
        oldSale: old.priceSale, newSale: p.priceSale,
      });
    }
  });
  return { added, removed, changed };
}

// ── PRINT ──────────────────────────────────────────────────────────────────────
function printResults(products, diff) {
  console.log('\n' + '═'.repeat(70));
  console.log('  💰  VIRTUOSO · Seturi Porți — Prețuri');
  console.log(`  ${TARGET_URL}`);
  console.log('═'.repeat(70));

  if (!products.length) {
    console.log('\n  ✗ Nu au fost găsite produse.\n');
    return;
  }

  console.log();
  products.forEach(p => {
    const disc    = discount(p.priceNormal, p.priceSale);
    const hasSale = disc !== null;
    console.log(`  ${p.name.substring(0, 60)}`);
    if (hasSale) {
      console.log(`    ${fmtPrice(p.priceNormal)} → ${fmtPrice(p.priceSale)}  -${disc}%  ${p.inStock ? '✓ stoc' : '✗ fără stoc'}`);
    } else {
      console.log(`    ${fmtPrice(p.priceNormal ?? p.priceSale)}  ${p.inStock ? '✓ stoc' : '✗ fără stoc'}`);
    }
    if (p.sku) console.log(`    Cod: ${p.sku}`);
    console.log();
  });

  if (diff && (diff.changed.length || diff.added.length || diff.removed.length)) {
    console.log('⚡ MODIFICĂRI:');
    diff.changed.forEach(d => {
      console.log(`  • ${d.name}`);
      if (d.oldNormal !== d.newNormal) console.log(`    Preț normal:  ${fmtPrice(d.oldNormal)} → ${fmtPrice(d.newNormal)}`);
      if (d.oldSale   !== d.newSale)   console.log(`    Preț vânzare: ${fmtPrice(d.oldSale)}  → ${fmtPrice(d.newSale)}`);
    });
    diff.added.forEach(p   => console.log(`  ✚ NOU: ${p.name}`));
    diff.removed.forEach(p => console.log(`  ✖ DISPĂRUT: ${p.name}`));
  }
}

// ── RAPORT MARKDOWN ───────────────────────────────────────────────────────────
function generateReport(products, diff, timestamp) {
  const lines = [
    `# 💰 Virtuoso Price Report`,
    ``,
    `**Pagina:** [seturi-porti](${TARGET_URL})  `,
    `**Actualizat:** ${timestamp}`,
    ``,
  ];

  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    lines.push(`## ⚡ Modificări față de ziua anterioară`);
    diff.changed.forEach(d => {
      lines.push(`### ${d.name}`);
      if (d.oldNormal !== d.newNormal) lines.push(`- Preț normal: ~~${fmtPrice(d.oldNormal)}~~ → **${fmtPrice(d.newNormal)}**`);
      if (d.oldSale   !== d.newSale)   lines.push(`- Preț vânzare: ~~${fmtPrice(d.oldSale)}~~ → **${fmtPrice(d.newSale)}**`);
    });
    diff.added.forEach(p   => lines.push(`- ✅ **NOU:** ${p.name}`));
    diff.removed.forEach(p => lines.push(`- ❌ **Dispărut:** ${p.name}`));
    lines.push('');
  }

  lines.push(`## 📋 Toate produsele (${products.length})`);
  lines.push(`| Produs | Preț normal | Preț vânzare | Reducere | Stoc |`);
  lines.push(`|--------|------------|--------------|----------|------|`);
  products.forEach(p => {
    const disc  = discount(p.priceNormal, p.priceSale);
    const link  = p.href ? `[${p.name.substring(0,50)}](${p.href})` : p.name.substring(0,50);
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
