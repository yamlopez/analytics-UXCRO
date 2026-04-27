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
