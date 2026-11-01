// Couch AI — backend mínimo (sin dependencias). Node 18+.
// La API key vive SOLO aquí (servidor), nunca en el cliente.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '800', 10);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || ''; // si está, se exige en /api/chat
const MAX_BODY = 64 * 1024; // 64 KB
const RATE_MAX = parseInt(process.env.RATE_MAX || '30', 10); // req/min por IP
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAP_MAX = 5000; // tope del mapa de rate-limit (anti-memoria)
// Detrás del Traefik de Dokploy el cliente real es el ÚLTIMO hop de X-Forwarded-For.
const TRUST_PROXY = (process.env.TRUST_PROXY || 'true') === 'true';

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').toString();
    if (xff) return xff.split(',').pop().trim(); // hop añadido por el proxy de confianza
  }
  return (req.socket.remoteAddress || '').toString();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const SYSTEM = `Eres "Asistente de Sofá", una IA cálida y directa que vive en el televisor de una familia en Colombia.
Respondes en español, en frases cortas y naturales, pensadas para ESCUCHARSE en voz alta (sin markdown, sin listas largas, sin emojis excesivos).
Si te piden sugerencias de qué ver, propón 2 o 3 opciones concretas y breves. Si no sabes algo, dilo con honestidad.
Sé útil, concreto y amable. Evita respuestas largas: el usuario está en el sofá, no leyendo.`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
// Lista blanca de archivos estáticos servibles.
const STATIC = { '/': 'index.html', '/index.html': 'index.html' };
const CT = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Rate limit en memoria por IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.start > RATE_WINDOW_MS) {
    if (hits.size >= RATE_MAP_MAX) {
      for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k); // purga expirados
      if (hits.size >= RATE_MAP_MAX) hits.delete(hits.keys().next().value);          // si sigue lleno, el más viejo (LRU)
    }
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  e.n += 1;
  return e.n > RATE_MAX;
}
// Limpieza periódica simple.
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k); }, RATE_WINDOW_MS).unref();

async function callClaude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

// Valida y normaliza history: solo roles válidos y contenido string acotado.
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-10)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);

  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'POST' && req.url === '/api/chat') {
    if (rateLimited(ip)) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"Demasiadas solicitudes, espera un momento."}'); }
    if (ACCESS_TOKEN && !safeEqual(req.headers['x-access-token'] || '', ACCESS_TOKEN)) {
      res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Código de acceso inválido."}');
    }
    if (parseInt(req.headers['content-length'] || '0', 10) > MAX_BODY) { res.writeHead(413); return res.end('too large'); }
    let body = ''; let aborted = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY && !aborted) { aborted = true; res.writeHead(413); res.end('too large'); req.destroy(); }
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en el servidor.');
        const { message, history } = JSON.parse(body || '{}');
        if (!message || typeof message !== 'string') throw new Error('Mensaje vacío.');
        const msgs = [...cleanHistory(history), { role: 'user', content: message.slice(0, 4000) }];
        const reply = await callClaude(msgs);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  // Estáticos: SOLO lista blanca (sin path traversal posible).
  if (req.method === 'GET') {
    const key = req.url.split('?')[0];
    const name = STATIC[key];
    if (name) {
      readFile(path.join(PUBLIC, name))
        .then((content) => { res.writeHead(200, { 'content-type': (CT[path.extname(name)] || 'application/octet-stream') + '; charset=utf-8' }); res.end(content); })
        .catch(() => { res.writeHead(404); res.end('not found'); });
      return;
    }
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`Couch AI escuchando en :${PORT} (modelo ${MODEL}, auth ${ACCESS_TOKEN ? 'ON' : 'OFF'})`));
