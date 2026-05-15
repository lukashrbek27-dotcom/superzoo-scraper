const { chromium } = require('playwright');
const fs = require('fs');

// Tvůj CJ affiliate base URL pro SuperZoo
const AFFILIATE_BASE = 'https://www.dpbolvw.net/click-101752886-12607708?url=';

const CATEGORIES = [
    // Psi
    { name: 'Granule pro psy', animalType: 'dog', url: 'https://www.superzoo.cz/psi/krmivo-granule/granule/' },
{ name: 'Veterinární diety pro psy', animalType: 'dog', url: 'https://www.superzoo.cz/psi/granule/veterinarni-diety/' },

    // Kočky
    { name: 'Granule pro kočky', animalType: 'cat', url: 'https://www.superzoo.cz/kocky/krmivo-a-pamlsky/granule-pro-kocky/' },
    { name: 'Veterinární diety pro kočky', animalType: 'cat', url: 'https://www.superzoo.cz/kocky/krmivo-a-pamlsky/veterinarni-diety/' },

    // Hlodavci
    { name: 'Plnohodnotné krmivo pro hlodavce', animalType: 'rodent', url: 'https://www.superzoo.cz/drobni-savci/krmivo-a-doplnky-stravy/plnohodnotne-krmivo/' },
    { name: 'Krmivo a pamlsky pro hlodavce', animalType: 'rodent', url: 'https://www.superzoo.cz/drobni-savci/krmivo-a-doplnky-stravy/' },
];

async function scrape() {
    console.log('🚀 Spouštím SuperZoo scraper...');

    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'cs-CZ'
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    const allProducts = [];

    for (const category of CATEGORIES) {
        console.log(`\n📂 ${category.name} (${category.animalType})`);
        console.log(`   ${category.url}`);

        try {
            await page.goto(category.url, {
                waitUntil: 'networkidle',
                timeout: 60000
            });

            console.log('   ⏳ Čekám na produkty...');
            await page.waitForTimeout(3000);

            // Scrollování pro načtení lazy-load obrázků
            console.log('   📜 Scrolluji pro obrázky...');
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 300;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                });
            });

            await page.waitForTimeout(5000);

            const products = await page.evaluate((cat) => {
                const items = [];

                // SuperZoo používá různé selektory — zkusíme více variant
                const selectors = [
                    '.product-item',
                    '.product-list__item',
                    '[class*="product-item"]',
                    '[class*="ProductItem"]',
                    'article',
                ];

                let elements = [];
                for (const sel of selectors) {
                    elements = document.querySelectorAll(sel);
                    if (elements.length > 0) break;
                }

                elements.forEach(el => {
                    // Název
                    const nameEl = el.querySelector('h2, h3, [class*="name"], [class*="title"], [class*="Name"]');
                    const name = nameEl?.innerText?.trim();

                    // Cena
                    const priceEl = el.querySelector('[class*="price"], [class*="Price"], .price');
                    const price = priceEl?.innerText?.trim();

                    // URL produktu
                    const linkEl = el.querySelector('a');
                    const productUrl = linkEl?.href;

                    // Obrázek
                    let image = null;
                    const img = el.querySelector('img');
                    if (img) {
                        image = img.dataset?.src || img.dataset?.lazySrc || img.src;
                    }
                    if (image && (image.includes('data:image') || image.includes('placeholder'))) {
                        image = null;
                    }

                    // Filtr: přeskoč pamlsky, seno, doplňky — chceme jen krmivo/granule
                    const lowerName = (name || '').toLowerCase();
                    const skip = ['pamlsk', 'seno', 'vitamín', 'doplněk', 'minerál', 'olej', 'pasta', 'losos'];
                    if (skip.some(s => lowerName.includes(s))) return;

                    if (name && productUrl) {
                        items.push({
                            name,
                            price: price || null,
                            url: productUrl,
                            image: image || null,
                            category: cat.name,
                            animalType: cat.animalType,
                            scrapedAt: new Date().toISOString()
                        });
                    }
                });

                return items;
            }, category);

            // Přidej affiliate URL ke každému produktu
            const productsWithAffiliate = products.map(p => ({
                ...p,
                affiliateUrl: AFFILIATE_BASE + encodeURIComponent(p.url)
            }));

            console.log(`   ✅ ${productsWithAffiliate.length} produktů`);
            allProducts.push(...productsWithAffiliate);

            await page.waitForTimeout(3000);

        } catch (err) {
            console.log(`   ❌ Chyba: ${err.message}`);
        }
    }

    await browser.close();

    // Odstraň duplicity podle URL
    const unique = [];
    const seen = new Set();
    for (const p of allProducts) {
        if (!seen.has(p.url)) {
            seen.add(p.url);
            unique.push(p);
        }
    }

    const output = {
        scrapedAt: new Date().toISOString(),
        source: 'superzoo.cz',
        affiliate: 'CJ - Mazlíček+',
        totalProducts: unique.length,
        products: unique
    };

    fs.writeFileSync('products.json', JSON.stringify(output, null, 2));
    console.log(`\n🎉 Hotovo! ${unique.length} unikátních produktů uloženo do products.json`);

    const withImages = unique.filter(p => p.image && p.image.startsWith('http')).length;
    const byAnimal = {
        dog: unique.filter(p => p.animalType === 'dog').length,
        cat: unique.filter(p => p.animalType === 'cat').length,
        rodent: unique.filter(p => p.animalType === 'rodent').length,
    };
    console.log(`📸 Produktů s obrázkem: ${withImages}/${unique.length}`);
    console.log(`🐕 Psi: ${byAnimal.dog} | 🐈 Kočky: ${byAnimal.cat} | 🐹 Hlodavci: ${byAnimal.rodent}`);
}

scrape().catch(err => {
    console.error('💥 Chyba:', err.message);
});
