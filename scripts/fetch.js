const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const rssParser = new Parser({ timeout: 10000 });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const MIN_PROJECTS = 3;
const RETRY_DELAY_MS = 12 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const CITIES = {
  milwaukee: {
    name: 'Milwaukee, WI',
    radius: '50 miles',
    dataFile: 'data/milwaukee.json',
    recipients: (process.env.MKE_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean),
    feeds: [
      { url: 'https://urbanmilwaukee.com/feed/', name: 'Urban Milwaukee' },
      { url: 'https://biztimes.com/feed/', name: 'BizTimes Milwaukee' },
      { url: 'https://wisbusiness.com/feed/', name: 'WisBusiness' },
    ],
  },
  madison: {
    name: 'Madison, WI',
    radius: '40 miles',
    dataFile: 'data/madison.json',
    recipients: (process.env.MSN_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean),
    feeds: [
      { url: 'https://madison.com/feed/', name: 'Wisconsin State Journal' },
      { url: 'https://wisbusiness.com/feed/', name: 'WisBusiness' },
      { url: 'https://www.channel3000.com/feed/', name: 'WISC-TV News' },
    ],
  },
  fortlauderdale: {
    name: 'Fort Lauderdale, FL',
    radius: '30 miles',
    dataFile: 'data/fortlauderdale.json',
    recipients: (process.env.FLL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean),
    feeds: [
      { url: 'https://therealdeal.com/miami/feed/', name: 'The Real Deal South Florida' },
      { url: 'https://www.sun-sentinel.com/arcio/rss/', name: 'Sun Sentinel' },
      { url: 'https://southfloridabusinessjournal.com/feed/', name: 'South Florida Business Journal' },
    ],
  },
};

async function fetchArticles(feeds) {
  const articles = [];
  for (const feed of feeds) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      const recent = (parsed.items || []).slice(0, 25);
      recent.forEach(item => {
        articles.push({
          title: item.title || '',
          snippet: (item.contentSnippet || item.summary || '').slice(0, 400),
          link: item.link || '',
          date: item.pubDate || '',
          source: feed.name,
        });
      });
      console.log(`  ${feed.name}: ${recent.length} articles`);
    } catch (err) {
      console.warn(`  Could not fetch ${feed.name}: ${err.message}`);
    }
  }
  return articles;
}

async function callGemini(articles, cityName, radius) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const articleText = articles.slice(0, 30).map((a, i) =>
    `[${i}] SOURCE: ${a.source}\nTITLE: ${a.title}\nSNIPPET: ${a.snippet}\nDATE: ${a.date}\nURL: ${a.link}`
  ).join('\n\n---\n\n');

  const prompt = `You are a development intelligence assistant for an architecture firm with an office in ${cityName}.

Review these news articles and extract real estate development or construction projects within ~${radius} of ${cityName}.

INCLUDE only:
- New ground-up buildings: residential 5+ units OR commercial 3,000+ sqft
- Master plans or large mixed-use development proposals
- Major building renovations that went through a public approval process
- Projects with a clear milestone: municipal approval, permit filing, groundbreaking, public release, grand opening

EXCLUDE:
- Single-family homes or small residential under 5 units
- Small commercial under 3,000 sqft
- General business/financial news without a specific construction project
- Projects clearly outside ${radius} of ${cityName}
- Opinion pieces, market reports, or trend articles without a named project

Return ONLY a raw JSON object, no markdown, no backticks:

{
  "projects": [
    {
      "name": "Project or development name",
      "type": "ground-up" | "renovation" | "master-plan",
      "location": "Neighborhood, City, State",
      "status": "Plan Commission approved | Permits filed | Groundbreaking | Public review open | Grand opening | Unanimously approved | Announced",
      "developer": "Developer or owner name, or null if not mentioned",
      "architect": "Architecture firm name, or null if not mentioned",
      "scale": "e.g. 120 units · 15,000 sqft retail",
      "summary": "2-3 sentences. Plain English. What is being built, where, and why it matters.",
      "source": "Publication name",
      "date": "Mon DD, YYYY",
      "link": "Full article URL"
    }
  ]
}

If no qualifying projects found, return: {"projects":[]}

ARTICLES:
${articleText}`;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Gemini timed out after 90s')), 90000)
  );
  const result = await Promise.race([model.generateContent(prompt), timeout]);
  const text = result.response.text().trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text).projects || [];
}

async function extractProjects(articles, cityName, radius) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`  Gemini attempt ${attempt} of ${MAX_ATTEMPTS}...`);
      return await callGemini(articles, cityName, radius);
    } catch (err) {
      console.error(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`  Waiting 12 minutes before retry...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  console.error('All Gemini attempts exhausted.');
  return [];
}

function buildEmailHTML(projects, editionDate, cityName) {
  const TYPE = {
    'ground-up':   { label: 'Ground-Up',   bg: '#E1F5EE', tc: '#085041', bc: '#1D9E75' },
    'renovation':  { label: 'Renovation',  bg: '#FAEEDA', tc: '#633806', bc: '#BA7517' },
    'master-plan': { label: 'Master plan', bg: '#E6F1FB', tc: '#0C447C', bc: '#378ADD' },
  };

  const cards = projects.slice(0, 8).map(p => {
    const t = TYPE[p.type] || TYPE['ground-up'];
    return `
    <div style="background:#ffffff;border:1px solid #e5e5e5;border-left:3px solid ${t.bc};border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;">
        <span style="background:${t.bg};color:${t.tc};font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:0.5px;">${t.label}</span>
        <span style="font-size:11px;color:#999;text-align:right;max-width:140px;line-height:1.4;">${p.status || ''}</span>
      </div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:400;color:#1a1a1a;margin-bottom:3px;line-height:1.3;">${p.name}</div>
      <div style="font-size:12px;color:#777;margin-bottom:6px;">${p.location}</div>
      <div style="display:inline-block;font-size:11px;font-weight:500;background:${t.bg};color:${t.tc};padding:2px 9px;border-radius:4px;margin-bottom:10px;">${p.scale || ''}</div>
      ${(p.developer || p.architect) ? `
      <div style="font-size:11px;color:#777;margin-bottom:8px;line-height:1.8;">
        ${p.developer ? `<span style="font-weight:500;color:#555;">Developer:</span> ${p.developer}<br>` : ''}
        ${p.architect ? `<span style="font-weight:500;color:#555;">Architect:</span> ${p.architect}` : ''}
      </div>` : ''}
      <div style="font-size:13px;color:#555;line-height:1.65;border-top:1px solid #f0f0f0;padding-top:10px;margin-bottom:10px;">${p.summary}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:#aaa;">${p.source} &middot; ${p.date || ''}</span>
        ${p.link ? `<a href="${p.link}" style="font-size:11px;color:#1D9E75;text-decoration:none;font-weight:500;">Read more &rarr;</a>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f6f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="height:3px;background:#1D9E75;border-radius:2px;margin-bottom:24px;"></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
      <div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:400;color:#1a1a1a;letter-spacing:0.5px;line-height:1;">Groundwork</div>
        <div style="font-size:10px;color:#aaa;letter-spacing:2.5px;text-transform:uppercase;margin-top:5px;font-weight:300;">${cityName} development intelligence</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:10px;color:#1D9E75;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;">New edition</div>
        <div style="font-size:14px;font-weight:500;color:#1a1a1a;margin-top:3px;">${editionDate}</div>
      </div>
    </div>
    <div style="border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;padding:9px 0;margin-bottom:20px;font-size:12px;color:#888;">
      ${projects.length} new projects &nbsp;&middot;&nbsp; ${cityName} &nbsp;&middot;&nbsp; Auto-updated
    </div>
    ${cards}
    <div style="text-align:center;padding:20px 0 8px;">
      <a href="https://devanrinka.github.io/groundwork-mke" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:11px 28px;border-radius:6px;font-size:13px;font-weight:500;">View full edition &rarr;</a>
    </div>
    <div style="text-align:center;font-size:11px;color:#bbb;margin-top:16px;padding-bottom:8px;">
      Groundwork &middot; ${cityName} &middot; Auto-generated development intelligence
    </div>
  </div>
</body>
</html>`;
}

async function processCity(cityKey, city) {
  console.log(`\n--- Processing ${city.name} ---`);

  const articles = await fetchArticles(city.feeds);
  console.log(`Total articles: ${articles.length}`);

  if (!articles.length) {
    console.log('No articles. Skipping.');
    return;
  }

  const projects = await extractProjects(articles, city.name, city.radius);
  console.log(`Qualifying projects: ${projects.length}`);

  if (projects.length < MIN_PROJECTS) {
    console.log(`Below threshold of ${MIN_PROJECTS}. No edition sent.`);
    return;
  }

  const dataPath = path.join(__dirname, '..', city.dataFile);
  let data = { editions: [] };
  if (fs.existsSync(dataPath)) {
    try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch {}
  }

  const now = new Date();
  const editionDate = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  data.editions = [
    { date: now.toISOString(), editionDate, projectCount: projects.length, projects },
    ...data.editions,
  ].slice(0, 12);

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log(`${city.dataFile} updated`);

  if (!city.recipients.length) {
    console.log('No recipients configured. Skipping email.');
    return;
  }

  const html = buildEmailHTML(projects, editionDate, city.name);
  const { error } = await resend.emails.send({
    from: 'Groundwork <onboarding@resend.dev>',
    to: city.recipients,
    subject: `Groundwork · ${city.name} · ${editionDate} · ${projects.length} new projects`,
    html,
  });

  if (error) {
    console.error('Email error:', error);
  } else {
    console.log(`Email sent to ${city.recipients.join(', ')}`);
  }
}

async function run() {
  console.log('=== Groundwork update starting ===');
  for (const [key, city] of Object.entries(CITIES)) {
    await processCity(key, city);
  }
  console.log('\n=== Done ===');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
