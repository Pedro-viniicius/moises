// Biblioteca comum das funções da Vercel: Redis (REST do Upstash), login e respostas.
import crypto from 'node:crypto';

export const K = {
  retrato: 'moises:retrato',
  recebidoEm: 'moises:recebidoEm',
  cmds: 'moises:cmds',
  // Resultado de cada etapa do comando, gravado uma vez só (HSETNX): o estado só avança (R9, S20).
  cmdsRec: 'moises:cmds-rec',
  cmdsFim: 'moises:cmds-fim',
  logs: 'moises:logs',
  painelVistoEm: 'moises:painelVistoEm',
  aparelhosPedidos: 'moises:aparelhos-pedidos',
  tentativas: (ip) => `moises:login:${ip}`,
};

const COOKIE = 'moises';
const VALIDADE_S = 30 * 24 * 3600;
// Comando pendente há 2 min expira: a mesma regra de EXPIRA_MS em collector/encerrar.js (lá, o pedido de
// encerrar mais velho que isso é recusado).
const EXPIRA_CMD_MS = 120_000;

// ---------- Comandos ----------
// O servidor só transporta: confere formato, nunca a assinatura (a chave fica no aparelho e no coletor).
export const TIPOS_CMD = ['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar'];
export const RE_CHAVE = /^[a-z0-9]{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Os 6 primeiros hexadecimais do SHA-256 da chave pública, como o coletor e /api/aparelho conferem (SE-B3).
export const RE_KID = /^[0-9a-f]{6}$/;
// ECDSA P-256 em IEEE P1363 (64 bytes) e base64url sem '=' (tarefa 15). A assinatura HMAC do código do
// aparelho (43 caracteres) não passa daqui.
export const RE_ASSINATURA = /^[A-Za-z0-9_-]{86}$/;
export const MAX_PENDENTES = 20;

// ---------- Pedidos de pareamento de aparelho ----------
// O painel guarda a chave pública que o aparelho gerou; o coletor a leva para o computador, onde o dono
// confere a impressão digital e autoriza pelo terminal. O servidor só transporta (achado A1).
export const MAX_PEDIDOS_APARELHO = 5;
const VALIDADE_PEDIDO_APARELHO_MS = 3_600_000;

// Separa os pedidos guardados (resultado de HGETALL) em válidos (mais novos que 1 h) e vencidos.
export function pedidosDeAparelho(hashArr, agora) {
  const validos = [];
  const vencidos = [];
  for (let i = 0; hashArr && i < hashArr.length; i += 2) {
    let p = null;
    try {
      p = JSON.parse(hashArr[i + 1]);
    } catch {
      /* valor corrompido: vence */
    }
    if (p && typeof p === 'object' && Number.isFinite(p.criadoEm) && agora - p.criadoEm < VALIDADE_PEDIDO_APARELHO_MS) validos.push(p);
    else vencidos.push(hashArr[i]);
  }
  return { validos, vencidos };
}

// Hora do servidor em que o comando chegou; registros antigos só têm criadoEm.
export const chegadaDoComando = (c) => (Number.isFinite(c.recebidoNoServidorEm) ? c.recebidoNoServidorEm : c.criadoEm);

// Tira do comando o que o painel nunca pode ver de volta e o Redis não precisa mais guardar.
export function esquecerConteudo(c) {
  delete c.dados;
  delete c.assinatura;
}

// Única regravação do objeto de moises:cmds depois de criado (o HSETNX de /api/comando é a única gravação
// com conteúdo): sempre sem dados nem assinatura. Assim um escritor atrasado, que leu o comando antes de
// outro esquecer o conteúdo, não consegue devolvê-lo ao Redis.
export function gravarSemConteudo(c) {
  esquecerConteudo(c);
  return ['HSET', K.cmds, c.id, JSON.stringify(c)];
}

// Apaga o comando e o resultado das etapas dele (limpeza depois de 24 h).
export const apagarComando = (id) => [
  ['HDEL', K.cmds, id],
  ['HDEL', K.cmdsRec, id],
  ['HDEL', K.cmdsFim, id],
];

// ---------- Estado do comando: só anda para a frente ----------
// pendente/expirado → recebido → feito | falhou | recusado. O expirado aceita o resultado porque o coletor
// pode ter recebido o comando pouco antes de o servidor expirá-lo.
export const ORDEM_ESTADO = { pendente: 0, expirado: 0, recebido: 1, feito: 2, falhou: 2, recusado: 2 };
const FINAIS = ['feito', 'falhou', 'recusado'];

// O estado mostrado junta três registros (R9, S20):
// - moises:cmds: o comando como o aparelho mandou, com `estado` pendente ou expirado (e, nos registros
//   gravados antes das chaves abaixo existirem, o estado que o ingest gravava no próprio objeto);
// - moises:cmds-rec: a hora em que o coletor confirmou o recebimento;
// - moises:cmds-fim: o resultado final, JSON {estado, erro, motivo, feitoEm, chaveNova?}.
// Os dois últimos são gravados com HSETNX: o primeiro vale e ninguém os desfaz. Vale o fim se existir;
// senão o recebido (mesmo que o objeto diga expirado); senão o estado do objeto.
export function juntarComando(c, rec, fim) {
  const v = { ...c };
  let f = null;
  try {
    f = typeof fim === 'string' ? JSON.parse(fim) : null;
  } catch {
    /* fim ilegível: só nós gravamos, com JSON.stringify; fica como se não existisse */
  }
  if (f && typeof f === 'object' && FINAIS.includes(f.estado)) {
    v.estado = f.estado;
    v.erro = typeof f.erro === 'string' ? f.erro : null;
    v.motivo = typeof f.motivo === 'string' ? f.motivo : null;
    v.feitoEm = f.feitoEm;
    if (c.tipo === 'abrir' && typeof f.chaveNova === 'string' && RE_CHAVE.test(f.chaveNova)) v.chave = f.chaveNova;
  } else if (typeof rec === 'string' && !FINAIS.includes(c.estado)) {
    v.estado = 'recebido';
    v.erro = null;
    v.motivo = null;
    // Hora ilegível conta como antiga: o comando vira falhou pelo tempo limite em vez de ficar parado.
    v.recebidoPeloColetorEm = Number.isFinite(Number(rec)) ? Number(rec) : 0;
  }
  return v;
}

// Resultado de HGETALL → Map campo → valor (Map, para um id como __proto__ não virar protótipo).
function hashParaMapa(arr) {
  const m = new Map();
  for (let i = 0; arr && i < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
  return m;
}

// Lê os três hashes (resultado de HGETALL de cmds, cmds-rec e cmds-fim). Devolve, por comando, o objeto
// guardado (para regravar sem conteúdo) e a vista juntada (o estado que vale), mais os mapas rec e fim.
export function lerComandos(cmdsArr, recArr, fimArr) {
  const rec = hashParaMapa(recArr);
  const fim = hashParaMapa(fimArr);
  const itens = hashParaObjetos(cmdsArr)
    .filter((c) => c !== null && typeof c === 'object' && typeof c.id === 'string')
    .map((guardado) => ({ guardado, vista: juntarComando(guardado, rec.get(guardado.id) ?? null, fim.get(guardado.id) ?? null) }));
  return { itens, rec, fim };
}

// Pendente que passou da validade vira expirado e perde dados e assinatura. Devolve a gravação, ou null.
// Se o coletor confirmar ao mesmo tempo, cmds-rec ou cmds-fim prevalecem sobre este expirado.
export function expirarSeVencido(item, agora) {
  const { guardado, vista } = item;
  if (vista.estado !== 'pendente' || agora - chegadaDoComando(guardado) < EXPIRA_CMD_MS) return null;
  vista.estado = 'expirado';
  esquecerConteudo(vista);
  guardado.estado = 'expirado';
  return gravarSemConteudo(guardado);
}

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
