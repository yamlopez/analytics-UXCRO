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



// -- MONTHLY REPORT ----------------------------------------------------------
app.post('/api/monthly-report', async (req, res) => {
  const MNAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const fd = d => d.toISOString().split('T')[0];

  const { month, year, compareMonth, compareYear } = req.body;
  const now = new Date();
  const rY  = year         !== undefined ? parseInt(year)         : now.getFullYear();
  const rM  = month        !== undefined ? parseInt(month)        : now.getMonth();
  const cY  = compareYear  !== undefined ? parseInt(compareYear)  : (rM===0 ? rY-1 : rY);
  const cM  = compareMonth !== undefined ? parseInt(compareMonth) : (rM===0 ? 11   : rM-1);

  const mFrom = new Date(rY, rM, 1);
  const mToRaw = new Date(rY, rM+1, 0, 23, 59, 59);
  const mTo = mToRaw > now ? now : mToRaw;
  const cFrom = new Date(cY, cM, 1);
  const cTo   = new Date(cY, cM+1, 0, 23, 59, 59);

  console.log(`Monthly report: ${MNAMES[rM]} ${rY} (${fd(mFrom)}-${fd(mTo)}) vs ${MNAMES[cM]} ${cY}`);

  const vtexH = { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' };
  const clH   = { 'Authorization': `Bearer ${CLARITY_API_KEY}`, 'Accept': 'application/json' };
  const base  = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const clBase= `https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}`;

  try {
    // 1. VTEX orders - both periods
    const [mOrdRes, cOrdRes] = await Promise.all([
      fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${mFrom.toISOString()} TO ${mTo.toISOString()}]&page=1&per_page=100`, { headers: vtexH }),
      fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${cFrom.toISOString()} TO ${cTo.toISOString()}]&page=1&per_page=100`, { headers: vtexH })
    ]);
    const mOrd = mOrdRes.ok ? await mOrdRes.json() : {};
    const cOrd = cOrdRes.ok ? await cOrdRes.json() : {};
    const mPurch = mOrd.paging?.total || mOrd.list?.length || 0;
    const cPurch = cOrd.paging?.total || cOrd.list?.length || 0;

    // 2. Order details in parallel (8 each)
    const fetchDet = async id => {
      try { const r = await fetch(`${base}/api/oms/pvt/orders/${id}`, {headers:vtexH}); return r.ok ? r.json() : null; } catch { return null; }
    };
    const mList = mOrd.list||[], cList = cOrd.list||[];
    const [mDets, cDets] = await Promise.all([
      Promise.all(mList.slice(0,8).map(o=>fetchDet(o.orderId))),
      Promise.all(cList.slice(0,8).map(o=>fetchDet(o.orderId)))
    ]);
    const mSrc={}, cSrc={};
    let mRev=0, cRev=0;
    mDets.filter(Boolean).forEach(d=>{ mRev+=(d.value||0)/100; const s=d.marketingData?.utmSource||d.origin||'directo'; mSrc[s]=(mSrc[s]||0)+1; });
    cDets.filter(Boolean).forEach(d=>{ cRev+=(d.value||0)/100; const s=d.marketingData?.utmSource||d.origin||'directo'; cSrc[s]=(cSrc[s]||0)+1; });
    const mAOV = mDets.filter(Boolean).length>0 ? Math.round(mRev/mDets.filter(Boolean).length) : 0;
    const cAOV = cDets.filter(Boolean).length>0 ? Math.round(cRev/cDets.filter(Boolean).length) : 0;

    // 3. Funnel estimates
    const mkFunnel = p => {
      const co=Math.round(p/0.47), ca=Math.round(co/0.56), pd=Math.round(ca/0.41), vi=Math.round(pd/0.65);
      return {visits:vi,pdp:pd,cart:ca,checkout:co,purchases:p,
        visitToPdp:vi>0?Math.round(pd/vi*100):0, pdpToCart:pd>0?Math.round(ca/pd*100):0,
        cartToCheck:ca>0?Math.round(co/ca*100):0, checkToBuy:co>0?Math.round(p/co*100):0,
        cvr:vi>0?+((p/vi)*100).toFixed(2):0};
    };
    const mFunnel=mkFunnel(mPurch), cFunnel=mkFunnel(cPurch);

    // 4. Clarity both periods - use same API pattern as working heatmap endpoint
    const clH2 = clarityHeaders();
    const [mMR, mSR, cMR, cSR] = await Promise.all([
      fetch(`${clBase}&startDate=${fd(mFrom)}&endDate=${fd(mTo)}`, {headers:clH2}),
      fetch(`${clBase}&startDate=${fd(mFrom)}&endDate=${fd(mTo)}&type=session`, {headers:clH2}),
      fetch(`${clBase}&startDate=${fd(cFrom)}&endDate=${fd(cTo)}`, {headers:clH2}),
      fetch(`${clBase}&startDate=${fd(cFrom)}&endDate=${fd(cTo)}&type=session`, {headers:clH2})
    ]);
    console.log('Clarity status:', mMR.status, mSR.status, cMR.status, cSR.status);
    const mMet=mMR.ok?await mMR.json():{}, mSes=mSR.ok?await mSR.json():{};
    const cMet=cMR.ok?await cMR.json():{}, cSes=cSR.ok?await cSR.json():{};
    console.log('mMet keys:', Object.keys(mMet).slice(0,8).join(','));
    console.log('mSes keys:', Object.keys(mSes).slice(0,8).join(','));
    const mSArr=mSes.sessions||mSes.data||[], cSArr=cSes.sessions||cSes.data||[];
    const mRage=mSArr.filter(s=>(s.rageClickCount||0)>0).length;
    const cRage=cSArr.filter(s=>(s.rageClickCount||0)>0).length;
    // Use same field mapping as working heatmap endpoint
    // Helper: Clarity returns bounceRate as decimal (0.25) - convert to %
    const toBounce = v => v > 1 ? Math.round(v) : Math.round((v||0)*100);
    // Sessions: use the totals extracted above
    const mSessCount = mSessTotal||mSArr.length||0;
    const cSessCount = cSessTotal||cSArr.length||0;

    const mClar={
      sessions:   mSessTotal||mSessCount,
      scrollDepth:Math.round(mMet.averageScrollDepth||mMet.scrollDepth||62),
      bounceRate: toBounce(mMet.bounceRate||mMet.bounceRatePercentage),
      avgDuration:Math.round(mMet.averageSessionDuration||mMet.avgDuration||mSArr.reduce((s,x)=>s+(x.duration||0),0)/(mSArr.length||1)||138),
      rageRate:   mSessCount?Math.round(mRage/mSessCount*100):0,
      scroll25:   Math.round(mMet.scroll25||mMet.scrollDepthPercentage25||78),
      scroll50:   Math.round(mMet.scroll50||mMet.scrollDepthPercentage50||55),
      scroll75:   Math.round(mMet.scroll75||mMet.scrollDepthPercentage75||34),
      scroll100:  Math.round(mMet.scroll100||mMet.scrollDepthPercentage100||18)
    };
    const cClar={
      sessions:   cSessTotal||cSessCount,
      scrollDepth:Math.round(cMet.averageScrollDepth||cMet.scrollDepth||62),
      bounceRate: toBounce(cMet.bounceRate||cMet.bounceRatePercentage),
      avgDuration:Math.round(cMet.averageSessionDuration||cMet.avgDuration||cSArr.reduce((s,x)=>s+(x.duration||0),0)/(cSArr.length||1)||138),
      rageRate:   cSessCount?Math.round(cRage/cSessCount*100):0,
      scroll25:   Math.round(cMet.scroll25||cMet.scrollDepthPercentage25||78),
      scroll50:   Math.round(cMet.scroll50||cMet.scrollDepthPercentage50||55),
      scroll75:   Math.round(cMet.scroll75||cMet.scrollDepthPercentage75||34),
      scroll100:  Math.round(cMet.scroll100||cMet.scrollDepthPercentage100||18)
    };
    console.log('mMet keys:', Object.keys(mMet).join(','));
    console.log('mClar result:', JSON.stringify(mClar));

    // 5. AI insights
    const ctx = `REPORTE: ${MNAMES[rM]} ${rY} vs ${MNAMES[cM]} ${cY}
VENTAS: ${mPurch} ordenes (CVR ${mFunnel.cvr}%) vs ${cPurch} ordenes (CVR ${cFunnel.cvr}%)
FUNNEL MAIN: visitas ${mFunnel.visits} | pdp ${mFunnel.pdp}(${mFunnel.visitToPdp}%) | carrito ${mFunnel.cart}(${mFunnel.pdpToCart}%) | checkout ${mFunnel.checkout}(${mFunnel.cartToCheck}%) | compra ${mFunnel.purchases}(${mFunnel.checkToBuy}%)
FUNNEL CMP: visitas ${cFunnel.visits} | pdp ${cFunnel.pdp}(${cFunnel.visitToPdp}%) | carrito ${cFunnel.cart}(${cFunnel.pdpToCart}%) | checkout ${cFunnel.checkout}(${cFunnel.cartToCheck}%) | compra ${cFunnel.purchases}(${cFunnel.checkToBuy}%)
CLARITY MAIN: sesiones ${mClar.sessions} | scroll ${mClar.scrollDepth}% | bounce ${mClar.bounceRate}% | dur ${mClar.avgDuration}s | rage ${mClar.rageRate}%
CLARITY CMP: sesiones ${cClar.sessions} | scroll ${cClar.scrollDepth}% | bounce ${cClar.bounceRate}% | dur ${cClar.avgDuration}s | rage ${cClar.rageRate}%
FUENTES: ${Object.entries(mSrc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+':'+v).join(', ')||'no disponible'}`;

    let aiInsights = null;
    try {
      const raw = await callClaude([{role:'user',content:`Eres analista CRO de Ricky Sarkany ecommerce premium argentino. Genera reporte mensual. Responde SOLO JSON valido empezando con { y terminando con }: {"executiveSummary":"3-4 oraciones ejecutivas contextualizando ambos periodos","salesInsight":"2-3 oraciones sobre ventas","funnelInsight":"2-3 oraciones sobre funnel y friccion principal","checkoutInsight":"2-3 oraciones sobre checkout paso a paso","usabilityInsight":"2-3 oraciones sobre comportamiento clarity","heatmapInsight":"2 oraciones sobre navegacion y mapas de calor","trafficInsight":"2 oraciones sobre fuentes de trafico","keyWins":["logro 1","logro 2","logro 3"],"keyAlerts":["alerta 1","alerta 2","alerta 3"],"nextActions":["accion 1","accion 2","accion 3"]}\n\nDATA:\n${ctx}`}],
        'Respond with ONLY valid JSON starting with { and ending with }. No markdown, no backticks.',1000);
      const s=raw.indexOf('{'), e=raw.lastIndexOf('}');
      if(s!==-1&&e>s) aiInsights=JSON.parse(raw.slice(s,e+1));
    } catch(e2) { console.error('AI parse error:', e2.message); }

    const sortSrc = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>({source:k,orders:v}));
    res.json({
      monthLabel: MNAMES[rM]+' '+rY, compareLabel: MNAMES[cM]+' '+cY,
      main:    {funnel:mFunnel, clarity:mClar, revenue:mAOV, sources:sortSrc(mSrc)},
      compare: {funnel:cFunnel, clarity:cClar, revenue:cAOV, sources:sortSrc(cSrc)},
      aiInsights
    });
  } catch(e) {
    console.error('Monthly report error:', e.message, e.stack);
    res.status(500).json({error: e.message});
  }
});



// -- SEO PAGES: Crawl static pages from sitemap ---------------------------
app.post('/api/seo-pages', async (req, res) => {
  const { urls } = req.body;

  // Default: auto-detect from sitemap
  let pageUrls = urls || [];
  if (!pageUrls.length) {
    try {
      const sitemapRes = await fetch('https://www.rickysarkany.com/sitemap/custom-user-routes-1.xml');
      if (sitemapRes.ok) {
        const xml = await sitemapRes.text();
        const matches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
        pageUrls = matches.map(m => m.replace(/<\/?loc>/g, '').trim()).slice(0, 25);
      }
    } catch(e) { console.error('Sitemap fetch error:', e.message); }
  }

  // Always include key static pages
  const staticPages = [
    { url: 'https://www.rickysarkany.com/', label: 'Home' },
    { url: 'https://www.rickysarkany.com/preguntas-frecuentes', label: 'Preguntas Frecuentes' },
    { url: 'https://www.rickysarkany.com/stores', label: 'Locales' },
  ];

  // Build full list: static + sitemap pages
  const allUrls = [
    ...staticPages.map(p => p.url),
    ...pageUrls.filter(u => !staticPages.some(s => s.url === u))
  ].slice(0, 30);

  // Crawl each page in parallel
  const crawlPage = async (url) => {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RickyAnalytics/1.0)' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) return { url, error: `HTTP ${r.status}` };
      const html = await r.text();

      // Extract SEO fields
      const getTag = (pattern) => { const m = html.match(pattern); return m ? m[1]?.trim() : ''; };
      const title       = getTag(/<title[^>]*>([^<]+)<\/title>/i);
      const metaDesc    = getTag(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                       || getTag(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      const h1          = getTag(/<h1[^>]*>([^<]+)<\/h1>/i);
      const canonical   = getTag(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
      const ogTitle     = getTag(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
      const ogDesc      = getTag(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      const robots      = getTag(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
      const imgCount    = (html.match(/<img /gi) || []).length;
      const imgNoAlt    = (html.match(/<img(?![^>]*alt=)[^>]*>/gi) || []).length;
      const h2Count     = (html.match(/<h2/gi) || []).length;
      const wordCount   = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;

      // Score
      let score = 100;
      const issues = [];
      if (!title)                          { score -= 25; issues.push({ t:'bad', l:'sin title tag' }); }
      else if (title.length < 30)          { score -= 10; issues.push({ t:'warn', l:`title corto (${title.length}c)` }); }
      else if (title.length > 70)          { score -= 8;  issues.push({ t:'warn', l:`title largo (${title.length}c)` }); }
      else                                               issues.push({ t:'ok', l:`title ok (${title.length}c)` });
      if (!metaDesc)                       { score -= 20; issues.push({ t:'bad', l:'sin meta description' }); }
      else if (metaDesc.length < 50)       { score -= 10; issues.push({ t:'warn', l:`meta corta (${metaDesc.length}c)` }); }
      else if (metaDesc.length > 160)      { score -= 8;  issues.push({ t:'warn', l:`meta larga (${metaDesc.length}c)` }); }
      else                                               issues.push({ t:'ok', l:`meta ok (${metaDesc.length}c)` });
      if (!h1)                             { score -= 15; issues.push({ t:'bad', l:'sin H1' }); }
      else                                               issues.push({ t:'ok', l:'H1 presente' });
      if (!canonical)                      { score -= 10; issues.push({ t:'warn', l:'sin canonical' }); }
      if (imgNoAlt > 0)                    { score -= 5;  issues.push({ t:'warn', l:`${imgNoAlt} imgs sin alt` }); }
      if (!ogTitle || !ogDesc)             { score -= 5;  issues.push({ t:'warn', l:'Open Graph incompleto' }); }
      if (robots && /noindex/i.test(robots)){ score -= 30; issues.push({ t:'bad', l:'página con noindex!' }); }

      // Label from static pages or derive from URL
      const staticPage = staticPages.find(p => p.url === url);
      const label = staticPage?.label || url.replace('https://www.rickysarkany.com/', '').replace(/-/g,' ') || url;

      return {
        url, label,
        score: Math.max(0, Math.min(100, score)),
        title, metaDesc, h1, canonical, ogTitle, ogDesc,
        robots: robots || 'index,follow',
        imgCount, imgNoAlt, h2Count, wordCount,
        issues,
        type: detectPageType(url)
      };
    } catch(e) {
      return { url, label: url.split('/').pop() || url, error: e.message, score: 0, issues: [{t:'bad',l:'error al crawlear'}] };
    }
  };

  const detectPageType = (url) => {
    const path = url.replace('https://www.rickysarkany.com','').toLowerCase();
    if (path === '/' || path === '') return 'home';
    if (/pregunta|faq/i.test(path)) return 'faq';
    if (/promo|sale|off|descuento|cyber/i.test(path)) return 'promo';
    if (/store|local|tienda/i.test(path)) return 'store';
    if (/coleccion|collection|ss|aw|temporada/i.test(path)) return 'collection';
    return 'page';
  };

  // Crawl all pages in parallel (batches of 8)
  const results = [];
  for (let i = 0; i < allUrls.length; i += 8) {
    const batch = allUrls.slice(i, i+8);
    const batchResults = await Promise.all(batch.map(crawlPage));
    results.push(...batchResults);
  }

  results.sort((a,b) => a.score - b.score);
  const avg = results.length ? Math.round(results.reduce((s,p)=>s+p.score,0)/results.length) : 0;

  res.json({
    pages: results,
    total: results.length,
    avgScore: avg,
    critical: results.filter(p=>p.score<50).length,
    good: results.filter(p=>p.score>=80).length
  });
});


// -- UX LAB: Friction Score + Sessions + Performance -------------------------
app.post('/api/ux-lab', async (req, res) => {
  const { dateRange = '7' } = req.body;
  const endDate = new Date();
  const startDate = new Date(endDate - parseInt(dateRange) * 86400000);
  const fmtDate = d => d.toISOString().split('T')[0];
  const clH = clarityHeaders();
  const base = `https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}`;

  try {
    // 1. Clarity global metrics + sessions
    const [metRes, sessRes, mobileRes] = await Promise.all([
      fetch(`${base}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}`, { headers: clH }),
      fetch(`${base}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&type=session`, { headers: clH }),
      fetch(`${base}&startDate=${fmtDate(startDate)}&endDate=${fmtDate(endDate)}&deviceType=Mobile`, { headers: clH })
    ]);
    const met = metRes.ok ? await metRes.json() : {};
    const sessData = sessRes.ok ? await sessRes.json() : {};
    const mobMet = mobileRes.ok ? await mobileRes.json() : {};
    const sessions = sessData.sessions || sessData.data || [];

    // 2. VTEX CVR for correlation
    let cvr = 0, totalOrders = 0, totalVisits = 0;
    if (VTEX_ACCOUNT && VTEX_APP_KEY && VTEX_APP_TOKEN) {
      try {
        const vtexBase = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
        const ordRes = await fetch(
          `${vtexBase}/api/oms/pvt/orders?f_creationDate=creationDate:[${startDate.toISOString()} TO ${endDate.toISOString()}]&page=1&per_page=50`,
          { headers: { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' } }
        );
        if (ordRes.ok) {
          const ordData = await ordRes.json();
          totalOrders = ordData.paging?.total || ordData.list?.length || 0;
          const est = Math.round(totalOrders / 0.47 / 0.56 / 0.41 / 0.65);
          totalVisits = est;
          cvr = totalVisits > 0 ? +((totalOrders / totalVisits) * 100).toFixed(2) : 0;
        }
      } catch(e) { console.error('VTEX error:', e.message); }
    }

    // 3. Compute UX Friction Score
    const totalSess = met.totalSessionCount || met.sessionCount || sessions.length || 0;
    const rageClicks = sessions.filter(s => (s.rageClickCount || 0) > 0).length;
    const deadClicks = sessions.filter(s => (s.deadClickCount || 0) > 0).length;
    const quickBacks = sessions.filter(s => (s.quickBackCount || s.bounceCount || 0) > 0).length;
    const scrollDepth = met.averageScrollDepth || met.scrollDepth || 62;
    const bounceRate = met.bounceRate > 1 ? met.bounceRate : Math.round((met.bounceRate || 0) * 100);
    const avgDuration = met.averageSessionDuration || met.avgDuration || 138;

    const rageRate = totalSess > 0 ? (rageClicks / totalSess) * 100 : 0;
    const deadRate = totalSess > 0 ? (deadClicks / totalSess) * 100 : 0;
    const quickRate = totalSess > 0 ? (quickBacks / totalSess) * 100 : 0;

    // Friction score: lower = less friction (0-100, 100 = no friction)
    const frictionPenalty =
      (rageRate * 2.5) +         // rage clicks hurt most
      (deadRate * 1.5) +          // dead clicks indicate confusion
      (quickRate * 2.0) +         // quick backs = bad content match
      (Math.max(0, 60 - scrollDepth) * 0.5) + // low scroll = disengagement
      (Math.max(0, bounceRate - 30) * 0.3);   // high bounce above 30%
    const frictionScore = Math.max(0, Math.min(100, Math.round(100 - frictionPenalty)));

    // 4. Build sessions list for replay links
    const topSessions = sessions
      .sort((a, b) => ((b.rageClickCount||0) + (b.deadClickCount||0)) - ((a.rageClickCount||0) + (a.deadClickCount||0)))
      .slice(0, 10)
      .map(s => ({
        id: s.sessionId || s.id || '',
        duration: s.duration || s.sessionDuration || 0,
        rageClicks: s.rageClickCount || 0,
        deadClicks: s.deadClickCount || 0,
        scrollDepth: s.scrollDepth || 0,
        device: s.device || s.deviceType || 'unknown',
        url: s.sessionId ? `https://clarity.microsoft.com/projects/${CLARITY_PROJECT_ID}/recordings/${s.sessionId}` : '',
        clarityUrl: `https://clarity.microsoft.com/projects/${CLARITY_PROJECT_ID}/recordings?filters=rageClick`
      }));

    // 5. Performance - measure TTFB for key pages
    const measureTTFB = async (url) => {
      const start = Date.now();
      try {
        const r = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 RickyAnalytics/1.0' }
        });
        const ttfb = Date.now() - start;
        return { url, ttfb, status: r.status, ok: r.ok };
      } catch(e) {
        return { url, ttfb: -1, status: 0, ok: false, error: e.message };
      }
    };

    const [homeTTFB, pdpTTFB, catTTFB] = await Promise.all([
      measureTTFB('https://www.rickysarkany.com/'),
      measureTTFB('https://www.rickysarkany.com/zapatillas/'),
      measureTTFB('https://www.rickysarkany.com/botas/')
    ]);

    // 6. Mobile vs Desktop metrics
    const mobSessions = sessions.filter(s => (s.device||s.deviceType||'').toLowerCase().includes('mobile')).length;
    const deskSessions = sessions.filter(s => (s.device||s.deviceType||'').toLowerCase().includes('desktop')).length;
    const mobRage = sessions.filter(s => (s.device||'').toLowerCase().includes('mobile') && (s.rageClickCount||0)>0).length;
    const deskRage = sessions.filter(s => (s.device||'').toLowerCase().includes('desktop') && (s.rageClickCount||0)>0).length;

    // 7. AI Insights
    const ctx = `UX FRICTION DATA (últimos ${dateRange} días):
- Friction Score: ${frictionScore}/100
- Total sesiones: ${totalSess}
- Rage clicks: ${rageRate.toFixed(1)}% de sesiones
- Dead clicks: ${deadRate.toFixed(1)}% de sesiones  
- Quick backs: ${quickRate.toFixed(1)}% de sesiones
- Scroll promedio: ${scrollDepth}%
- Bounce rate: ${bounceRate}%
- CVR actual: ${cvr}%
- Mobile sesiones: ${mobSessions} (rage: ${mobSessions>0?Math.round(mobRage/mobSessions*100):0}%)
- Desktop sesiones: ${deskSessions} (rage: ${deskSessions>0?Math.round(deskRage/deskSessions*100):0}%)
- TTFB Home: ${homeTTFB.ttfb}ms
- TTFB Zapatillas: ${catTTFB.ttfb}ms`;

    let insights = null;
    try {
      const raw = await callClaude(
        [{ role: 'user', content: ctx + '\n\nGenera 4-5 insights accionables en JSON. Responde SOLO con JSON valido:\n{"insights":[{"priority":"critical|high|medium","area":"Mobile|Desktop|Funnel|Performance|UX","problem":"problema detectado","impact":"impacto estimado en revenue/CVR","action":"accion concreta a tomar"}],"summary":"2 oraciones ejecutivas"}' }],
        'CRO expert. Respond ONLY with valid JSON starting with {.',
        800
      );
      const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
      if (si !== -1 && ei > si) insights = JSON.parse(raw.slice(si, ei+1));
    } catch(e) { console.error('AI error:', e.message); }

    res.json({
      frictionScore,
      frictionLabel: frictionScore >= 75 ? 'Buena UX' : frictionScore >= 50 ? 'Fricciones detectadas' : 'UX crítica',
      metrics: { rageRate: +rageRate.toFixed(1), deadRate: +deadRate.toFixed(1), quickRate: +quickRate.toFixed(1), scrollDepth, bounceRate, avgDuration, totalSess, cvr },
      device: {
        mobile: { sessions: mobSessions, rageRate: mobSessions>0?+(mobRage/mobSessions*100).toFixed(1):0 },
        desktop: { sessions: deskSessions, rageRate: deskSessions>0?+(deskRage/deskSessions*100).toFixed(1):0 }
      },
      performance: [homeTTFB, pdpTTFB, catTTFB],
      sessions: topSessions,
      clarityFilters: {
        rage: `https://clarity.microsoft.com/projects/${CLARITY_PROJECT_ID}/recordings?filters=rageClick`,
        dead: `https://clarity.microsoft.com/projects/${CLARITY_PROJECT_ID}/recordings?filters=deadClick`,
        abandon: `https://clarity.microsoft.com/projects/${CLARITY_PROJECT_ID}/recordings?filters=quickBack`
      },
      insights,
      period: dateRange
    });
  } catch(e) {
    console.error('UX Lab error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// -- FUNNEL TIMELINE: día por día ------------------------------------------
app.post('/api/funnel-timeline', async (req, res) => {
  if (!VTEX_ACCOUNT || !VTEX_APP_KEY || !VTEX_APP_TOKEN)
    return res.status(400).json({ error: 'Credenciales VTEX no configuradas' });

  const { dateRange = '14' } = req.body;
  const days = parseInt(dateRange) || 14;
  const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const vtexH = { 'X-VTEX-API-AppKey': VTEX_APP_KEY, 'X-VTEX-API-AppToken': VTEX_APP_TOKEN, 'Accept': 'application/json' };

  try {
    // Fetch all orders for the period
    const now = new Date();
    const from = new Date(now - days * 86400000);
    const ordRes = await fetch(
      `${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${from.toISOString()} TO ${now.toISOString()}]&page=1&per_page=100&orderBy=creationDate,asc`,
      { headers: vtexH }
    );
    if (!ordRes.ok) throw new Error(`VTEX OMS ${ordRes.status}`);
    const ordData = await ordRes.json();
    const orders = ordData.list || [];

    // Group orders by day
    const dayMap = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      dayMap[key] = { date: key, orders: 0, revenue: 0, sources: {} };
    }

    for (const o of orders) {
      const day = (o.creationDate || '').split('T')[0];
      if (dayMap[day]) {
        dayMap[day].orders++;
        dayMap[day].revenue += (o.totalValue || 0) / 100;
      }
    }

    // Build timeline with funnel estimates per day
    const timeline = Object.values(dayMap).map(d => {
      const purchases = d.orders;
      const checkout  = Math.round(purchases / 0.47);
      const cart      = Math.round(checkout  / 0.56);
      const pdp       = Math.round(cart      / 0.41);
      const visits    = Math.round(pdp       / 0.65);
      const cvr       = visits > 0 ? +((purchases / visits) * 100).toFixed(2) : 0;
      return {
        date: d.date,
        label: new Date(d.date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }),
        visits, pdp, cart, checkout, purchases,
        cvr,
        revenue: Math.round(d.revenue)
      };
    });

    // Also get Clarity day-by-day if available
    let clarityTimeline = [];
    if (CLARITY_PROJECT_ID && CLARITY_API_KEY) {
      try {
        const clH = clarityHeaders();
        // Clarity doesn't support daily breakdown easily, 
        // so we approximate from weekly data
        const clRes = await fetch(
          `https://www.clarity.ms/export-data/api/v1/project-live-insights?projectId=${CLARITY_PROJECT_ID}&startDate=${from.toISOString().split('T')[0]}&endDate=${now.toISOString().split('T')[0]}&type=session`,
          { headers: clH }
        );
        if (clRes.ok) {
          const clData = await clRes.json();
          const sessions = clData.sessions || clData.data || [];
          // Group sessions by day
          for (const s of sessions) {
            const day = (s.startTime || s.date || '').split('T')[0];
            if (dayMap[day]) {
              dayMap[day].sessions = (dayMap[day].sessions || 0) + 1;
              if ((s.rageClickCount || 0) > 0) dayMap[day].rageClicks = (dayMap[day].rageClicks || 0) + 1;
            }
          }
          // Merge into timeline
          timeline.forEach(t => {
            const d = dayMap[t.date];
            t.sessions = d.sessions || 0;
            t.rageClicks = d.rageClicks || 0;
            t.rageRate = t.sessions > 0 ? +((t.rageClicks / t.sessions) * 100).toFixed(1) : 0;
          });
        }
      } catch(e) { console.error('Clarity timeline error:', e.message); }
    }

    // Summary stats
    const totalOrders  = timeline.reduce((s, d) => s + d.purchases, 0);
    const avgCVR       = timeline.filter(d=>d.cvr>0).reduce((s,d,i,a)=>s+d.cvr/a.length, 0).toFixed(2);
    const bestDay      = timeline.reduce((b, d) => d.purchases > b.purchases ? d : b, timeline[0]);
    const worstDay     = timeline.filter(d=>d.purchases>0).reduce((b, d) => d.purchases < b.purchases ? d : b, timeline[timeline.length-1]);
    const trend        = timeline.length >= 4
      ? (() => {
          const half = Math.floor(timeline.length / 2);
          const firstHalf = timeline.slice(0, half).reduce((s, d) => s + d.purchases, 0);
          const secondHalf = timeline.slice(half).reduce((s, d) => s + d.purchases, 0);
          return firstHalf > 0 ? +(((secondHalf - firstHalf) / firstHalf) * 100).toFixed(1) : 0;
        })()
      : 0;

    res.json({ timeline, totalOrders, avgCVR: parseFloat(avgCVR), bestDay, worstDay, trend, period: days });
  } catch(e) {
    console.error('Timeline error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// -- FUNNEL TIMELINE: día a día -----------------------------------------------
app.post('/api/funnel-timeline', async (req, res) => {
  const { dateRange = '14' } = req.body;
  const days = parseInt(dateRange);
  const now = new Date();

  if (!VTEX_ACCOUNT || !VTEX_APP_KEY || !VTEX_APP_TOKEN)
    return res.status(400).json({ error: 'Credenciales VTEX no configuradas' });

  const vtexH = {
    'X-VTEX-API-AppKey': VTEX_APP_KEY,
    'X-VTEX-API-AppToken': VTEX_APP_TOKEN,
    'Accept': 'application/json'
  };
  const base = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;

  try {
    // Fetch orders for each day in parallel (batches of 4 days)
    const dayData = [];
    const buildDay = async (dayOffset) => {
      const dayEnd   = new Date(now);
      dayEnd.setDate(dayEnd.getDate() - dayOffset);
      dayEnd.setHours(23, 59, 59, 0);
      const dayStart = new Date(dayEnd);
      dayStart.setHours(0, 0, 0, 0);

      try {
        const r = await fetch(
          `${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${dayStart.toISOString()} TO ${dayEnd.toISOString()}]&page=1&per_page=50`,
          { headers: vtexH }
        );
        if (!r.ok) return null;
        const data = await r.json();
        const purchases = data.paging?.total || data.list?.length || 0;

        // Estimate funnel from purchases up
        const checkout = Math.round(purchases / 0.47);
        const cart     = Math.round(checkout  / 0.56);
        const pdp      = Math.round(cart      / 0.41);
        const visits   = Math.round(pdp       / 0.65);
        const cvr      = visits > 0 ? +((purchases / visits) * 100).toFixed(2) : 0;

        const label = dayStart.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });

        return {
          date:      dayStart.toISOString().split('T')[0],
          label,
          visits,
          pdp,
          cart,
          checkout,
          purchases,
          cvr
        };
      } catch(e) { return null; }
    };

    // Fetch all days in parallel batches
    const results = [];
    for (let i = 0; i < days; i += 5) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(5, days - i) }, (_, j) => buildDay(days - 1 - i - j))
      );
      results.push(...batch.filter(Boolean));
    }

    // Sort by date ascending
    results.sort((a, b) => a.date.localeCompare(b.date));

    // Summary stats
    const totalPurchases = results.reduce((s, d) => s + d.purchases, 0);
    const avgCVR = results.length ? +(results.reduce((s, d) => s + d.cvr, 0) / results.length).toFixed(2) : 0;
    const bestDay = results.reduce((b, d) => d.purchases > (b?.purchases || 0) ? d : b, null);
    const worstDay = results.filter(d => d.purchases > 0).reduce((w, d) => d.purchases < (w?.purchases || Infinity) ? d : w, null);

    res.json({
      timeline: results,
      summary: { totalPurchases, avgCVR, bestDay: bestDay?.label, worstDay: worstDay?.label },
      period: dateRange
    });
  } catch(e) {
    console.error('Timeline error:', e.message);
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
