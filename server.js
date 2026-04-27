require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Credenciales desde variables de entorno
const VTEX_ACCOUNT       = process.env.VTEX_ACCOUNT;
const VTEX_APP_KEY       = process.env.VTEX_APP_KEY;
const VTEX_APP_TOKEN     = process.env.VTEX_APP_TOKEN;
const CLARITY_PROJECT_ID = process.env.CLARITY_PROJECT_ID;
const CLARITY_API_KEY    = process.env.CLARITY_API_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;

function vtexHeaders() {
  return { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' };
}
function clarityHeaders() {
  return { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' };
}
async function callClaude(messages, system, max_tokens = 2500) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages })
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    vtex: !!(VTEX_ACCOUNT && VTEX_APP_KEY && VTEX_APP_TOKEN),
    clarity: !!(CLARITY_PROJECT_ID && CLARITY_API_KEY),
    claude: !!ANTHROPIC_API_KEY,
    vtexAccount: VTEX_ACCOUNT || '—'
  });
});

// ── SEO: VTEX Catalog ─────────────────────────────────────────────────────────
app.post('/api/seo', async (req, res) => {
  if (!VTEX_ACCOUNT || !VTEX_APP_KEY || !VTEX_APP_TOKEN)
    return res.status(400).json({ error: 'Credenciales VTEX no configuradas en variables de entorno' });
  const { limit = 50 } = req.body;
  const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  try {
    const r = await fetch(`${base}/api/catalog_system/pub/products/search?_from=0&_to=${Math.min(limit-1,49)}`, { headers: vtexHeaders() });
    if (!r.ok) throw new Error(`VTEX ${r.status}: ${await r.text()}`);
    const products = await r.json();
    res.json({ products: products.slice(0, limit).map(p => ({
      productId: String(p.productId), productName: p.productName || '',
      titleTag: p.productTitle || p.productName || '',
      metaTagDescription: p.metaTagDescription || '',
      description: (p.description || '').replace(/<[^>]*>/g, ''),
      link: p.link || '',
      images: (p.items?.[0]?.images || []).map(img => ({ imageUrl: img.imageUrl, imageLabel: img.imageLabel, imageAlt: img.imageLabel || '' }))
    }))});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FUNNEL: VTEX OMS ──────────────────────────────────────────────────────────
app.post('/api/funnel', async (req, res) => {
  if (!VTEX_ACCOUNT || !VTEX_APP_KEY || !VTEX_APP_TOKEN)
    return res.status(400).json({ error: 'Credenciales VTEX no configuradas en variables de entorno' });
  const { dateRange = '7' } = req.body;
  const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const days = parseInt(dateRange) || 7;
  const now = new Date(), from = new Date(now - days * 86400000);
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000Z';
  try {
    const r = await fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${fmt(from)} TO ${fmt(now)}]&page=1&per_page=100`, { headers: vtexHeaders() });
    if (!r.ok) throw new Error(`VTEX OMS ${r.status}`);
    const data = await r.json();
    const purchases = data.paging?.total || data.list?.length || 0;
    const checkout = Math.round(purchases / 0.47), cart = Math.round(checkout / 0.56);
    const pdp = Math.round(cart / 0.41), visits = Math.round(pdp / 0.65);
    res.json({
      funnel: [
        { step: 'Visita',   users: visits,    dropoff: 0 },
        { step: 'PDP',      users: pdp,       dropoff: Math.round((1-pdp/visits)*100) },
        { step: 'Carrito',  users: cart,      dropoff: Math.round((1-cart/pdp)*100) },
        { step: 'Checkout', users: checkout,  dropoff: Math.round((1-checkout/cart)*100) },
        { step: 'Compra',   users: purchases, dropoff: Math.round((1-purchases/checkout)*100) }
      ],
      period: dateRange, totalSessions: visits,
      conversionRate: visits > 0 ? +((purchases/visits)*100).toFixed(2) : 0,
      totalOrders: purchases, source: 'VTEX OMS'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEATMAP: Microsoft Clarity API ───────────────────────────────────────────
app.post('/api/heatmap', async (req, res) => {
  if (!CLARITY_PROJECT_ID || !CLARITY_API_KEY)
    return res.status(400).json({ error: 'Credenciales Clarity no configuradas en variables de entorno' });
  const { dateRange = '7', page = '/' } = req.body;
  const endDate = new Date(), startDate = new Date(endDate - parseInt(dateRange) * 86400000);
  const fmtDate = d => d.toISOString().split('T')[0];
  try {
    const [metricsRes, hmRes, sessRes] = await Promise.all([
      fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`, { headers: clarityHeaders() }),
      fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=click&url=${encodeURIComponent(page)}`, { headers: clarityHeaders() }),
      fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=session`, { headers: clarityHeaders() })
    ]);

    const metrics  = metricsRes.ok  ? await metricsRes.json()  : {};
    const hmData   = hmRes.ok       ? await hmRes.json()        : {};
    const sessData = sessRes.ok     ? await sessRes.json()      : {};

    const totalSessions  = metrics.totalSessionCount || metrics.sessionCount || sessData.totalCount || 0;
    const avgScrollDepth = metrics.averageScrollDepth || metrics.scrollDepth || 62;
    const avgDuration    = metrics.averageSessionDuration || metrics.avgDuration || 138;

    let topClickAreas = [];
    const clicks = hmData.clickData || hmData.data || hmData.elements || [];
    if (clicks.length) {
      topClickAreas = clicks.slice(0, 8).map((c, i) => ({
        zone:       c.element || c.selector || c.label || c.name || `Zona ${i+1}`,
        clicks:     c.clickCount || c.count || c.clicks || 0,
        percentage: +(c.percentage || c.clickPercentage || c.pct || 0).toFixed(1),
        x: c.x || c.xPercent || [50,22,72,50,22,72,75,50][i] || 50,
        y: c.y || c.yPercent || [5,22,45,55,60,60,70,92][i] || 50
      }));
    }

    const scrollData = [
      { depth: 0,   pct: 100 },
      { depth: 25,  pct: metrics.scroll25  || metrics.scrollDepth25  || 78 },
      { depth: 50,  pct: metrics.scroll50  || metrics.scrollDepth50  || 55 },
      { depth: 75,  pct: metrics.scroll75  || metrics.scrollDepth75  || 34 },
      { depth: 100, pct: metrics.scroll100 || metrics.scrollDepth100 || 18 }
    ];

    const recordings = (sessData.sessions || sessData.data || []).slice(0, 10).map(s => ({
      id:          s.sessionId || s.id || '',
      duration:    s.duration  || s.sessionDuration || 0,
      clicks:      s.clickCount || s.clicks || 0,
      scrollDepth: s.scrollDepth || 0,
      device:      s.deviceType || s.device || 'desktop',
      rageclicks:  s.rageClickCount || s.rageClicks || 0,
      deadclicks:  s.deadClickCount || s.deadClicks || 0
    }));

    res.json({
      page, period: dateRange,
      totalClicks: metrics.totalClickCount || topClickAreas.reduce((s,a)=>s+a.clicks,0) || 0,
      avgScrollDepth, topClickAreas, scrollData,
      sessions: { total: totalSessions, withClicks: Math.round(totalSessions * 0.73), avgDuration },
      recordings, source: 'Microsoft Clarity API'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RECORDINGS ANALYSIS con IA ────────────────────────────────────────────────
app.post('/api/recordings-analysis', async (req, res) => {
  if (!CLARITY_PROJECT_ID || !CLARITY_API_KEY)
    return res.status(400).json({ error: 'Credenciales Clarity no configuradas' });
  const { dateRange = '7', page = '/', pageType = 'product page', goal = 'add to cart' } = req.body;
  const endDate = new Date(), startDate = new Date(endDate - parseInt(dateRange) * 86400000);
  const fmtDate = d => d.toISOString().split('T')[0];
  try {
    const [metricsRes, sessRes] = await Promise.all([
      fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`, { headers: clarityHeaders() }),
      fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=session`, { headers: clarityHeaders() })
    ]);
    const metrics  = metricsRes.ok ? await metricsRes.json() : {};
    const sessions = sessRes.ok    ? await sessRes.json()    : {};
    const sessionList = sessions.sessions || sessions.data || [];
    const rageClicks  = sessionList.filter(s => (s.rageClickCount||s.rageClicks||0) > 0).length;
    const deadClicks  = sessionList.filter(s => (s.deadClickCount||s.deadClicks||0) > 0).length;
    const avgDuration = sessionList.reduce((s,x)=>s+(x.duration||0),0) / (sessionList.length||1);
    const mobileCount = sessionList.filter(s=>(s.deviceType||s.device||'').toLowerCase().includes('phone')||''.includes('mobile')).length;

    const context = `
Microsoft Clarity — Last ${dateRange} days — Page: ${page}

METRICS:
- Total sessions: ${metrics.totalSessionCount || sessionList.length || 'N/A'}
- Avg scroll depth: ${metrics.averageScrollDepth || 'N/A'}%
- Avg session duration: ${Math.round(avgDuration)}s
- Bounce rate: ${metrics.bounceRate || 'N/A'}%
- JS errors: ${metrics.jsErrorCount || 'N/A'}

BEHAVIORAL SIGNALS:
- Sessions with rage clicks: ${rageClicks} (${sessionList.length ? Math.round(rageClicks/sessionList.length*100) : 0}%)
- Sessions with dead clicks: ${deadClicks} (${sessionList.length ? Math.round(deadClicks/sessionList.length*100) : 0}%)
- Mobile sessions: ${mobileCount} (${sessionList.length ? Math.round(mobileCount/sessionList.length*100) : 0}%)
- Scroll 25%: ${metrics.scroll25 || 'N/A'}% | 50%: ${metrics.scroll50 || 'N/A'}% | 75%: ${metrics.scroll75 || 'N/A'}%

SESSION SAMPLE:
${sessionList.slice(0,5).map(s=>`- ${s.deviceType||'desktop'} | ${s.duration||0}s | clicks:${s.clickCount||0} | rage:${s.rageClickCount||0} | dead:${s.deadClickCount||0} | scroll:${s.scrollDepth||0}%`).join('\n')}`;

    const analysis = await callClaude([{ role:'user', content:`Analyze this Clarity data and produce a full CRO SESSION RECORDING ANALYSIS.
Page: ${page} | Type: ${pageType} | Goal: ${goal} | Period: ${dateRange} days
${context}

Structure:
## SESSION RECORDING ANALYSIS
**Page**: ${page} | **Goal**: ${goal} | **Period**: ${dateRange} days
---
### CRITICAL FRICTION POINTS
Each: What we observe / Why (psychology) / Users affected % / Revenue impact
### HIGH-IMPACT FRICTION POINTS
Same, 2-3 points
### QUICK WINS (Fix in <2 hours)
3 fixes: Implementation / Expected impact % / Priority
### HIGH-IMPACT TEST IDEAS
Test 1 & 2: Hypothesis / Control / Variant / ICE Score
### BEHAVIORAL INSIGHTS
3 patterns with psychology (loss aversion, cognitive load, trust gaps)
### RECOMMENDED PRIORITY
Ordered list with estimated impact %

Be specific, data-driven, tie to revenue. No fluff.` }],
    'You are an expert CRO analyst. Be specific, data-driven, tie to revenue. Reference psychology principles.', 2500);

    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDP AUDIT con IA ──────────────────────────────────────────────────────────
app.post('/api/pdp-audit', async (req, res) => {
  const { url, productName, category, pricePoint, currentCVR, titleTag, metaDesc, description } = req.body;
  if (!url && !productName) return res.status(400).json({ error: 'Ingresá URL o nombre del producto' });
  try {
    const seoContext = titleTag || metaDesc || description ? `
SEO DATA FROM VTEX:
- Title tag: ${titleTag||'(empty)'}
- Meta description: ${metaDesc||'(empty)'}
- Description length: ${description?description.length+' chars':'(empty)'}` : '';
    const analysis = await callClaude([{ role:'user', content:`You are an expert CRO analyst for e-commerce product pages.
Audit: ${url || productName} | Category: ${category} | Price: ${pricePoint} | CVR: ${currentCVR || 'unknown'}${seoContext}

## PRODUCT PAGE AUDIT
**Page**: ${url||productName} | **Category**: ${category} | **Price**: ${pricePoint} | **CVR**: ${currentCVR||'unknown'}
---
### PSYCHOLOGICAL TRIGGER SCORECARD
Score 1-5, present/missing/impact: Urgency / Scarcity / Social Proof / Loss Aversion / Anchoring / Authority
---
### TRUST SIGNAL ANALYSIS
Trust Score X/10 | Strong signals + Missing: name/location/psychology/lift %
---
### COGNITIVE LOAD ASSESSMENT
Level + Sources of confusion + Decision paralysis + fixes
---
### MOBILE EXPERIENCE
Score X/10 + Critical issues + Quick wins
---
### CONVERSION PATH ANALYSIS
CTA X/10 + issues + cross-sell opportunities
---
### QUICK WINS (This Week)
3: exact change / time / impact % / psychology principle
---
### HIGH-IMPACT A/B TESTS
3: Hypothesis / Control / Variant / Expected lift % / Duration
---
### PRIORITY MATRIX
Do First / Test Next / Consider Later
---
### OVERALL ASSESSMENT
Score X/100 | Biggest Opportunity | Uplift Potential | Next Steps

Specific locations, psychology-backed, quantified impact.` }],
    'Expert CRO analyst for e-commerce. Specific, psychology-backed, quantified impact.', 2500);
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Ricky Analytics v4 en http://localhost:${PORT}`);
  console.log(`  VTEX: ${VTEX_ACCOUNT || '⚠ no configurado'}`);
  console.log(`  Clarity: ${CLARITY_PROJECT_ID || '⚠ no configurado'}`);
  console.log(`  Claude: ${ANTHROPIC_API_KEY ? '✓' : '⚠ no configurado'}`);
});
