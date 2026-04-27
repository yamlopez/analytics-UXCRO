require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

const VTEX_MCP = { type: 'url', url: 'https://claudevtex-production.up.railway.app/mcp', name: 'vtex-mcp' };
const CLARITY_MCP = { type: 'url', url: 'https://mcp.clarity.ms/sse', name: 'clarity-mcp' };

async function callClaude(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'mcp-client-2025-04-04'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }
  return res.json();
}

// --- SEO: traer productos de VTEX ---
app.post('/api/seo', async (req, res) => {
  const { limit = 50 } = req.body;
  try {
    const data = await callClaude({
      model: MODEL,
      max_tokens: 10000,
      system: 'You are a VTEX data extraction assistant. Always respond with only valid raw JSON arrays when asked. No markdown, no backticks, no explanations.',
      messages: [{
        role: 'user',
        content: `Use the VTEX MCP tool to get up to ${limit} products from the catalog.
Return ONLY a raw JSON array. Each product must have:
- productId (string)
- productName (string)
- metaTagDescription (string, can be empty)
- description (string, can be empty, strip HTML tags)
- images: array of {imageUrl, imageLabel, imageAlt} — empty array if none
- link (string)
- titleTag (string — SEO title, can be empty)
Return only the raw JSON array. No prose. No backticks.`
      }],
      mcp_servers: [VTEX_MCP]
    });

    let raw = '';
    for (const b of data.content) {
      if (b.type === 'text') raw += b.text;
      if (b.type === 'mcp_tool_result') raw += b.content?.[0]?.text || '';
    }
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response: ' + raw.slice(0, 300));
    res.json({ products: JSON.parse(match[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- FUNNEL: datos de Microsoft Clarity ---
app.post('/api/funnel', async (req, res) => {
  const { dateRange = '7d' } = req.body;
  try {
    const data = await callClaude({
      model: MODEL,
      max_tokens: 4000,
      system: 'You are a Microsoft Clarity analytics assistant. Always respond with only raw JSON when asked. No markdown, no backticks.',
      messages: [{
        role: 'user',
        content: `Use Microsoft Clarity MCP to get funnel/session data for the last ${dateRange}.
I need conversion funnel data for these 5 steps: Home/Visit, Product Page (PDP), Cart, Checkout, Purchase.

Return ONLY a raw JSON object like:
{
  "funnel": [
    {"step": "Visita", "users": 12000, "dropoff": 0},
    {"step": "PDP", "users": 7800, "dropoff": 35},
    {"step": "Carrito", "users": 3200, "dropoff": 59},
    {"step": "Checkout", "users": 1800, "dropoff": 44},
    {"step": "Compra", "users": 850, "dropoff": 53}
  ],
  "period": "${dateRange}",
  "totalSessions": 12000,
  "conversionRate": 7.08
}

If exact funnel data is not available, use page views by URL pattern (/product/, /checkout/, /orderPlaced/) to estimate. Return real data from Clarity. No prose.`
      }],
      mcp_servers: [CLARITY_MCP]
    });

    let raw = '';
    for (const b of data.content) {
      if (b.type === 'text') raw += b.text;
      if (b.type === 'mcp_tool_result') raw += b.content?.[0]?.text || '';
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Clarity response: ' + raw.slice(0, 300));
    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- HEATMAP: datos de Microsoft Clarity ---
app.post('/api/heatmap', async (req, res) => {
  const { dateRange = '7d', page = '/' } = req.body;
  try {
    const data = await callClaude({
      model: MODEL,
      max_tokens: 6000,
      system: 'You are a Microsoft Clarity analytics assistant. Always respond with only raw JSON when asked. No markdown, no backticks.',
      messages: [{
        role: 'user',
        content: `Use Microsoft Clarity MCP to get heatmap and click data for page "${page}" in the last ${dateRange}.

Return ONLY a raw JSON object:
{
  "page": "${page}",
  "period": "${dateRange}",
  "totalClicks": 4500,
  "avgScrollDepth": 68,
  "topClickAreas": [
    {"zone": "Header - Logo", "clicks": 320, "percentage": 7.1, "x": 50, "y": 5},
    {"zone": "Navegación Principal", "clicks": 890, "percentage": 19.8, "x": 50, "y": 8},
    {"zone": "Banner Principal", "clicks": 1200, "percentage": 26.7, "x": 50, "y": 25},
    {"zone": "Grilla de Productos", "clicks": 1450, "percentage": 32.2, "x": 50, "y": 55},
    {"zone": "Footer", "clicks": 280, "percentage": 6.2, "x": 50, "y": 92},
    {"zone": "CTA Agregar al carrito", "clicks": 360, "percentage": 8.0, "x": 75, "y": 65}
  ],
  "scrollData": [
    {"depth": 0, "pct": 100},
    {"depth": 25, "pct": 82},
    {"depth": 50, "pct": 61},
    {"depth": 75, "pct": 38},
    {"depth": 100, "pct": 19}
  ],
  "sessions": {"total": 5200, "withClicks": 3800, "avgDuration": 142}
}

Use real data from Clarity session recordings and heatmaps. No prose.`
      }],
      mcp_servers: [CLARITY_MCP]
    });

    let raw = '';
    for (const b of data.content) {
      if (b.type === 'text') raw += b.text;
      if (b.type === 'mcp_tool_result') raw += b.content?.[0]?.text || '';
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Clarity response: ' + raw.slice(0, 300));
    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Ricky Analytics corriendo en http://localhost:${PORT}`));
