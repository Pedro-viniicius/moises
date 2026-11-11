import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gerarHashSenha } from '../api/_lib.js';
import login from '../api/login.js';
import logout from '../api/logout.js';
import estado from '../api/estado.js';
import encerrar from '../api/encerrar.js';
import logs from '../api/logs.js';
import ingest from '../api/ingest.js';

// ---------- Redis falso (REST do Upstash) ----------
let db;
function exec([cmd, ...a]) {
  const h = (k) => (db.has(k) ? db.get(k) : db.set(k, new Map()).get(k));
  switch (cmd) {
    case 'GET': return db.get(a[0]) ?? null;
    case 'SET': db.set(a[0], a[1]); return 'OK';
    case 'DEL': return db.delete(a[0]) ? 1 : 0;
    case 'INCR': { const v = Number(db.get(a[0]) || 0) + 1; db.set(a[0], String(v)); return v; }
    case 'EXPIRE': return 1;
    case 'HSET': h(a[0]).set(a[1], a[2]); return 1;
    case 'HGET': return db.get(a[0])?.get(a[1]) ?? null;
    case 'HDEL': return db.get(a[0])?.delete(a[1]) ? 1 : 0;
    case 'HGETALL': return [...(db.get(a[0]) || new Map())].flat();
    default: throw new Error(`comando não simulado: ${cmd}`);
  }
}
globalThis.fetch = async (url, opts) => {
  const corpo = JSON.parse(opts.body);
  const res = String(url).endsWith('/pipeline') ? corpo.map((c) => ({ result: exec(c) })) : { result: exec(corpo) };
  return { json: async () => res };
};

const SENHA = 'abcd-efgh-jkmn-pqrs';
process.env.KV_REST_API_URL = 'https://redis.teste';
process.env.KV_REST_API_TOKEN = 't';
process.env.PANEL_PASSWORD_HASH = gerarHashSenha(SENHA);
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.MOISES_TOKEN = 'y'.repeat(43);

beforeEach(() => {
  db = new Map();
});

async function chamar(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const txt = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(txt ? [Buffer.from(txt)] : []);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...headers }, socket: {} });
  const res = {
    statusCode: 200,
    h: {},
    setHeader(k, v) { this.h[k.toLowerCase()] = v; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
  await handler(req, res);
  return res;
}

async function entrar() {
  const r = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  assert.equal(r.statusCode, 200);
  return r.h['set-cookie'].split(';')[0];
}

const coletor = { authorization: `Bearer ${'y'.repeat(43)}` };
const retrato = (status = 'ativa') => ({ dia: '2026-11-10', totalDia: 1, sessoes: [{ chave: 'principal:s1', projeto: 'p', status, custo: 1 }] });

test('login: cookie seguro, senha errada, bloqueio depois de 5 erros', async () => {
  const cookie = await entrar();
  assert.match(cookie, /^moises=\d+\./);
  const r = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(r.h['set-cookie'].includes(flag));
  for (let i = 0; i < 5; i++) assert.equal((await chamar(login, { method: 'POST', body: { senha: 'errada' } })).statusCode, 401);
  const bloqueado = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  assert.equal(bloqueado.statusCode, 429);
  assert.equal((await chamar(login, { method: 'POST', body: { senha: SENHA }, headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await chamar(login, { method: 'GET' })).statusCode, 405);
});

test('rotas do painel exigem cookie válido', async () => {
  assert.equal((await chamar(estado)).statusCode, 401);
  assert.equal((await chamar(estado, { headers: { cookie: 'moises=9999999999.forjado' } })).statusCode, 401);
  assert.equal((await chamar(logs)).statusCode, 401);
  assert.equal((await chamar(encerrar, { method: 'POST', body: { chave: 'x' } })).statusCode, 401);
  const cookie = await entrar();
  const r = await chamar(estado, { headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { retrato: null, recebidoEm: null, comandos: [] });
  assert.equal((await chamar(logout, { method: 'POST' })).h['set-cookie'].includes('Max-Age=0'), true);
});

test('ingest exige o token do coletor', async () => {
  assert.equal((await chamar(ingest, { method: 'POST', body: {} })).statusCode, 401);
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: { authorization: 'Bearer errado' } })).statusCode, 401);
});

test('fluxo completo: retrato → encerrar → coletor executa → log no histórico, nome editável', async () => {
  const cookie = await entrar();
  await chamar(ingest, { method: 'POST', body: { retrato: retrato() }, headers: coletor });
  const e1 = await chamar(estado, { headers: { cookie } });
  assert.equal(e1.body.retrato.sessoes[0].chave, 'principal:s1');
  assert.ok(e1.body.recebidoEm > 0);

  assert.equal((await chamar(encerrar, { method: 'POST', body: { chave: 'nao-existe' }, headers: { cookie } })).statusCode, 404);
  const pedido = await chamar(encerrar, { method: 'POST', body: { chave: 'principal:s1', nome: '2026-11-10 p – teste' }, headers: { cookie } });
  assert.equal(pedido.statusCode, 200);
  assert.equal((await chamar(encerrar, { method: 'POST', body: { chave: 'principal:s1' }, headers: { cookie } })).statusCode, 409);

  const ing = await chamar(ingest, { method: 'POST', body: { retrato: null }, headers: coletor });
  assert.equal(ing.body.comandos.length, 1);
  const cmd = ing.body.comandos[0];
  assert.equal(cmd.chave, 'principal:s1');
  assert.equal(cmd.nome, '2026-11-10 p – teste');

  await chamar(ingest, { method: 'POST', body: { retrato: retrato('encerrada'), acks: [{ id: cmd.id, ok: true, log: { projeto: 'p', custo: 1.5, duracaoMs: 60000 } }] }, headers: coletor });
  const e2 = await chamar(estado, { headers: { cookie } });
  assert.equal(e2.body.comandos[0].estado, 'feito');
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.comandos.length, 0);
  assert.equal((await chamar(encerrar, { method: 'POST', body: { chave: 'principal:s1' }, headers: { cookie } })).statusCode, 409);

  const l1 = await chamar(logs, { headers: { cookie } });
  assert.equal(l1.body.logs.length, 1);
  assert.equal(l1.body.logs[0].nome, '2026-11-10 p – teste');
  assert.equal(l1.body.logs[0].custo, 1.5);
  await chamar(logs, { method: 'PATCH', body: { id: cmd.id, nome: 'Novo nome' }, headers: { cookie } });
  assert.equal((await chamar(logs, { url: '/api/logs?q=novo', headers: { cookie } })).body.logs[0].nome, 'Novo nome');
  assert.equal((await chamar(logs, { url: '/api/logs?q=nada', headers: { cookie } })).body.logs.length, 0);
  assert.equal((await chamar(logs, { method: 'PATCH', body: { id: 'x', nome: 'a' }, headers: { cookie } })).statusCode, 404);
});

test('pedido de encerrar expira em 2 min e não chega mais ao coletor', async () => {
  const cookie = await entrar();
  await chamar(ingest, { method: 'POST', body: { retrato: retrato() }, headers: coletor });
  await chamar(encerrar, { method: 'POST', body: { chave: 'principal:s1' }, headers: { cookie } });
  const real = Date.now;
  Date.now = () => real() + 121_000;
  try {
    const ing = await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
    assert.equal(ing.body.comandos.length, 0);
  } finally {
    Date.now = real;
  }
  const e = await chamar(estado, { headers: { cookie } });
  assert.equal(e.body.comandos[0].estado, 'expirado');
});
