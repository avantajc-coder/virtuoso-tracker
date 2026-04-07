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

    // Redirecționează console.log din pagină în Node terminal
    page.on('console', msg => {
      if (msg.type() === 'log') console.log('  [browser]', msg.text());
    });

    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ro-RO,ro;q=0.9' });

    console.log('⏳ Se încarcă pagina…');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await new Promise(r => setTimeout(r, 6000));
    let title = await page.title();
    console.log(`   Titlu: "${title}"`);
    if (/one moment|just a moment|checking|cloudflare/i.test(title)) {
      console.log('   Cloudflare activ, mai așteptăm 12s…');
      await new Promise(r => setTimeout(r, 12000));
      title = await page.title();
      console.log(`   Titlu după așteptare: "${title}"`);
    }

    // Scroll
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

    // ── DIAGNOSTIC COMPLET ──────────────────────────────────────────────────
    const diag = await page.evaluate(() => {
      const count = sel => document.querySelectorAll(sel).length;
      const texts = sel => Array.from(document.querySelectorAll(sel)).slice(0,2)
        .map(e => e.textContent.trim().replace(/\s+/g,' ').substring(0,80));

      // Încearcă toți selectorii posibili de container
      const containers = {
        '.product-thumb':       count('.product-thumb'),
        '.innerprod':           count('.innerprod'),
        '.box-feature-prod':    count('.box-feature-prod'),
        '.product_info':        count('.product_info'),
        '[class*="product-thumb"]': count('[class*="product-thumb"]'),
        '[class*="innerprod"]': count('[class*="innerprod"]'),
        '[class*="productname"]': count('[class*="productname"]'),
        '.productname':         count('.productname'),
        '[class*="numeprod"]':  count('[class*="numeprod"]'),
        '.numeproduscart':      count('.numeproduscart'),
        '.priceprodold':        count('.priceprodold'),
        '.priceprodspecial':    count('.priceprodspecial'),
      };

      // Ia HTML-ul primului .priceprodold și 5 niveluri de parinti
      let ancestorChain = '';
      const firstPrice = document.querySelector('.priceprodold');
      if (firstPrice) {
        let el = firstPrice;
        const levels = [];
        for (let i = 0; i < 8; i++) {
          const tag = el.tagName;
          const cls = (el.className || '').toString().trim().replace(/\s+/g,' ');
          const id  = el.id ? `#${el.id}` : '';
          levels.push(`${'  '.repeat(i)}↑ <${tag} class="${cls}" ${id}>`);
          if (!el.parentElement || el === document.body) break;
          el = el.parentElement;
        }
        ancestorChain = levels.join('\n');
      }

      // HTML complet al primului .priceprodspecial + fratii lui
      let sampleHTML = '';
      const firstSpec = document.querySelector('.priceprodspecial');
      if (firstSpec && firstSpec.parentElement) {
        sampleHTML = firstSpec.parentElement.outerHTML.substring(0, 500);
      }

      return {
        containers,
        ancestorChain,
        sampleHTML,
        bodyLen: document.body.innerHTML.length,
        title: document.title,
        firstProductNameText: texts('.productname'),
        firstPriceOldText:    texts('.priceprodold'),
        firstPriceSpecText:   texts('.priceprodspecial'),
      };
    });

    console.log(`\n📊 DIAGNOSTIC:`);
    console.log(`   Titlu final: "${diag.title}" | Body: ${diag.bodyLen} bytes`);
    console.log(`\n   Containere găsite:`);
    Object.entries(diag.containers).forEach(([k,v]) => console.log(`     ${k}: ${v}`));
    console.log(`\n   Texte .productname:      ${JSON.stringify(diag.firstProductNameText)}`);
    console.log(`   Texte .priceprodold:     ${JSON.stringify(diag.firstPriceOldText)}`);
    console.log(`   Texte .priceprodspecial: ${JSON.stringify(diag.firstPriceSpecText)}`);
    console.log(`\n   Lanț parinti de la primul .priceprodold:\n${diag.ancestorChain}`);
    console.log(`\n   HTML parinte .priceprodspecial:\n${diag.sampleHTML}`);

    // ── EXTRAGERE: pornește de la .priceprodspecial și urcă la container ───
    const products = await page.evaluate(() => {
      const parseP = str => {
        if (!str) return null;
        const c = str.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = parseFloat(c);
        return isNaN(n) || n < 100 ? null : n;
      };

      const results = [];
      const seenNames = new Set();

      // Ia fiecare element .priceprodspecial sau .priceprodnormal ca punct de start
      const priceNodes = Array.from(document.querySelectorAll('.priceprodspecial, .priceprodnormal'));
      console.log('priceNodes count:', priceNodes.length);

      priceNodes.forEach((priceNode, idx) => {
        // Urcă prin DOM până găsim un element care conține și un titlu de produs
        let el = priceNode;
        let container = null;

        for (let i = 0; i < 15; i++) {
          el = el.parentElement;
          if (!el || el === document.body) break;

          // Verifică dacă acest element are un .productname sau .numeproduscart
          const hasName = el.querySelector('.productname, .numeproduscart, [class*="productname"], [class*="numeprod"]');
          if (hasName) {
            container = el;
            break;
          }
        }

        if (!container) {
          console.log(`idx ${idx}: nu s-a găsit container cu productname`);
          return;
        }

        const nameEl = container.querySelector('.productname, .numeproduscart, [class*="productname"]');
        const linkEl = container.querySelector('a[href]');
        const name   = (nameEl?.textContent || linkEl?.textContent || '').trim().replace(/\s+/g, ' ');

        if (!name || seenNames.has(name)) return;
        seenNames.add(name);

        const href = linkEl?.href || '';

        const priceNormal = parseP(container.querySelector('.priceprodold')?.textContent);
        const priceSale   = parseP(container.querySelector('.priceprodspecial')?.textContent)
                         ?? parseP(container.querySelector('.priceprodnormal')?.textContent);

        console.log(`produs: "${name.substring(0,40)}" | normal=${priceNormal} | sale=${priceSale}`);

        if (priceNormal == null && priceSale == null) return;

        results.push({ name, href, sku: '', priceNormal, priceSale, inStock: true });
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
  const onSale     = products.filter(p => discount(p.priceNormal, p.priceSale) !== null);
  const salePrices = onSale.map(p => p.priceSale).filter(Boolean);
  const discounts  = products.map(p => discount(p.priceNormal, p.priceSale)).filter(Boolean);
  console.log('─'.repeat(70));
  console.log(`  Total: ${products.length}  |  Cu reducere: ${onSale.length}`);
  if (salePrices.length) {
    console.log(`  Preț minim: ${fmtPrice(Math.min(...salePrices))}  |  Reducere max: ${Math.max(...discounts)}%`);
  }
  if (diff?.changed.length || diff?.added.length || diff?.removed.length) {
    console.log('\n  ⚡ MODIFICĂRI:');
    diff.changed.forEach(d => {
      console.log(`  • ${d.name}`);
      if (d.oldNormal !== d.newNormal) console.log(`    Normal:  ${fmtPrice(d.oldNormal)} → ${fmtPrice(d.newNormal)}`);
      if (d.oldSale   !== d.newSale)   console.log(`    Vânzare: ${fmtPrice(d.oldSale)} → ${fmtPrice(d.newSale)}`);
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
    `**Pagina:** [seturi-porti](${TARGET_URL})`,
    `**Actualizat:** ${timestamp}`,
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
    lines.push(`| ${link} | ${fmtPrice(p.priceNormal)} | ${disc ? fmtPrice(p.priceSale) : '—'} | ${disc ? `-${disc}%` : '—'} | ✅ |`);
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
