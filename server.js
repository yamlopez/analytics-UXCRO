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
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada en Render → Environment');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s timeout
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `Claude API error ${res.status}`;
      try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch{}
      throw new Error(errMsg);
    }
    const data = await res.json();
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  } catch(e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Timeout: el análisis tardó demasiado. Intentá de nuevo.');
    throw e;
  }
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

// ── FUNNEL: VTEX OMS + comparación + fuentes ─────────────────────────────────
async function fetchFunnelData(fromDate, toDate) {
  const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000Z';

  // Órdenes del período
  const r = await fetch(
    `${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${fmt(fromDate)} TO ${fmt(toDate)}]&page=1&per_page=100`,
    { headers: vtexHeaders() }
  );
  if (!r.ok) throw new Error(`VTEX OMS ${r.status}`);
  const data = await r.json();
  const orders = data.list || [];
  const purchases = data.paging?.total || orders.length || 0;

  // UTM sources desde órdenes (muestra de las primeras 30)
  const sources = {};
  for (const order of orders.slice(0, 30)) {
    try {
      const det = await fetch(`${base}/api/oms/pvt/orders/${order.orderId}`, { headers: vtexHeaders() });
      if (!det.ok) continue;
      const d = await det.json();
      const utm = d.marketingData?.utmSource || d.marketingData?.utmCampaign || d.origin || 'directo';
      sources[utm] = (sources[utm] || 0) + 1;
    } catch { continue; }
  }

  // Funnel estimado
  const checkout = Math.round(purchases / 0.47);
  const cart     = Math.round(checkout  / 0.56);
  const pdp      = Math.round(cart      / 0.41);
  const visits   = Math.round(pdp       / 0.65);

  return {
    purchases, checkout, cart, pdp, visits,
    conversionRate: visits > 0 ? +((purchases/visits)*100).toFixed(2) : 0,
    sources: Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>({source:k,orders:v}))
  };
}

app.post('/api/funnel', async (req, res) => {
  if (!VTEX_ACCOUNT || !VTEX_APP_KEY || !VTEX_APP_TOKEN)
    return res.status(400).json({ error: 'Credenciales VTEX no configuradas en variables de entorno' });

  const { dateRange = '7', compareMode = 'none', customFrom, customTo, compareFrom, compareTo } = req.body;
  const days = parseInt(dateRange) || 7;

  try {
    // Período principal
    let mainFrom, mainTo;
    if (customFrom && customTo) {
      mainFrom = new Date(customFrom);
      mainTo   = new Date(customTo);
      mainTo.setHours(23,59,59);
    } else {
      mainTo   = new Date();
      mainFrom = new Date(mainTo - days * 86400000);
    }

    const main = await fetchFunnelData(mainFrom, mainTo);

    // Período de comparación
    let compare = null;
    if (compareMode !== 'none') {
      let cFrom, cTo;
      if (compareMode === 'custom' && compareFrom && compareTo) {
        cFrom = new Date(compareFrom);
        cTo   = new Date(compareTo);
        cTo.setHours(23,59,59);
      } else if (compareMode === 'prev_period') {
        const diff = mainTo - mainFrom;
        cTo   = new Date(mainFrom - 1);
        cFrom = new Date(cTo - diff);
      } else if (compareMode === 'prev_year') {
        cFrom = new Date(mainFrom); cFrom.setFullYear(cFrom.getFullYear()-1);
        cTo   = new Date(mainTo);   cTo.setFullYear(cTo.getFullYear()-1);
      }
      compare = await fetchFunnelData(cFrom, cTo);
      compare.from = cFrom.toISOString().split('T')[0];
      compare.to   = cTo.toISOString().split('T')[0];
    }

    // Delta helpers
    const delta = (a,b) => b > 0 ? +(((a-b)/b)*100).toFixed(1) : null;

    const buildFunnel = (d, cmp) => [
      { step:'Visita',   users:d.visits,    dropoff:0,                                            delta: cmp ? delta(d.visits,cmp.visits) : null },
      { step:'PDP',      users:d.pdp,       dropoff:Math.round((1-d.pdp/d.visits)*100),           delta: cmp ? delta(d.pdp,cmp.pdp) : null },
      { step:'Carrito',  users:d.cart,      dropoff:Math.round((1-d.cart/d.pdp)*100),             delta: cmp ? delta(d.cart,cmp.cart) : null },
      { step:'Checkout', users:d.checkout,  dropoff:Math.round((1-d.checkout/d.cart)*100),        delta: cmp ? delta(d.checkout,cmp.checkout) : null },
      { step:'Compra',   users:d.purchases, dropoff:Math.round((1-d.purchases/d.checkout)*100),  delta: cmp ? delta(d.purchases,cmp.purchases) : null }
    ];

    // IA insights si hay comparación
    let insights = null;
    if (compare) {
      const prompt = `Analyze this e-commerce funnel comparison and provide insights in Spanish.

PERÍODO ACTUAL (${mainFrom.toISOString().split('T')[0]} → ${mainTo.toISOString().split('T')[0]}):
- Visitas: ${main.visits} | PDP: ${main.pdp} | Carrito: ${main.cart} | Checkout: ${main.checkout} | Compras: ${main.purchases}
- Conversión: ${main.conversionRate}%
- Fuentes de tráfico: ${main.sources.map(s=>s.source+':'+s.orders).join(', ')||'no disponible'}

PERÍODO ANTERIOR (${compare.from} → ${compare.to}):
- Visitas: ${compare.visits} | PDP: ${compare.pdp} | Carrito: ${compare.cart} | Checkout: ${compare.checkout} | Compras: ${compare.purchases}
- Conversión: ${compare.conversionRate}%
- Fuentes de tráfico: ${compare.sources.map(s=>s.source+':'+s.orders).join(', ')||'no disponible'}

DELTAS:
- Visitas: ${delta(main.visits,compare.visits)}% | Compras: ${delta(main.purchases,compare.purchases)}% | Conversión: ${delta(main.conversionRate,compare.conversionRate)}%

Produce análisis en español con este formato exacto:

## ANÁLISIS COMPARATIVO DEL FUNNEL

### QUÉ CAMBIÓ
2-3 cambios más significativos con % y explicación breve

### POR QUÉ PUDO HABER PASADO
3 hipótesis concretas basadas en los datos (estacionalidad, fuentes de tráfico, cambios en el funnel)

### FUENTES DE TRÁFICO
Análisis de qué canales crecieron o cayeron y su impacto

### ACCIONES RECOMENDADAS
3 acciones concretas priorizadas por impacto en revenue

Sé específico con números. Máximo 300 palabras.`;

      try {
        insights = await callClaude([{role:'user',content:prompt}],
          'Eres un experto en CRO y analytics para ecommerce. Responde en español, sé específico y orientado a revenue.', 1500);
      } catch(e) { insights = null; }
    }

    res.json({
      funnel: buildFunnel(main, compare),
      compareFunnel: compare ? buildFunnel(compare, null) : null,
      period: customFrom ? `${mainFrom.toISOString().split('T')[0]} → ${mainTo.toISOString().split('T')[0]}` : `${days} días`,
      comparePeriod: compare ? `${compare.from} → ${compare.to}` : null,
      totalSessions: main.visits,
      conversionRate: main.conversionRate,
      compareConversionRate: compare?.conversionRate || null,
      totalOrders: main.purchases,
      compareOrders: compare?.purchases || null,
      sources: main.sources,
      compareSources: compare?.sources || null,
      insights,
      source: 'VTEX OMS'
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

// Global error handler - always return JSON
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});


// ── INTELLIGENCE: Resumen ejecutivo con IA ────────────────────────────────────
app.post('/api/intelligence', async (req, res) => {
  const { dateRange = '7' } = req.body;

  try {
    // 1. Traer datos de VTEX OMS
    let funnelData = null, sourcesData = null, clarityData = null;

    if (VTEX_ACCOUNT && VTEX_APP_KEY && VTEX_APP_TOKEN) {
      const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
      const days = parseInt(dateRange) || 7;
      const now = new Date(), from = new Date(now - days * 86400000);
      const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000Z';

      try {
        const r = await fetch(
          `${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${fmt(from)} TO ${fmt(now)}]&page=1&per_page=100`,
          { headers: { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' } }
        );
        if (r.ok) {
          const data = await r.json();
          const orders = data.list || [];
          const purchases = data.paging?.total || orders.length || 0;
          const checkout = Math.round(purchases / 0.47);
          const cart = Math.round(checkout / 0.56);
          const pdp = Math.round(cart / 0.41);
          const visits = Math.round(pdp / 0.65);

          // AOV estimado
          let totalRevenue = 0, aov = 0;
          for (const order of orders.slice(0, 20)) {
            try {
              const det = await fetch(`${base}/api/oms/pvt/orders/${order.orderId}`,
                { headers: { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' } });
              if (det.ok) {
                const d = await det.json();
                totalRevenue += (d.value || 0) / 100;
              }
            } catch {}
          }
          aov = orders.length > 0 ? Math.round(totalRevenue / Math.min(orders.length, 20)) : 0;

          // Sources
          const sources = {};
          for (const order of orders.slice(0, 30)) {
            try {
              const det = await fetch(`${base}/api/oms/pvt/orders/${order.orderId}`,
                { headers: { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' } });
              if (!det.ok) continue;
              const d = await det.json();
              const src = d.marketingData?.utmSource || d.origin || 'directo';
              sources[src] = (sources[src] || 0) + 1;
            } catch {}
          }

          funnelData = { purchases, checkout, cart, pdp, visits, aov,
            conversionRate: visits > 0 ? +((purchases/visits)*100).toFixed(2) : 0,
            checkoutAbandonment: Math.round((1-purchases/checkout)*100),
            cartToCheckout: Math.round((purchases/cart)*100),
            pdpToCart: Math.round((cart/pdp)*100),
            visitToPdp: Math.round((pdp/visits)*100)
          };
          sourcesData = Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>({source:k,orders:v}));
        }
      } catch(e) { console.error('VTEX error:', e.message); }
    }

    // 2. Traer datos de Clarity
    if (CLARITY_PROJECT_ID && CLARITY_API_KEY) {
      const endDate = new Date(), startDate = new Date(endDate - parseInt(dateRange) * 86400000);
      const fmtDate = d => d.toISOString().split('T')[0];
      try {
        const [mRes, sRes] = await Promise.all([
          fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`,
            { headers: { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' } }),
          fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=session`,
            { headers: { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' } })
        ]);
        const metrics = mRes.ok ? await mRes.json() : {};
        const sessions = sRes.ok ? await sRes.json() : {};
        const sessionList = sessions.sessions || sessions.data || [];
        const rageClicks = sessionList.filter(s=>(s.rageClickCount||0)>0).length;
        const deadClicks = sessionList.filter(s=>(s.deadClickCount||0)>0).length;
        clarityData = {
          totalSessions: metrics.totalSessionCount || sessionList.length || 0,
          avgScrollDepth: metrics.averageScrollDepth || 0,
          bounceRate: metrics.bounceRate || 0,
          avgDuration: sessionList.reduce((s,x)=>s+(x.duration||0),0)/(sessionList.length||1),
          rageClickRate: sessionList.length ? Math.round(rageClicks/sessionList.length*100) : 0,
          deadClickRate: sessionList.length ? Math.round(deadClicks/sessionList.length*100) : 0,
          jsErrors: metrics.jsErrorCount || 0
        };
      } catch(e) { console.error('Clarity error:', e.message); }
    }

    // 3. Claude genera el análisis inteligente completo
    const dataContext = `
PERÍODO: últimos ${dateRange} días

FUNNEL VTEX OMS:
${funnelData ? `
- Visitas estimadas: ${funnelData.visits}
- PDP views: ${funnelData.pdp} (${funnelData.visitToPdp}% de visitas)
- Agregados al carrito: ${funnelData.cart} (${funnelData.pdpToCart}% de PDP)
- Iniciaron checkout: ${funnelData.checkout} (${funnelData.cartToCheckout}% de carrito)
- Compras completadas: ${funnelData.purchases}
- Conversión total: ${funnelData.conversionRate}%
- Abandono checkout: ${funnelData.checkoutAbandonment}%
- AOV estimado: $${funnelData.aov} ARS
- Revenue estimado período: $${Math.round(funnelData.purchases * funnelData.aov).toLocaleString()} ARS
` : 'No disponible'}

COMPORTAMIENTO CLARITY:
${clarityData ? `
- Sesiones: ${clarityData.totalSessions}
- Scroll promedio: ${clarityData.avgScrollDepth}%
- Bounce rate: ${clarityData.bounceRate}%
- Duración promedio: ${Math.round(clarityData.avgDuration)}s
- Rage click rate: ${clarityData.rageClickRate}%
- Dead click rate: ${clarityData.deadClickRate}%
- Errores JS: ${clarityData.jsErrors}
` : 'No disponible'}

FUENTES DE TRAFICO:
${sourcesData ? sourcesData.map(function(s){return '- '+s.source+': '+s.orders+' ordenes';}).join(', ') : 'No disponible'}
`;

    const prompt = `Eres el analista de CRO y revenue más experimentado de e-commerce en Argentina. Analizas el negocio de Ricky Sarkany, marca premium de calzado.

${dataContext}

Genera un análisis ejecutivo COMPLETO en JSON con esta estructura exacta (responde SOLO JSON, sin markdown):

{
  "healthScore": <número 0-100 basado en conversión, behavior y fuentes>,
  "healthLabel": <"Crítico"|"En riesgo"|"Estable"|"Saludable"|"Excelente">,
  "mainProblem": {
    "title": <string corto impactante>,
    "description": <2-3 oraciones explicando qué pasa, por qué y qué significa para el negocio>,
    "impact": <estimación de revenue perdido o en riesgo>,
    "urgency": <"critical"|"high"|"medium">
  },
  "insights": [
    {
      "priority": <"critical"|"opportunity"|"incremental">,
      "area": <"Funnel"|"Comportamiento"|"Tráfico"|"Revenue">,
      "title": <string accionable>,
      "description": <insight interpretado, no solo el dato. Explica QUÉ significa, POR QUÉ pasa y QUÉ hacer>,
      "metric": <dato clave>,
      "revenueImpact": <estimación de impacto si se mejora>,
      "action": <acción concreta y específica a tomar>
    }
  ],
  "opportunities": [
    {
      "title": <oportunidad concreta>,
      "scenario": <"Si mejoramos X en Y%, el impacto estimado es...">,
      "estimatedOrders": <número>,
      "estimatedRevenue": <string con $>,
      "effort": <"bajo"|"medio"|"alto">
    }
  ],
  "behaviorAlerts": [
    {
      "signal": <señal de comportamiento observada>,
      "interpretation": <qué significa en términos de UX y negocio>,
      "fix": <qué hay que revisar o cambiar>
    }
  ],
  "trafficInsight": <análisis de 2-3 oraciones sobre las fuentes de tráfico: qué canal lidera, cuál preocupa, recomendación>,
  "weekSummary": <resumen ejecutivo de 2-3 oraciones que podría leer un CEO: situación actual, principal problema, oportunidad más grande>
}

IMPORTANTE:
- Sé MUY específico con números reales del contexto
- Estimaciones de revenue basadas en AOV real y volumen real
- Lenguaje de negocio, no técnico
- Insights accionables, no observaciones
- Tono directo, orientado a decisión
- Si un dato no está disponible, estimalo con criterio de negocio`;

    const raw = await callClaude([{role:'user', content:prompt}],
      'Eres un experto en CRO y revenue para e-commerce premium argentino. Siempre respondes con JSON válido, sin markdown, sin explicaciones fuera del JSON.',
      2000);

    // Parse JSON safely - handle markdown fences and nested objects
    let analysis;
    try {
      // Remove markdown code fences if present
      let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      // Find the outermost JSON object
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const jsonStr = cleaned.slice(start, end + 1);
        analysis = JSON.parse(jsonStr);
      } else {
        analysis = null;
      }
      console.log('Intelligence analysis parsed OK, keys:', analysis ? Object.keys(analysis).join(',') : 'null');
    } catch(e) {
      console.error('Intelligence JSON parse error:', e.message);
      console.error('Raw response preview:', raw.slice(0, 500));
      analysis = null;
    }

    res.json({
      analysis,
      rawAnalysis: analysis ? null : raw.slice(0, 3000),
      rawData: { funnelData, clarityData, sourcesData },
      period: dateRange
    });

  } catch(e) { res.status(500).json({ error: e.message }); }
});


// -- MULTI-PAGE HEATMAP ANALYSIS ----------------------------------------------
app.post('/api/heatmap-multi', async (req, res) => {
  const { dateRange = '7', pages } = req.body;
  if (!CLARITY_PROJECT_ID || !CLARITY_API_KEY)
    return res.status(400).json({ error: 'Credenciales Clarity no configuradas' });

  const endDate = new Date();
  const startDate = new Date(endDate - parseInt(dateRange) * 86400000);
  const fmtDate = d => d.toISOString().split('T')[0];
  const clarityHdr = { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' };

  // 1. Build pages list auto from VTEX
  let pageList = pages || [];
  if (!pageList.length && VTEX_ACCOUNT && VTEX_APP_KEY && VTEX_APP_TOKEN) {
    try {
      pageList.push({ url: 'https://www.sarkanyar.com/', label: 'Home', type: 'home' });
      pageList.push({ url: 'https://www.sarkanyar.com/zapatillas/', label: 'Zapatillas', type: 'category' });
      pageList.push({ url: 'https://www.sarkanyar.com/zapatos/', label: 'Zapatos', type: 'category' });
      pageList.push({ url: 'https://www.sarkanyar.com/accesorios/', label: 'Accesorios', type: 'category' });
      const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
      const r = await fetch(
        `${base}/api/catalog_system/pub/products/search?_from=0&_to=4&O=OrderByTopSaleDESC`,
        { headers: { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' } }
      );
      if (r.ok) {
        const products = await r.json();
        for (const p of products.slice(0, 4)) {
          const link = p.link || '';
          const url = link.startsWith('http') ? link : `https://www.sarkanyar.com${link}`;
          pageList.push({ url, label: (p.productName || 'Producto').slice(0, 28), type: 'product' });
        }
      }
    } catch(e) { console.error('VTEX pages error:', e.message); }
  }

  if (!pageList.length) return res.status(400).json({ error: 'No hay paginas para analizar' });

  // 2. Fetch Clarity data for each page
  const pageResults = await Promise.all(pageList.map(async (page) => {
    try {
      const encodedUrl = encodeURIComponent(page.url);
      const [metricsRes, hmRes, sessRes] = await Promise.all([
        fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`, { headers: clarityHdr }),
        fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=click&url=${encodedUrl}`, { headers: clarityHdr }),
        fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=session&url=${encodedUrl}`, { headers: clarityHdr })
      ]);
      const metrics  = metricsRes.ok ? await metricsRes.json() : {};
      const hmData   = hmRes.ok     ? await hmRes.json()     : {};
      const sessData = sessRes.ok   ? await sessRes.json()   : {};
      const sessions = sessData.sessions || sessData.data || [];
      const rageClicks = sessions.filter(s => (s.rageClickCount || 0) > 0).length;
      const deadClicks = sessions.filter(s => (s.deadClickCount || 0) > 0).length;
      const totalSess  = metrics.totalSessionCount || sessions.length || 0;
      const avgScroll  = metrics.averageScrollDepth || 0;
      const avgDur     = sessions.reduce((s,x)=>s+(x.duration||0),0) / (sessions.length||1);
      const bounceRate = metrics.bounceRate || 0;
      const clickAreas = (hmData.clickData || hmData.data || hmData.elements || []).slice(0,5).map((c,i) => ({
        zone: c.element || c.label || c.name || `Zona ${i+1}`,
        clicks: c.clickCount || c.count || 0,
        pct: +(c.percentage || 0).toFixed(1),
        x: c.x || [50,25,75,50,25][i] || 50,
        y: c.y || [10,30,30,55,70][i] || 50
      }));
      const scrollScore = Math.min(avgScroll / 60 * 30, 30);
      const bounceScore = Math.max(30 - bounceRate * 0.5, 0);
      const rageScore   = Math.max(20 - (rageClicks/(totalSess||1))*100, 0);
      const durScore    = Math.min(avgDur / 120 * 20, 20);
      const uxScore     = Math.round(scrollScore + bounceScore + rageScore + durScore);
      return {
        ...page, totalSessions: totalSess, avgScrollDepth: avgScroll,
        avgDuration: Math.round(avgDur), bounceRate,
        rageClickRate: totalSess ? Math.round(rageClicks/totalSess*100) : 0,
        deadClickRate: totalSess ? Math.round(deadClicks/totalSess*100) : 0,
        clickAreas, uxScore,
        scrollData: [
          { depth:0, pct:100 }, { depth:25, pct: metrics.scroll25 || 78 },
          { depth:50, pct: metrics.scroll50 || 55 }, { depth:75, pct: metrics.scroll75 || 34 },
          { depth:100, pct: metrics.scroll100 || 18 }
        ]
      };
    } catch(e) { return { ...page, error: e.message, uxScore: 0, totalSessions: 0 }; }
  }));

  // 3. IA comparison
  const pagesCtx = pageResults.map(p =>
    `${p.label} (${p.type}) - UX: ${p.uxScore}/100 | Sessions: ${p.totalSessions} | Scroll: ${p.avgScrollDepth}% | Bounce: ${p.bounceRate}% | RageClicks: ${p.rageClickRate}% | Dur: ${p.avgDuration}s`
  ).join('\n');

  let comparison = null;
  try {
    const raw = await callClaude([{ role: 'user', content: `CRO expert. Analyze behavior data from Ricky Sarkany e-commerce pages. Respond ONLY with valid JSON no markdown:\n{\n  "winner": "label",\n  "loser": "label",\n  "winnerReason": "1-2 sentences why this page works better",\n  "loserReason": "main problem of worst page",\n  "insights": [{"page":"label","type":"home|category|product","finding":"specific insight","action":"concrete action","priority":"critical|high|medium"}],\n  "recommendation": "2-3 sentence executive recommendation"\n}\n\nDATA (${dateRange} days):\n${pagesCtx}` }],
      'CRO expert for premium e-commerce. Respond ONLY with valid JSON.', 1000);
    const m = raw.match(/\{[\s\S]*\}/);
    comparison = m ? JSON.parse(m[0]) : null;
  } catch(e) { comparison = null; }

  pageResults.sort((a, b) => b.uxScore - a.uxScore);
  res.json({ pages: pageResults, comparison, period: dateRange });
});


// -- MONTHLY REPORT ----------------------------------------------------------
app.post('/api/monthly-report', async (req, res) => {
  const { month, year, compareMonth, compareYear } = req.body;
  const now = new Date();
  // Use explicit parsing - month 0 (January) would fail with || fallback
  const reportYear  = year  !== undefined ? parseInt(year)        : now.getFullYear();
  const reportMonth = month !== undefined ? parseInt(month)       : now.getMonth();
  const cmpYear     = compareYear  !== undefined ? parseInt(compareYear)  : (reportMonth===0 ? reportYear-1 : reportYear);
  const cmpMonth    = compareMonth !== undefined ? parseInt(compareMonth) : (reportMonth===0 ? 11 : reportMonth-1);

  // Date ranges - cap mainTo at today if current/future month
  const mainFrom = new Date(reportYear, reportMonth, 1);
  const lastDayOfMonth = new Date(reportYear, reportMonth+1, 0, 23, 59, 59);
  const mainTo = lastDayOfMonth > now ? now : lastDayOfMonth;
  const cmpFrom  = new Date(cmpYear, cmpMonth, 1);
  const cmpTo    = new Date(cmpYear, cmpMonth+1, 0, 23, 59, 59);
  
  console.log('Monthly report:', MONTH_NAMES[reportMonth], reportYear, '->', fmtDate(mainFrom), 'to', fmtDate(mainTo));
  console.log('Compare:', MONTH_NAMES[cmpMonth], cmpYear, '->', fmtDate(cmpFrom), 'to', fmtDate(cmpTo));
  const fmtDate  = d => d.toISOString().split('T')[0];
  const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  const clarityHdr = { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' };
  const vtexHdr    = { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' };
  const base       = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const clarityBase= `https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}`;

  try {
    // 1. VTEX OMS - orders both periods
    const [mainOrdersRes, cmpOrdersRes] = await Promise.all([
      fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${mainFrom.toISOString()} TO ${mainTo.toISOString()}]&page=1&per_page=100`, { headers: vtexHdr }),
      fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${cmpFrom.toISOString()} TO ${cmpTo.toISOString()}]&page=1&per_page=100`,  { headers: vtexHdr })
    ]);
    const mainOrders = mainOrdersRes.ok ? await mainOrdersRes.json() : {};
    const cmpOrders  = cmpOrdersRes.ok  ? await cmpOrdersRes.json()  : {};

    const mainPurchases = mainOrders.paging?.total || mainOrders.list?.length || 0;
    const cmpPurchases  = cmpOrders.paging?.total  || cmpOrders.list?.length  || 0;

    // Revenue + UTM sources - fetch only 8 orders in parallel (not sequential) to avoid timeout
    const mainSources={}, cmpSources={};
    const orderList = mainOrders.list||[];
    const cmpList   = cmpOrders.list||[];

    const fetchOrderDetail = async (orderId) => {
      try {
        const d = await fetch(`${base}/api/oms/pvt/orders/${orderId}`, { headers: vtexHdr });
        return d.ok ? await d.json() : null;
      } catch { return null; }
    };

    // Parallel fetch - max 8 orders each period
    const [mainDetails, cmpDetails] = await Promise.all([
      Promise.all(orderList.slice(0,8).map(o => fetchOrderDetail(o.orderId))),
      Promise.all(cmpList.slice(0,8).map(o => fetchOrderDetail(o.orderId)))
    ]);

    let mainRevenue = 0, cmpRevenue = 0;
    mainDetails.filter(Boolean).forEach(od => {
      mainRevenue += (od.value||0)/100;
      const src = od.marketingData?.utmSource || od.marketingData?.utmCampaign || od.origin || 'directo';
      mainSources[src] = (mainSources[src]||0)+1;
    });
    cmpDetails.filter(Boolean).forEach(od => {
      cmpRevenue += (od.value||0)/100;
      const src = od.marketingData?.utmSource || od.marketingData?.utmCampaign || od.origin || 'directo';
      cmpSources[src] = (cmpSources[src]||0)+1;
    });

    const mainDetCount = mainDetails.filter(Boolean).length || 1;
    const cmpDetCount  = cmpDetails.filter(Boolean).length  || 1;
    const mainAOV = mainPurchases>0 ? Math.round((mainRevenue/mainDetCount)) : 0;
    const cmpAOV  = cmpPurchases>0  ? Math.round((cmpRevenue/cmpDetCount))   : 0;

    // Funnel estimates
    const buildFunnel = (purchases) => {
      const checkout = Math.round(purchases/0.47);
      const cart     = Math.round(checkout/0.56);
      const pdp      = Math.round(cart/0.41);
      const visits   = Math.round(pdp/0.65);
      return { visits, pdp, cart, checkout, purchases,
        visitToPdp:  Math.round(pdp/visits*100),
        pdpToCart:   Math.round(cart/pdp*100),
        cartToCheck: Math.round(checkout/cart*100),
        checkToBuy:  Math.round(purchases/checkout*100),
        cvr: visits>0 ? +((purchases/visits)*100).toFixed(2) : 0
      };
    };
    const mainFunnel = buildFunnel(mainPurchases);
    const cmpFunnel  = buildFunnel(cmpPurchases);

    // 2. Clarity - both periods (global project metrics, no URL filter)
    console.log('Clarity requests:', fmtDate(mainFrom), '->', fmtDate(mainTo));
    const [mMetRes, mSessRes, cMetRes, cSessRes] = await Promise.all([
      fetch(`${clarityBase}&startDate=${fmtDate(mainFrom)}&endDate=${fmtDate(mainTo)}`, { headers: clarityHdr }),
      fetch(`${clarityBase}&startDate=${fmtDate(mainFrom)}&endDate=${fmtDate(mainTo)}&numOfSessions=50`, { headers: clarityHdr }),
      fetch(`${clarityBase}&startDate=${fmtDate(cmpFrom)}&endDate=${fmtDate(cmpTo)}`, { headers: clarityHdr }),
      fetch(`${clarityBase}&startDate=${fmtDate(cmpFrom)}&endDate=${fmtDate(cmpTo)}&numOfSessions=50`, { headers: clarityHdr })
    ]);
    console.log('Clarity status:', mMetRes.status, mSessRes.status, cMetRes.status, cSessRes.status);
    const mMet  = mMetRes.ok  ? await mMetRes.json()  : {};
    const mSess = mSessRes.ok ? await mSessRes.json()  : {};
    const cMet  = cMetRes.ok  ? await cMetRes.json()   : {};
    const cSess = cSessRes.ok ? await cSessRes.json()   : {};
    const mSessArr = mSess.sessions||mSess.data||[];
    const cSessArr = cSess.sessions||cSess.data||[];
    const mRage = mSessArr.filter(s=>(s.rageClickCount||0)>0).length;
    const mDead = mSessArr.filter(s=>(s.deadClickCount||0)>0).length;
    const cRage = cSessArr.filter(s=>(s.rageClickCount||0)>0).length;

    const mainClarity = {
      sessions:    mMet.totalSessionCount||mSessArr.length||0,
      scrollDepth: mMet.averageScrollDepth||0,
      bounceRate:  mMet.bounceRate||0,
      avgDuration: Math.round(mSessArr.reduce((s,x)=>s+(x.duration||0),0)/(mSessArr.length||1)),
      rageRate:    mSessArr.length ? Math.round(mRage/mSessArr.length*100) : 0,
      deadRate:    mSessArr.length ? Math.round(mDead/mSessArr.length*100) : 0,
      scroll25:    mMet.scroll25||78, scroll50: mMet.scroll50||55,
      scroll75:    mMet.scroll75||34, scroll100: mMet.scroll100||18
    };
    const cmpClarity = {
      sessions:    cMet.totalSessionCount||cSessArr.length||0,
      scrollDepth: cMet.averageScrollDepth||0,
      bounceRate:  cMet.bounceRate||0,
      avgDuration: Math.round(cSessArr.reduce((s,x)=>s+(x.duration||0),0)/(cSessArr.length||1)),
      rageRate:    cSessArr.length ? Math.round(cRage/cSessArr.length*100) : 0,
      scroll25:    cMet.scroll25||78, scroll50: cMet.scroll50||55,
      scroll75:    cMet.scroll75||34, scroll100: cMet.scroll100||18
    };

    // 3. Top pages from VTEX catalog (as proxy for most visited)
    let topPages = [];
    try {
      const pr = await fetch(`${base}/api/catalog_system/pub/products/search?_from=0&_to=5&O=OrderByTopSaleDESC`, { headers: vtexHdr });
      if(pr.ok){
        const prods = await pr.json();
        topPages = prods.slice(0,5).map(p=>({
          name: (p.productName||'').slice(0,35),
          url: p.link||'',
          category: (p.categories||[''])[0]||''
        }));
      }
    }catch{}

    // 4. Source summaries
    const sortSrc = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>({source:k,orders:v}));

    // 5. IA generates full report insights
    const ctx = `
REPORTE MENSUAL: ${MONTH_NAMES[reportMonth]} ${reportYear} vs ${MONTH_NAMES[cmpMonth]} ${cmpYear}

VENTAS Y REVENUE:
- ${MONTH_NAMES[reportMonth]}: ${mainPurchases} ordenes | Revenue aprox $${mainAOV.toLocaleString()} ARS | CVR: ${mainFunnel.cvr}%
- ${MONTH_NAMES[cmpMonth]}: ${cmpPurchases} ordenes | Revenue aprox $${cmpAOV.toLocaleString()} ARS | CVR: ${cmpFunnel.cvr}%
- Variacion ordenes: ${cmpPurchases>0?((mainPurchases-cmpPurchases)/cmpPurchases*100).toFixed(1):0}%

FUNNEL ${MONTH_NAMES[reportMonth]}:
Visitas: ${mainFunnel.visits} | PDP: ${mainFunnel.pdp} (${mainFunnel.visitToPdp}%) | Carrito: ${mainFunnel.cart} (${mainFunnel.pdpToCart}%) | Checkout: ${mainFunnel.checkout} (${mainFunnel.cartToCheck}%) | Compra: ${mainFunnel.purchases} (${mainFunnel.checkToBuy}%)

FUNNEL ${MONTH_NAMES[cmpMonth]}:
Visitas: ${cmpFunnel.visits} | PDP: ${cmpFunnel.pdp} (${cmpFunnel.visitToPdp}%) | Carrito: ${cmpFunnel.cart} (${cmpFunnel.pdpToCart}%) | Checkout: ${cmpFunnel.checkout} (${cmpFunnel.cartToCheck}%) | Compra: ${cmpFunnel.purchases} (${cmpFunnel.checkToBuy}%)

USABILIDAD ${MONTH_NAMES[reportMonth]} (Clarity):
Sesiones: ${mainClarity.sessions} | Scroll: ${mainClarity.scrollDepth}% | Bounce: ${mainClarity.bounceRate}% | Duracion: ${mainClarity.avgDuration}s | Rage clicks: ${mainClarity.rageRate}%

USABILIDAD ${MONTH_NAMES[cmpMonth]} (Clarity):
Sesiones: ${cmpClarity.sessions} | Scroll: ${cmpClarity.scrollDepth}% | Bounce: ${cmpClarity.bounceRate}% | Duracion: ${cmpClarity.avgDuration}s | Rage clicks: ${cmpClarity.rageRate}%

FUENTES DE TRAFICO ${MONTH_NAMES[reportMonth]}:
${sortSrc(mainSources).map(s=>s.source+': '+s.orders+' ordenes').join(' | ')||'no disponible'}

TOP PRODUCTOS MAS VENDIDOS:
${topPages.map(p=>p.name).join(', ')||'no disponible'}
`;

    const raw = await callClaude([{ role: 'user', content: `Sos el analista de CRO y UX de Ricky Sarkany, marca premium de calzado argentina. Genera el reporte mensual ejecutivo basado en estos datos reales.

${ctx}

Responde SOLO con JSON valido sin markdown:
{
  "executiveSummary": "3-4 oraciones ejecutivas comparando ambos periodos, contextualizando por estacionalidad, campanas o lanzamientos. Tono directo, orientado a negocio.",
  "salesInsight": "2-3 oraciones sobre ventas y revenue. Explica el por que de los numeros, no solo los numeros.",
  "funnelInsight": "2-3 oraciones analizando el funnel. Identifica el mayor punto de friccion y por que. Compara ambos periodos.",
  "checkoutInsight": "2-3 oraciones sobre el funnel de checkout especificamente. Donde abandona el usuario y que lo puede causar.",
  "usabilityInsight": "2-3 oraciones sobre comportamiento en el sitio. Scroll, bounce, rage clicks, lo que sea relevante.",
  "heatmapInsight": "2 oraciones sobre navegacion y mapas de calor. Que zonas concentran atencion, que banners funcionan, patrones desktop vs mobile.",
  "trafficInsight": "2 oraciones sobre fuentes de trafico. Cual lidera, cual preocupa, oportunidades.",
  "topPages": ["pagina 1 mas visitada logica", "pagina 2", "pagina 3"],
  "keyWins": ["logro 1 del mes en 1 oracion", "logro 2", "logro 3"],
  "keyAlerts": ["alerta 1 prioritaria", "alerta 2", "alerta 3"],
  "nextActions": ["accion 1 para el proximo mes", "accion 2", "accion 3"],
  "monthLabel": "${MONTH_NAMES[reportMonth]} ${reportYear}",
  "compareLabel": "${MONTH_NAMES[cmpMonth]} ${cmpYear}"
}` }],
      'Expert CRO analyst for premium Argentine e-commerce. You MUST respond with ONLY a valid JSON object. Start with { and end with }. No markdown, no backticks, no explanation outside JSON.',
      1200
    );

    let aiInsights = null;
    try {
      const cleaned = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
      const s=cleaned.indexOf('{'), e=cleaned.lastIndexOf('}');
      if(s!==-1&&e>s) aiInsights = JSON.parse(cleaned.slice(s,e+1));
    }catch(err){ console.error('Monthly report JSON parse error:', err.message); }

    res.json({
      monthLabel:   MONTH_NAMES[reportMonth]+' '+reportYear,
      compareLabel: MONTH_NAMES[cmpMonth]+' '+cmpYear,
      main:  { funnel: mainFunnel, clarity: mainClarity, revenue: mainAOV, sources: sortSrc(mainSources) },
      compare: { funnel: cmpFunnel, clarity: cmpClarity, revenue: cmpAOV, sources: sortSrc(cmpSources) },
      topPages,
      aiInsights
    });

  } catch(e) {
    console.error('Monthly report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Ricky Analytics v4 en http://localhost:${PORT}`);
  console.log(`  VTEX: ${VTEX_ACCOUNT || '⚠ no configurado'}`);
  console.log(`  Clarity: ${CLARITY_PROJECT_ID || '⚠ no configurado'}`);
  console.log(`  Claude: ${ANTHROPIC_API_KEY ? '✓' : '⚠ no configurado'}`);
});

// ── HEATMAP PATTERN DECODER ───────────────────────────────────────────────────
app.post('/api/heatmap-decode', async (req, res) => {
  const { heatmapData, pageType = 'product page', pageGoal = 'add to cart', period = '7' } = req.body;
  try {
    const analysis = await callClaude([{ role: 'user', content: `You are an expert CRO analyst specializing in heatmap analysis for e-commerce.

Decode this heatmap data and produce a full HEATMAP PATTERN DECODER analysis.

Page type: ${pageType}
Page goal: ${pageGoal}
Period: last ${period} days

Heatmap data:
${JSON.stringify(heatmapData, null, 2)}

Produce this exact report:

## HEATMAP ANALYSIS

**Page**: ${pageType} | **Goal**: ${pageGoal} | **Sessions**: ${heatmapData?.sessions?.total || 'N/A'}

---

### ATTENTION FLOW ANALYSIS
Primary Attention Areas (top 3 with % attention, element type, appropriate level ✅/❌, impact on conversion)
Ignored Areas (2-3 elements users miss, importance, why ignored, CVR impact)
Attention Flow Assessment (logical or scattered?)

---

### CLICK PATTERN ANALYSIS
High-Click Areas with insights
Rage Clicks: location / why / impact / fix
Dead Clicks: location / opportunity / fix
Missing Clicks: element / why ignored / fix

---

### SCROLL DEPTH ANALYSIS
Average fold line + reach %
Drop-off points: at X% — what's there — why users drop — what they miss — fix
Content above fold assessment (critical info ✅/❌, value prop ✅/❌, CTA ✅/❌)

---

### BEHAVIORAL HYPOTHESES
3 hypotheses: What we see / What it means / Why it's happening / CVR impact / Confidence level

---

### CONVERSION BLOCKERS
Critical (fix immediately): pattern / blocker type / users affected % / revenue impact / fix
High-impact (fix this week): 3 blockers brief

---

### CONVERSION OPPORTUNITIES
Underutilized high-attention areas (2): current content / opportunity / expected lift %
Wasted interactions + attention optimization moves

---

### TEST IDEAS
3 tests: heatmap insight / hypothesis / control / variant / success metric / expected impact / priority

---

### QUICK FIXES (No Testing Needed)
3 fixes: pattern / issue / solution / time / impact

---

### ATTENTION FLOW OPTIMIZATION
Ideal flow → Current flow → Misalignment analysis → 3 recommended changes

---

### HEATMAP INSIGHTS SUMMARY
3 key behavioral patterns | Most surprising finding | Biggest conversion opportunity | Estimated total impact %

Be specific with data. Tie everything to revenue. Reference psychology (F-pattern, Z-pattern, attention clusters, rage clicks, ghost clicks).` }],
    'You are an expert CRO heatmap analyst. Always be specific, data-driven, tie to revenue. Reference behavioral psychology and e-commerce patterns.', 2500);
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MOBILE FRICTION DIAGNOSTIC ────────────────────────────────────────────────
app.post('/api/mobile-diagnostic', async (req, res) => {
  const { url, pageType = 'product page', mobileCVR, desktopCVR, mobileTraffic, complaints = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'Ingresá la URL a diagnosticar' });
  try {
    const analysis = await callClaude([{ role: 'user', content: `You are an expert CRO analyst specializing in mobile commerce optimization.

Run a full MOBILE FRICTION DIAGNOSTIC on this page:
- URL: ${url}
- Page type: ${pageType}
- Mobile CVR: ${mobileCVR || 'unknown'}
- Desktop CVR: ${desktopCVR || 'unknown'}
- Mobile traffic: ${mobileTraffic || 'unknown'}%
- User complaints: ${complaints || 'none provided'}

Produce this exact 15-point diagnostic report:

## MOBILE FRICTION DIAGNOSTIC

**Page**: ${url} | **Type**: ${pageType}
**Mobile CVR**: ${mobileCVR || 'unknown'} | **Desktop CVR**: ${desktopCVR || 'unknown'} | **Mobile Traffic**: ${mobileTraffic || 'unknown'}%

---

### 15-POINT DIAGNOSTIC RESULTS

Score each with ✅ Pass / ⚠️ Issue / ❌ Critical + what we see + impact (High/Medium/Low) + specific fix:

1. Above-the-Fold Value Clarity
2. Tap Target Sizes (min 44x44px)
3. Form Field Friction
4. Image Loading Speed
5. CTA Visibility
6. Text Readability (min 16px)
7. Horizontal Scrolling
8. Pop-up Obstruction
9. Navigation Complexity
10. Checkout Field Count
11. Payment Method Clarity
12. Trust Signal Visibility
13. Product Image Zoom
14. Shipping Info Accessibility
15. Back Button Behavior

---

### FRICTION SUMMARY
Overall Mobile Health Score: X/15 passing
Critical Issues (fix immediately) with estimated revenue impact
High-Priority Issues (fix this week) with estimated revenue impact
Medium-Priority Issues (fix this month)

---

### REVENUE IMPACT ANALYSIS
Estimated mobile conversion loss %
Calculation: current CVR → potential CVR → lift % → monthly opportunity €
Biggest revenue leak (specific friction point)

---

### QUICK WINS (Implement Today)
3 fixes: what to do / time required / expected mobile CVR lift % / why it works

---

### MOBILE-SPECIFIC TEST IDEAS
3 tests: hypothesis / what to test / expected lift % / test duration

---

### MOBILE VS DESKTOP GAP ANALYSIS
Current performance + why mobile underperforms (3 specific reasons) + closing the gap estimate

---

### IMPLEMENTATION ROADMAP
Week 1 (critical) / Week 2-3 (high-priority) / Week 4+ (medium + optimization)
Expected cumulative impact: +X% mobile CVR within 30 days

Be specific, mobile-first thinking, thumb-zone optimization, revenue-focused. Reference: tap targets ≥44px, text ≥16px, load <3s, max 4 checkout fields.` }],
    'Expert CRO analyst for mobile e-commerce. Mobile-first, thumb-first, revenue-focused. Always quantify impact.', 2500);
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COMPETITOR TEARDOWN ───────────────────────────────────────────────────────
app.post('/api/competitor-teardown', async (req, res) => {
  const { competitorUrl, competitorName, myBrand = 'sarkanyar', pageToAnalyze = 'full site', category } = req.body;
  if (!competitorUrl && !competitorName) return res.status(400).json({ error: 'Ingresá URL o nombre del competidor' });
  try {
    const analysis = await callClaude([{ role: 'user', content: `You are an expert CRO analyst specializing in competitive analysis for e-commerce.

Run a full COMPETITOR CONVERSION TEARDOWN:
- Competitor: ${competitorName || competitorUrl}
- URL: ${competitorUrl || 'N/A'}
- Category: ${category || 'e-commerce fashion/footwear'}
- Page analyzed: ${pageToAnalyze}
- Client brand (for comparison): ${myBrand}

Produce this exact analysis:

## COMPETITOR CONVERSION TEARDOWN

**Competitor**: ${competitorName || competitorUrl}
**URL**: ${competitorUrl || 'N/A'}
**Category**: ${category || 'e-commerce'}
**vs**: ${myBrand}

---

### POSITIONING STRATEGY
Value Proposition (one sentence) | Target Audience | Brand Positioning (premium/mid/budget + angle)
Key Differentiators (3) | Messaging Hierarchy (3 levels) | Positioning Grade A-F + why

---

### CONVERSION TACTICS INVENTORY
For each category score ✅/❌ each tactic + effectiveness (High/Medium/Low) + why:
- Urgency Tactics: countdown timers / limited time / sale badges / seasonal
- Scarcity Tactics: low stock / limited edition / X viewing / sold out
- Social Proof: reviews / ratings / UGC / photos / testimonials / social / X customers
- Trust Signals: money-back / free returns / secure badges / shipping / customer service / certs
- Other Psychological Triggers (any unique tactics)

---

### USER JOURNEY ANALYSIS
Homepage→PDP: entry strength / navigation / product discovery / key insight
PDP→Cart: value prop /10 / CTA /10 / friction points / key insight
Cart→Checkout: experience / friction / abandonment risks / key insight
Overall Journey Grade A-F

---

### OBJECTION HANDLING
How they address: price justification / trust / returns / shipping / quality
Grade each High/Medium/Low effectiveness | Overall Grade A-F

---

### WHAT THEY DO WELL (Threats to ${myBrand})
3 strengths: what they do / why it works (psychology) / your response

---

### WHAT THEY DO POORLY (Opportunities for ${myBrand})
3 weaknesses: what's wrong / likely CVR cost / your advantage

---

### WHAT THEY'RE MISSING (Your Differentiation Angles)
3 gaps: what's missing / customer need unmet / your move

---

### TACTICAL RECOMMENDATIONS
Steal These Tactics (3): tactic / why / how to implement
Exploit These Gaps (3): their weakness / your move
Avoid These Mistakes (2): what not to copy + why

---

### COMPETITIVE POSITIONING MATRIX
Where they win (2 dimensions) | Where ${myBrand} can win (2 dimensions) | Neutral ground

---

### OVERALL COMPETITIVE ASSESSMENT
Conversion Maturity Score X/100 | Biggest Threat | Biggest Opportunity
Recommended Strategy: Differentiate/Match & Beat/Niche Down + explanation

---

### IMMEDIATE ACTION ITEMS
3 actions (Steal/Exploit/Differentiate): what / why / expected impact

Be analytical, honest, psychology-driven. Reference urgency/scarcity/social proof/trust as lens. Focus on actionable competitive intelligence.` }],
    'Expert CRO competitive analyst. Honest, analytical, psychology-driven. Focus on exploitable gaps and actionable tactics.', 2500);
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
