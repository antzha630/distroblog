/**
 * Debug Near Protocol date extraction
 */

async function debug() {
  const { chromium } = require('playwright');
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://near.org/blog/nearcon-2026-building-an-ai-economy-without-compromise/', { 
    waitUntil: 'domcontentloaded', 
    timeout: 30000 
  });
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log('Page title:', title);

  const result = await page.evaluate(() => {
    const bodyText = document.body?.textContent || '';
    
    // Check for date patterns
    const janMatch = bodyText.match(/January\s*\d+,?\s*\d{4}/i);
    const febMatch = bodyText.match(/February\s*\d+,?\s*\d{4}/i);
    const publishedMatch = bodyText.match(/Published[^a-zA-Z]*([A-Za-z]+\s*\d+,?\s*\d{4})/i);
    
    // Check JSON-LD
    const jsonLd = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { jsonLd.push(JSON.parse(s.textContent)); } catch(e) {}
    });

    // Check meta
    const metaDates = [];
    document.querySelectorAll('meta').forEach(m => {
      const name = m.getAttribute('name') || m.getAttribute('property') || '';
      const content = m.getAttribute('content') || '';
      if (name.toLowerCase().includes('date') || name.toLowerCase().includes('time') || name.toLowerCase().includes('publish')) {
        metaDates.push({ name, content });
      }
    });

    return {
      bodyLength: bodyText.length,
      janMatch: janMatch ? janMatch[0] : null,
      febMatch: febMatch ? febMatch[0] : null,
      publishedMatch: publishedMatch ? publishedMatch[0] : null,
      metaDates,
      jsonLdCount: jsonLd.length,
      first500: bodyText.substring(0, 500),
    };
  });

  console.log('\nNear Protocol page analysis:');
  console.log('  Body length:', result.bodyLength);
  console.log('  January date match:', result.janMatch);
  console.log('  February date match:', result.febMatch);
  console.log('  "Published" match:', result.publishedMatch);
  console.log('  Meta dates:', result.metaDates);
  console.log('  JSON-LD count:', result.jsonLdCount);
  console.log('  First 500 chars:', result.first500.substring(0, 200) + '...');

  await browser.close();
}

debug().catch(console.error);
