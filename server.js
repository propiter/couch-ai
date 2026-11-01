// Couch AI — backend mínimo (sin dependencias). Node 18+.
// La API key vive SOLO aquí (servidor), nunca en el cliente.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '800', 10);

const SYSTEM = `Eres "Asistente de Sofá", una IA cálida y directa que vive en el televisor de una familia en Colombia.
Respondes en español, en frases cortas y naturales, pensadas para ESCUCHARSE en voz alta (sin markdown, sin listas largas, sin emojis excesivos).
Si te piden sugerencias de qué ver, propón 2 o 3 opciones concretas y breves. Si no sabes algo, dilo con honestidad.
Sé útil, concreto y amable. Evita respuestas largas: el usuario está en el sofá, no leyendo.`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function callClaude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en el servidor.');
        const { message, history } = JSON.parse(body || '{}');
        if (!message) throw new Error('Mensaje vacío.');
        const msgs = [...(Array.isArray(history) ? history.slice(-10) : []), { role: 'user', content: String(message) }];
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

  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const content = await readFile(path.join(__dirname, 'public', file));
    const ext = path.extname(file);
    const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`Couch AI escuchando en :${PORT} (modelo ${MODEL})`));
