// Script to inspect source websites and analyze their HTML structure
// This helps identify patterns for better title/date/content extraction

const { chromium } = require('playwright');

const sources = [
  { name: 'Fetch.ai', url: 'https://fetch.ai/blog' },
  { name: 'Allora Labs', url: 'https://www.allora.network/blog' },
  { name: 'Giza', url: 'https://www.gizatech.xyz/blog' },
  { name: 'Io.net', url: 'https://io.net/blog' },
  { name: 'Olas Network', url: 'https://olas.network/' },
  { name: 'Sapien', url: 'https://www.sapien.io/blog' }
];

async function inspectSource(source) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Inspecting: ${source.name} - ${source.url}`);
  console.log('='.repeat(80));
  
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for JS to render
    
    const analysis = await page.evaluate(() => {
      const result = {
        url: window.location.href,
        title: document.title,
        articleCards: [],
        datePatterns: [],
        titlePatterns: [],
        structure: {}
      };
      
      // Find all article links
      const links = Array.from(document.querySelectorAll('a[href]'));
      const articleLinks = links.filter(link => {
        const href = link.href;
        return href.includes('/blog/') || 
               href.includes('/post/') || 
               href.includes('/article/') ||
               (href.includes(window.location.hostname) && 
                !href.includes('#') && 
                !href.includes('mailto:') &&
                !href.includes('javascript:'));
      }).slice(0, 5); // Analyze first 5 articles
      
      articleLinks.forEach((link, idx) => {
        const href = link.href;
        const container = link.closest('article, [class*="card"], [class*="post"], div, section, li');
        
        if (container) {
          const card = {
            index: idx + 1,
            url: href,
            containerTag: container.tagName,
            containerClasses: container.className || '',
            containerId: container.id || '',
            title: null,
            titleSource: null,
            date: null,
            dateSource: null,
            description: null,
            descriptionSource: null,
            structure: {}
          };
          
          // Find title
          const titleSelectors = [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            '[class*="title"]',
            '[class*="headline"]',
            '[class*="name"]'
          ];
          
          for (const selector of titleSelectors) {
            const el = container.querySelector(selector);
            if (el && container.contains(el)) {
              const text = el.textContent.trim();
              if (text.length > 10 && text.length < 200) {
                card.title = text;
                card.titleSource = selector;
                break;
              }
            }
          }
          
          // If no title found, try link text
          if (!card.title) {
            const linkText = link.textContent.trim();
            if (linkText.length > 10 && linkText.length < 200) {
              card.title = linkText;
              card.titleSource = 'link text';
            }
          }
          
          // Find date
          const dateSelectors = [
            'time[datetime]',
            'time',
            '[datetime]',
            '[class*="date"]',
            '[class*="time"]',
            '[class*="published"]',
            '[class*="pub-date"]'
          ];
          
          for (const selector of dateSelectors) {
            const el = container.querySelector(selector);
            if (el && container.contains(el)) {
              const datetime = el.getAttribute('datetime') || 
                              el.getAttribute('date') ||
                              el.getAttribute('data-date') ||
                              el.textContent.trim();
              if (datetime) {
                card.date = datetime;
                card.dateSource = selector;
                break;
              }
            }
          }
          
          // Find description
          const descSelectors = [
            '[class*="excerpt"]',
            '[class*="summary"]',
            '[class*="description"]',
            'p'
          ];
          
          for (const selector of descSelectors) {
            const el = container.querySelector(selector);
            if (el && container.contains(el) && el !== link) {
              const text = el.textContent.trim();
              if (text.length > 20 && text.length < 500) {
                card.description = text.substring(0, 200);
                card.descriptionSource = selector;
                break;
              }
            }
          }
          
          // Analyze structure
          card.structure = {
            hasArticleTag: container.tagName === 'ARTICLE',
            hasCardClass: container.className.includes('card'),
            hasPostClass: container.className.includes('post'),
            childElements: Array.from(container.children).map(child => ({
              tag: child.tagName,
              classes: child.className || '',
              hasTitle: !!child.querySelector('h1, h2, h3, [class*="title"]'),
              hasDate: !!child.querySelector('time, [class*="date"]'),
              hasDesc: !!child.querySelector('p, [class*="excerpt"], [class*="summary"]')
            }))
          };
          
          result.articleCards.push(card);
        }
      });
      
      // Analyze common patterns
      if (result.articleCards.length > 0) {
        const firstCard = result.articleCards[0];
        result.structure = {
          commonContainerTag: firstCard.containerTag,
          commonContainerClasses: firstCard.containerClasses,
          titlePattern: firstCard.titleSource,
          datePattern: firstCard.dateSource,
          descriptionPattern: firstCard.descriptionSource
        };
      }
      
      return result;
    });
    
    console.log('\n📄 Page Title:', analysis.title);
    console.log('🔗 Final URL:', analysis.url);
    console.log(`\n📊 Found ${analysis.articleCards.length} article cards to analyze\n`);
    
    analysis.articleCards.forEach((card, idx) => {
      console.log(`\n--- Article ${idx + 1} ---`);
      console.log('URL:', card.url);
      console.log('Container:', `${card.containerTag}${card.containerClasses ? '.' + card.containerClasses.split(' ').join('.') : ''}`);
      console.log('Title:', card.title || '❌ NOT FOUND');
      console.log('  └─ Source:', card.titleSource || 'N/A');
      console.log('Date:', card.date || '❌ NOT FOUND');
      console.log('  └─ Source:', card.dateSource || 'N/A');
      console.log('Description:', card.description ? card.description.substring(0, 100) + '...' : '❌ NOT FOUND');
      console.log('  └─ Source:', card.descriptionSource || 'N/A');
      console.log('\nStructure:');
      console.log('  - Has <article> tag:', card.structure.hasArticleTag);
      console.log('  - Has "card" class:', card.structure.hasCardClass);
      console.log('  - Has "post" class:', card.structure.hasPostClass);
      console.log('  - Child elements:', card.structure.childElements.length);
      card.structure.childElements.forEach((child, i) => {
        console.log(`    ${i + 1}. <${child.tag}>${child.classes ? '.' + child.classes.split(' ').join('.') : ''}`);
        console.log(`       Has title: ${child.hasTitle}, Has date: ${child.hasDate}, Has desc: ${child.hasDesc}`);
      });
    });
    
    console.log('\n\n🎯 RECOMMENDATIONS:');
    if (analysis.structure.titlePattern) {
      console.log(`✅ Use "${analysis.structure.titlePattern}" selector for titles`);
    } else {
      console.log('⚠️  Title pattern unclear - may need custom logic');
    }
    
    if (analysis.structure.datePattern) {
      console.log(`✅ Use "${analysis.structure.datePattern}" selector for dates`);
    } else {
      console.log('⚠️  Date pattern unclear - dates may need text extraction');
    }
    
    if (analysis.structure.descriptionPattern) {
      console.log(`✅ Use "${analysis.structure.descriptionPattern}" selector for descriptions`);
    } else {
      console.log('⚠️  Description pattern unclear');
    }
    
    await page.close();
  } catch (error) {
    console.error(`❌ Error inspecting ${source.name}:`, error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main() {
  console.log('🔍 Starting source inspection...\n');
  
  for (const source of sources) {
    await inspectSource(source);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between sites
  }
  
  console.log('\n✅ Inspection complete!');
}

main().catch(console.error);

