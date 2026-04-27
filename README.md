# Ricky Analytics

App local para análisis de VTEX + Microsoft Clarity.

## Módulos
- **SEO Productos** — analiza títulos, meta descriptions, imágenes y contenido de tu catálogo VTEX
- **Funnel** — visualiza el embudo Visita → PDP → Carrito → Checkout → Compra desde Clarity
- **Mapa de Calor** — clics, scroll depth y zonas calientes desde Clarity

## Setup

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar API key
```bash
cp .env.example .env
```
Editá `.env` y poné tu Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
PORT=3000
```

### 3. Correr la app
```bash
npm start
```

Abrí http://localhost:3000

## Requisitos
- Node.js 18+
- API key de Anthropic con acceso a Claude claude-sonnet-4-20250514
- Conectores VTEX y Microsoft Clarity activos en tu cuenta Claude.ai

## Stack
- Backend: Node.js + Express (proxy seguro para la API de Anthropic)
- Frontend: HTML/CSS/JS puro + Chart.js
- APIs: Anthropic Claude con MCP de VTEX y Microsoft Clarity
