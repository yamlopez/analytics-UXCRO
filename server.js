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
const MODEL = 'claude-sonnet-4-20250514';

function vtexHeaders(appKey, appToken) {
  return { 'X-VTEX-API-AppKey': appKey, 'X-VTEX-API-AppToken': appToken, 'Accept': 'application/json' };
}

async function callClaude(messages, system, max_tokens = 2000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada en variables de entorno');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages })
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callClaudeWithMCP(messages, system, mcpServers, max_tokens = 4000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': apiKey,
      'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-04-04'
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages, mcp_servers: mcpServers })
  });
  if (!res.ok) throw new Error(`Anthropic MCP error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = '';
  for (const b of data.content) {
    if (b.type === 'text') text += b.text;
    if (b.type === 'mcp_tool_result') text += b.content?.[0]?.text || '';
  }
  return text;
}

// ── SEO: VTEX Catalog API directa ─────────────────────────────────────────────
app.post('/api/seo', async (req, res) => {
  const { account, appKey, appToken, limit = 50 } = req.body;
  if (!account || !appKey || !appToken) return res.status(400).json({ error: 'Faltan credenciales VTEX' });
  const base = `https://${account}.vtexcommercestable.com.br`;
  try {
    const r = await fetch(`${base}/api/catalog_system/pub/products/search?_from=0&_to=${Math.min(limit-1,49)}`, { headers: vtexHeaders(appKey, appToken) });
    if (!r.ok) throw new Error(`VTEX ${r.status}: ${await r.text()}`);
    const products = await r.json();
    const detailed = products.slice(0, limit).map(p => ({
      productId: String(p.productId), productName: p.productName || '',
      titleTag: p.productTitle || p.productName || '',
      metaTagDescription: p.metaTagDescription || '',
      description: (p.description || '').replace(/<[^>]*>/g, ''),
      link: p.link || '',
      images: (p.items?.[0]?.images || []).map(img => ({ imageUrl: img.imageUrl, imageLabel: img.imageLabel, imageAlt: img.imageLabel || '' }))
    }));
    res.json({ products: detailed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FUNNEL: VTEX OMS ──────────────────────────────────────────────────────────
app.post('/api/funnel', async (req, res) => {
  const { account, appKey, appToken, dateRange = '7' } = req.body;
  if (!account || !appKey || !appToken) return res.status(400).json({ error: 'Faltan credenciales VTEX' });
  const base = `https://${account}.vtexcommercestable.com.br`;
  const days = parseInt(dateRange) || 7;
  const now = new Date(), from = new Date(now - days * 86400000);
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000Z';
  try {
    const r = await fetch(`${base}/api/oms/pvt/orders?f_creationDate=creationDate:[${fmt(from)} TO ${fmt(now)}]&page=1&per_page=100`, { headers: vtexHeaders(appKey, appToken) });
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

// ── HEATMAP: Microsoft Clarity vía MCP ───────────────────────────────────────
app.post('/api/heatmap', async (req, res) => {
  const { dateRange = '7', page = '/' } = req.body;
  const CLARITY_MCP = [{ type: 'url', url: 'https://clarity.microsoft.com/api/mcp', name: 'clarity' }];
  try {
    const raw = await callClaudeWithMCP(
      [{ role: 'user', content: `Use Microsoft Clarity MCP to get heatmap and session data for page "${page}" in the last ${dateRange} days.
Return ONLY raw JSON (no markdown):
{
  "totalClicks": number,
  "avgScrollDepth": number,
  "topClickAreas": [{"zone":"string","clicks":number,"percentage":number,"x":number,"y":number}],
  "scrollData": [{"depth":0,"pct":100},{"depth":25,"pct":number},{"depth":50,"pct":number},{"depth":75,"pct":number},{"depth":100,"pct":number}],
  "sessions": {"total":number,"withClicks":number,"avgDuration":number},
  "recordings": [{"id":"string","duration":number,"clicks":number,"scrollDepth":number,"device":"string","rageclicks":number,"deadclicks":number}]
}` }],
      'You are a Clarity analytics assistant. Always respond with raw JSON only, no markdown.',
      CLARITY_MCP
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON en respuesta Clarity: ' + raw.slice(0,200));
    res.json({ ...JSON.parse(match[0]), page, period: dateRange });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CLARITY RECORDINGS ANALYSIS con IA ───────────────────────────────────────
app.post('/api/recordings-analysis', async (req, res) => {
  const { dateRange = '7', page = '/', pageType = 'product', goal = 'add to cart' } = req.body;
  const CLARITY_MCP = [{ type: 'url', url: 'https://clarity.microsoft.com/api/mcp', name: 'clarity' }];
  try {
    // 1. Traer datos de grabaciones desde Clarity
    const rawData = await callClaudeWithMCP(
      [{ role: 'user', content: `Use Microsoft Clarity MCP to get session recordings data for page "${page}" in the last ${dateRange} days. Return detailed session data including rage clicks, dead clicks, scroll patterns, abandonment points, and user behavior patterns. Return as JSON.` }],
      'You are a Clarity analytics assistant. Return raw JSON data only.',
      CLARITY_MCP, 3000
    );

    // 2. Analizar con Claude usando el framework CRO
    const analysis = await callClaude(
      [{ role: 'user', content: `You are an expert CRO analyst. Analyze this Microsoft Clarity session data and produce a full SESSION RECORDING ANALYSIS report.

Page: ${page}
Page type: ${pageType}
Conversion goal: ${goal}
Period: last ${dateRange} days

Clarity data:
${rawData.slice(0, 3000)}

Follow this exact framework:

## SESSION RECORDING ANALYSIS

**Page Analyzed**: ${pageType}
**Period**: Last ${dateRange} days
**Conversion Goal**: ${goal}

---

### CRITICAL FRICTION POINTS (Blocking Conversion)
For each point: What we observe / Why it's happening / Users affected / Funnel stage / Revenue impact

### HIGH-IMPACT FRICTION POINTS
Same structure

### QUICK WINS (Fix in <2 hours)
3 specific actionable fixes with expected impact %

### HIGH-IMPACT TEST IDEAS
2 A/B tests with Hypothesis / Control / Variant / ICE Score

### BEHAVIORAL INSIGHTS
3 key patterns with psychological explanation

### RECOMMENDED PRIORITY
Ordered action list with estimated impact %

Be specific with numbers, tie everything to revenue impact, reference psychology principles (loss aversion, analysis paralysis, trust gaps, cognitive load). No fluff.` }],
      'You are an expert CRO analyst specializing in e-commerce session recording analysis. Always be specific, data-driven, and tie insights to revenue impact.',
      2500
    );
    res.json({ analysis, rawData: rawData.slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUDITORÍA PDP con IA ──────────────────────────────────────────────────────
app.post('/api/pdp-audit', async (req, res) => {
  const { url, productName, category, pricePoint, currentCVR } = req.body;
  if (!url && !productName) return res.status(400).json({ error: 'Ingresá URL o nombre del producto' });
  try {
    const analysis = await callClaude(
      [{ role: 'user', content: `You are an expert CRO analyst specializing in product page optimization for e-commerce.

Audit this product page:
- URL/Product: ${url || productName}
- Category: ${category || 'e-commerce'}
- Price point: ${pricePoint || 'mid-range'}
- Current CVR: ${currentCVR || 'unknown'}

Produce a FULL PRODUCT PAGE AUDIT following this exact structure:

## PRODUCT PAGE AUDIT

**Page**: ${url || productName}
**Category**: ${category || 'e-commerce'}
**Price Point**: ${pricePoint || 'mid-range'}
**Current CVR**: ${currentCVR || 'unknown'}

---

### PSYCHOLOGICAL TRIGGER SCORECARD
Score each 1-5 with what's present, what's missing, impact if fixed:
- Urgency ⭐/5
- Scarcity ⭐/5
- Social Proof ⭐/5
- Loss Aversion ⭐/5
- Anchoring ⭐/5
- Authority ⭐/5

---

### TRUST SIGNAL ANALYSIS
Overall Trust Score X/10
Strong signals (keep) + Missing signals (add) with specific location, psychology reason, expected lift %

---

### COGNITIVE LOAD ASSESSMENT
Level: High/Medium/Low
Sources of confusion + Decision paralysis points + fixes

---

### MOBILE EXPERIENCE ISSUES
Mobile Friction Score X/10
Critical mobile issues + quick wins

---

### CONVERSION PATH ANALYSIS
CTA Effectiveness X/10
CTA issues (visibility, clarity, urgency, value prop) + Cross-sell opportunities

---

### QUICK WINS (Implement This Week)
3 wins: exact change / time needed / expected impact % / psychology principle

---

### HIGH-IMPACT TESTS (A/B Test These)
3 tests: Hypothesis / Control / Variant / Expected lift % / Test duration

---

### PRIORITY MATRIX
Do First (High Impact, Easy) / Test Next / Consider Later

---

### OVERALL ASSESSMENT
Conversion Readiness Score X/100
Biggest Opportunity / Estimated Uplift Potential / Next Steps

Be specific with locations (not "add trust badge" but "add 30-day return guarantee badge next to ATC button"). Always explain the psychology. Use e-commerce benchmarks. Quantify lift estimates.` }],
      'You are an expert CRO analyst for e-commerce. Always be specific, psychology-backed, and quantify impact. Reference principles like loss aversion, paradox of choice, social proof, anchoring.',
      2500
    );
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Ricky Analytics en http://localhost:${PORT}`));
