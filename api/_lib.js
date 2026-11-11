// Biblioteca comum das funções da Vercel: Redis (REST do Upstash), login e respostas.
import crypto from 'node:crypto';

export const K = {
  retrato: 'moises:retrato',
  recebidoEm: 'moises:recebidoEm',
  cmds: 'moises:cmds',
  logs: 'moises:logs',
  tentativas: (ip) => `moises:login:${ip}`,
};

const COOKIE = 'moises';
const VALIDADE_S = 30 * 24 * 3600;
export const EXPIRA_CMD_MS = 120_000;

// ---------- Redis ----------
function credRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis não configurado');
  return { url, token };
}

export async function redis(...cmd) {
  const { url, token } = credRedis();
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

export async function pipeline(cmds) {
  if (!cmds.length) return [];
  const { url, token } = credRedis();
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  return j.map((x) => {
    if (x.error) throw new Error(`Redis: ${x.error}`);
    return x.result;
  });
}

export function hashParaObjetos(arr) {
  const out = [];
  for (let i = 0; arr && i < arr.length; i += 2) {
    try {
      out.push(JSON.parse(arr[i + 1]));
    } catch {
      /* ignora valor corrompido */
    }
  }
  return out;
}

// ---------- HTTP ----------
export function json(res, status, corpo, extra = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(corpo));
}

export async function lerCorpo(req, limite = 2_000_000) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const partes = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limite) throw Object.assign(new Error('Corpo grande demais'), { status: 413 });
    partes.push(c);
  }
  const txt = Buffer.concat(partes).toString('utf8');
  return txt ? JSON.parse(txt) : {};
}

// POST/PATCH do painel exigem JSON: um formulário de outro site não consegue mandar esse tipo sem CORS.
export function exigeJson(req) {
  return String(req.headers['content-type'] || '').startsWith('application/json');
}

export function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
}

// ---------- Senha e sessão ----------
// PANEL_PASSWORD_HASH = "scrypt$<salt hex>$<hash hex>"
export function conferirSenha(senha, guardado = process.env.PANEL_PASSWORD_HASH) {
  if (!guardado || typeof senha !== 'string' || !senha) return false;
  const [alg, saltHex, hashHex] = guardado.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calc = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(calc, esperado);
}

export function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(senha, salt, 32).toString('hex')}`;
}

function assinar(texto) {
  const seg = process.env.SESSION_SECRET;
  if (!seg || seg.length < 32) throw new Error('SESSION_SECRET ausente');
  return crypto.createHmac('sha256', seg).update(texto).digest('base64url');
}

export function cookieDeSessao(agora = Date.now()) {
  const exp = Math.floor(agora / 1000) + VALIDADE_S;
  const valor = `${exp}.${assinar(String(exp))}`;
  return `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${VALIDADE_S}`;
}

export const cookieApagado = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function sessaoValida(req, agora = Date.now()) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)moises=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) * 1000 < agora) return false;
  const esperado = Buffer.from(assinar(exp));
  const recebido = Buffer.from(sig);
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

export function exigeLogin(req, res) {
  if (sessaoValida(req)) return true;
  json(res, 401, { erro: 'Faça login.' });
  return false;
}

export function tokenColetorValido(req) {
  const esperado = process.env.MOISES_TOKEN;
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!esperado || esperado.length < 32 || !m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

// Envolve o handler: erros viram 500 genérico sem detalhes internos.
export function rota(metodos, fn) {
  return async (req, res) => {
    if (!metodos.includes(req.method)) return json(res, 405, { erro: 'Método não permitido.' }, { allow: metodos.join(', ') });
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SyntaxError) return json(res, 400, { erro: 'JSON inválido.' });
      if (err.status === 413) return json(res, 413, { erro: err.message });
      console.error('[moises]', req.method, req.url, err.message);
      json(res, 500, { erro: 'Erro interno.' });
    }
  };
}
