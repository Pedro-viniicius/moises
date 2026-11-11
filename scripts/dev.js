#!/usr/bin/env node
// Servidor local que imita a Vercel: public/ estático + api/*.js, com Redis em memória.
// Uso: PORT=3800 node scripts/dev.js   (lê ~/.config/moises/vercel.env para senha e tokens)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instalarRedisFalso } from './redis-memoria.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const l of fs.readFileSync(path.join(os.homedir(), '.config/moises/vercel.env'), 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) process.env[l.slice(0, i)] ??= l.slice(i + 1);
  }
} catch {
  console.error('Rode antes: node scripts/configurar.js <url>');
}
instalarRedisFalso();
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const cabecalhos = JSON.parse(fs.readFileSync(path.join(raiz, 'vercel.json'), 'utf8')).headers[0].headers;

http
  .createServer(async (req, res) => {
    for (const { key, value } of cabecalhos) if (key !== 'Strict-Transport-Security') res.setHeader(key, value);
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (m) {
      const arq = path.join(raiz, 'api', `${m[1]}.js`);
      if (!fs.existsSync(arq)) return res.writeHead(404).end();
      const handler = (await import(arq)).default;
      return handler(req, res);
    }
    let p = path.join(raiz, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!p.startsWith(path.join(raiz, 'public'))) return res.writeHead(403).end();
    if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end('404');
    res.writeHead(200, { 'content-type': tipos[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  })
  .listen(Number(process.env.PORT || 3800), '127.0.0.1', () => console.log(`painel local em http://localhost:${process.env.PORT || 3800}`));
