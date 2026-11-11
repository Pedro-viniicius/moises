import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { gerarHashSenha } from '../api/_lib.js';
import login from '../api/login.js';
import logout from '../api/logout.js';
import estado from '../api/estado.js';
import comando from '../api/comando.js';
import logs from '../api/logs.js';
import ingest from '../api/ingest.js';

import { instalarRedisFalso } from '../scripts/redis-memoria.js';

const redisFalso = instalarRedisFalso();

const SENHA = 'abcd-efgh-jkmn-pqrs';
process.env.PANEL_PASSWORD_HASH = gerarHashSenha(SENHA);
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.MOISES_TOKEN = 'y'.repeat(43);

beforeEach(() => redisFalso.limpar());

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
const CHAVE = 'principal:4e00abb1-1234-4abc-8def-0123456789ab';
const retrato = (status = 'ativa') => ({ dia: '2026-11-10', totalDia: 1, sessoes: [{ chave: CHAVE, projeto: 'p', status, custo: 1 }] });

// O servidor não tem a chave do aparelho: confere só o formato. Qualquer string base64url de 43 caracteres serve.
const ASSINATURA = 'AbCd_-0123456789abcdefghijklmnopqrstuvwxyzA';
const MARCA = 'TEXTO-SIGILOSO-DA-MENSAGEM';
let seq = 0;
const novoId = () => `c_${(++seq).toString(16).padStart(16, '0')}`;
function cmdValido(extra = {}) {
  return {
    v: 1,
    kid: 'ab2cd3',
    id: novoId(),
    tipo: 'mensagem',
    chave: CHAVE,
    criadoEm: Date.now(),
    dados: JSON.stringify({ texto: MARCA, visto: { projeto: 'p', nome: null } }),
    assinatura: ASSINATURA,
    ...extra,
  };
}
const guardado = (id) => JSON.parse(redisFalso.db.get('moises:cmds').get(id));
function comRelogio(deslocamentoMs, fn) {
  const real = Date.now;
  Date.now = () => real() + deslocamentoMs;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Date.now = real;
    });
}

test('login: cookie seguro, senha errada, bloqueio depois de 5 erros', async () => {
  const cookie = await entrar();
  assert.match(cookie, /^moises=\d+\./);
  const r = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(r.h['set-cookie'].includes(flag));
  for (let i = 0; i < 5; i++) assert.equal((await chamar(login, { method: 'POST', body: { senha: 'errada' } })).statusCode, 401);
  const bloqueado = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  assert.equal(bloqueado.statusCode, 429);
  // outro IP não fica trancado (sem trava global)
  assert.equal((await chamar(login, { method: 'POST', body: { senha: SENHA }, headers: { 'x-forwarded-for': '9.9.9.9' } })).statusCode, 200);
  assert.equal((await chamar(login, { method: 'POST', body: { senha: SENHA }, headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await chamar(login, { method: 'GET' })).statusCode, 405);
});

test('rotas do painel exigem cookie válido', async () => {
  assert.equal((await chamar(estado)).statusCode, 401);
  assert.equal((await chamar(estado, { headers: { cookie: 'moises=9999999999.forjado' } })).statusCode, 401);
  assert.equal((await chamar(logs)).statusCode, 401);
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido() })).statusCode, 401);
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

test('fluxo completo: retrato → comando encerrar → coletor confirma e executa → log no histórico, nome editável', async () => {
  const cookie = await entrar();
  await chamar(ingest, { method: 'POST', body: { retrato: retrato() }, headers: coletor });
  const e1 = await chamar(estado, { headers: { cookie } });
  assert.equal(e1.body.retrato.sessoes[0].chave, CHAVE);
  assert.ok(e1.body.recebidoEm > 0);

  const enviado = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ nome: '2026-11-10 p – teste', visto: { projeto: 'p', nome: null } }) });
  const pedido = await chamar(comando, { method: 'POST', body: enviado, headers: { cookie } });
  assert.equal(pedido.statusCode, 200);
  assert.deepEqual(pedido.body, { id: enviado.id });

  const ing = await chamar(ingest, { method: 'POST', body: { retrato: null }, headers: coletor });
  assert.equal(ing.body.comandos.length, 1);
  const cmd = ing.body.comandos[0];
  assert.equal(cmd.chave, CHAVE);
  assert.equal(cmd.tipo, 'encerrar');
  assert.equal(cmd.dados, enviado.dados);

  await chamar(ingest, { method: 'POST', body: { acks: [{ id: cmd.id, estado: 'recebido' }] }, headers: coletor });
  assert.equal((await chamar(estado, { headers: { cookie } })).body.comandos[0].estado, 'recebido');
  const log = { nome: '2026-11-10 p – teste', projeto: 'p', custo: 1.5, duracaoMs: 60000, intruso: 'x'.repeat(10) };
  await chamar(ingest, { method: 'POST', body: { retrato: retrato('encerrada'), acks: [{ id: cmd.id, estado: 'feito', erro: null, log }] }, headers: coletor });
  const e2 = await chamar(estado, { headers: { cookie } });
  assert.equal(e2.body.comandos[0].estado, 'feito');
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.comandos.length, 0);
  // um ack atrasado não faz o comando voltar de estado
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: cmd.id, estado: 'recebido' }] }, headers: coletor });
  assert.equal((await chamar(estado, { headers: { cookie } })).body.comandos[0].estado, 'feito');

  const l1 = await chamar(logs, { headers: { cookie } });
  assert.equal(l1.body.logs.length, 1);
  assert.equal(l1.body.logs[0].nome, '2026-11-10 p – teste');
  assert.equal(l1.body.logs[0].custo, 1.5);
  assert.equal(l1.body.logs[0].intruso, undefined); // só campos conhecidos são gravados
  await chamar(logs, { method: 'PATCH', body: { id: cmd.id, nome: 'Novo nome' }, headers: { cookie } });
  assert.equal((await chamar(logs, { url: '/api/logs?q=novo', headers: { cookie } })).body.logs[0].nome, 'Novo nome');
  assert.equal((await chamar(logs, { url: '/api/logs?q=nada', headers: { cookie } })).body.logs.length, 0);
  assert.equal((await chamar(logs, { method: 'PATCH', body: { id: 'x', nome: 'a' }, headers: { cookie } })).statusCode, 404);
});

test('ack no formato antigo {id, ok, erro, log} continua valendo', async () => {
  const cookie = await entrar();
  const a = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  const b = cmdValido();
  await chamar(comando, { method: 'POST', body: a, headers: { cookie } });
  await chamar(comando, { method: 'POST', body: b, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  const acks = [
    { id: a.id, ok: true, log: { nome: 'log antigo', projeto: 'p' } },
    { id: b.id, ok: false, erro: 'x'.repeat(300) },
  ];
  await chamar(ingest, { method: 'POST', body: { acks }, headers: coletor });
  const porId = Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((c) => [c.id, c]));
  assert.equal(porId[a.id].estado, 'feito');
  assert.equal(porId[b.id].estado, 'falhou');
  assert.equal(porId[b.id].erro.length, 200);
  for (const id of [a.id, b.id]) {
    assert.equal(guardado(id).dados, undefined);
    assert.equal(guardado(id).assinatura, undefined);
  }
  const l = await chamar(logs, { headers: { cookie } });
  assert.equal(l.body.logs.length, 1);
  assert.equal(l.body.logs[0].nome, 'log antigo');
});

test('comando exige cookie e JSON', async () => {
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido() })).statusCode, 401);
  const cookie = await entrar();
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie, 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await chamar(comando, { method: 'GET', headers: { cookie } })).statusCode, 405);
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } })).statusCode, 200);
});

test('comando recusa formato inválido', async () => {
  const cookie = await entrar();
  const dadosCom = (n) => JSON.stringify({ texto: 'a'.repeat(n - 12) }); // {"texto":"…"} tem 12 caracteres além do texto
  assert.equal(dadosCom(8000).length, 8000);
  const sem = (campo) => {
    const c = cmdValido();
    delete c[campo];
    return c;
  };
  const casos = {
    'v ausente': sem('v'),
    'v 2': cmdValido({ v: 2 }),
    'v texto': cmdValido({ v: '1' }),
    'kid maiúsculo': cmdValido({ kid: 'AB2CD3' }),
    'kid curto': cmdValido({ kid: 'ab2cd' }),
    'kid ausente': sem('kid'),
    'id sem prefixo': cmdValido({ id: 'x_0123456789abcdef' }),
    'id curto': cmdValido({ id: 'c_0123' }),
    'id maiúsculo': cmdValido({ id: 'c_0123456789ABCDEF' }),
    'tipo desconhecido': cmdValido({ tipo: 'apagar' }),
    'tipo ausente': sem('tipo'),
    'chave fora do formato': cmdValido({ chave: 'principal:s1' }),
    'chave com conta inválida': cmdValido({ chave: `Principal${CHAVE.slice(9)}` }),
    'chave ausente em mensagem': sem('chave'),
    'chave null em mensagem': cmdValido({ chave: null }),
    'chave presente em abrir': cmdValido({ tipo: 'abrir' }),
    'chave ausente em abrir': (() => { const c = sem('chave'); c.tipo = 'abrir'; return c; })(),
    'criadoEm fracionário': cmdValido({ criadoEm: 1.5 }),
    'criadoEm texto': cmdValido({ criadoEm: String(Date.now()) }),
    'criadoEm além do inteiro seguro': cmdValido({ criadoEm: 2 ** 53 }),
    'dados objeto': cmdValido({ dados: { texto: 'x' } }),
    'dados que não é JSON': cmdValido({ dados: `não é json ${MARCA}` }),
    'dados lista': cmdValido({ dados: '[]' }),
    'dados com 8.001 caracteres': cmdValido({ dados: dadosCom(8001) }),
    'assinatura ausente': sem('assinatura'),
    'assinatura com 42': cmdValido({ assinatura: ASSINATURA.slice(1) }),
    'assinatura com 44': cmdValido({ assinatura: `${ASSINATURA}A` }),
    'assinatura com =': cmdValido({ assinatura: `${ASSINATURA.slice(1)}=` }),
    'campo a mais': cmdValido({ estado: 'feito' }),
    'corpo lista': [cmdValido()],
    'corpo null': null,
  };
  for (const [nome, corpo] of Object.entries(casos)) {
    const r = await chamar(comando, { method: 'POST', body: corpo, headers: { cookie } });
    assert.equal(r.statusCode, 400, nome);
    assert.ok(!JSON.stringify(r.body).includes(MARCA), `${nome}: a resposta não repete os dados`);
  }
  assert.equal(redisFalso.db.get('moises:cmds'), undefined, 'nada foi gravado');
  // limites que valem
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido({ dados: dadosCom(8000) }), headers: { cookie } })).statusCode, 200);
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido({ tipo: 'abrir', chave: null }), headers: { cookie } })).statusCode, 200);
  // corpo acima de 40.000 bytes
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido({ dados: dadosCom(40_500) }), headers: { cookie } })).statusCode, 413);
});

test('comando com id repetido dá 409', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  assert.equal((await chamar(comando, { method: 'POST', body: c, headers: { cookie } })).statusCode, 200);
  const outro = { ...c, dados: JSON.stringify({ texto: 'outro', visto: { projeto: 'p', nome: null } }) };
  assert.equal((await chamar(comando, { method: 'POST', body: outro, headers: { cookie } })).statusCode, 409);
  assert.equal(guardado(c.id).dados, c.dados, 'o comando original não é sobrescrito');
  // dois envios simultâneos com o mesmo id: só um grava
  const d = cmdValido();
  const status = (await Promise.all([1, 2].map(() => chamar(comando, { method: 'POST', body: d, headers: { cookie } })))).map((r) => r.statusCode);
  assert.deepEqual(status.sort(), [200, 409]);
});

test('o 21º comando pendente dá 429', async () => {
  const cookie = await entrar();
  for (let i = 0; i < 20; i++) assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } })).statusCode, 200);
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } })).statusCode, 429);
  // o coletor confirma um: abre vaga
  const [primeiro] = (await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.comandos;
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: primeiro.id, estado: 'recebido' }] }, headers: coletor });
  assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } })).statusCode, 200);
});

test('ingest entrega o comando com dados e assinatura e o estado nunca os devolve', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  const gravado = guardado(c.id);
  assert.equal(gravado.estado, 'pendente');
  assert.equal(gravado.erro, null);
  assert.ok(gravado.recebidoNoServidorEm > 0);

  const e1 = await chamar(estado, { headers: { cookie } });
  assert.deepEqual(e1.body.comandos, [{ id: c.id, tipo: 'mensagem', chave: CHAVE, estado: 'pendente', erro: null, motivo: null, criadoEm: c.criadoEm }]);
  assert.ok(!JSON.stringify(e1.body).includes(MARCA));
  assert.ok(!JSON.stringify(e1.body).includes(ASSINATURA));

  const ing = await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  assert.equal(ing.body.comandos.length, 1);
  const { idadeMs, ...entregue } = ing.body.comandos[0];
  assert.deepEqual(entregue, c);
  assert.ok(idadeMs >= 0 && idadeMs < 5_000);

  const e2 = await chamar(estado, { headers: { cookie } });
  assert.ok(!JSON.stringify(e2.body).includes(MARCA));
  assert.ok(!JSON.stringify(e2.body).includes(ASSINATURA));
});

test('ingest entrega no máximo 20 comandos e conta a idade pela hora do servidor', async () => {
  const cookie = await entrar();
  // relógio do celular 1 h atrasado: a idade não depende dele
  await chamar(comando, { method: 'POST', body: cmdValido({ criadoEm: Date.now() - 3_600_000 }), headers: { cookie } });
  const ing = await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  assert.equal(ing.body.comandos.length, 1);
  assert.ok(ing.body.comandos[0].idadeMs < 5_000);

  // registros antigos sem recebidoNoServidorEm: idade conta de criadoEm; e o teto de 20 vale na entrega
  const agora = Date.now();
  for (let i = 0; i < 25; i++) {
    const c = { ...cmdValido(), estado: 'pendente', erro: null, criadoEm: agora - i };
    redisFalso.db.get('moises:cmds').set(c.id, JSON.stringify(c));
  }
  const ing2 = await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  assert.equal(ing2.body.comandos.length, 20);
});

test('ack recebido apaga dados e assinatura do Redis', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  assert.equal(guardado(c.id).dados, c.dados);
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: c.id, estado: 'recebido' }] }, headers: coletor });
  const g = guardado(c.id);
  assert.equal(g.estado, 'recebido');
  assert.equal('dados' in g, false);
  assert.equal('assinatura' in g, false);
  assert.ok(!redisFalso.db.get('moises:cmds').get(c.id).includes(MARCA));
  // recebido não é entregue de novo
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.comandos.length, 0);
  // ack de id desconhecido é ignorado
  const r = await chamar(ingest, { method: 'POST', body: { acks: [{ id: 'c_ffffffffffffffff', estado: 'feito' }, null, 'x'] }, headers: coletor });
  assert.equal(r.statusCode, 200);
});

test('comando expirado perde dados e assinatura', async () => {
  const cookie = await entrar();
  await chamar(ingest, { method: 'POST', body: { retrato: retrato() }, headers: coletor });
  const c = cmdValido({ tipo: 'encerrar' });
  await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  await comRelogio(121_000, async () => {
    const ing = await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
    assert.equal(ing.body.comandos.length, 0);
  });
  const g = guardado(c.id);
  assert.equal(g.estado, 'expirado');
  assert.equal('dados' in g, false);
  assert.equal('assinatura' in g, false);
  const e = await chamar(estado, { headers: { cookie } });
  assert.equal(e.body.comandos[0].estado, 'expirado');
  // se o coletor pegou o comando pouco antes de expirar, o resultado dele prevalece
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: c.id, estado: 'feito' }] }, headers: coletor });
  assert.equal(guardado(c.id).estado, 'feito');
});

test('com o coletor parado, o próximo comando expira os vencidos e eles não contam no limite', async () => {
  const cookie = await entrar();
  const vencidos = [];
  for (let i = 0; i < 20; i++) {
    const c = cmdValido();
    vencidos.push(c.id);
    await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  }
  await comRelogio(121_000, async () => {
    assert.equal((await chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } })).statusCode, 200);
  });
  for (const id of vencidos) {
    const g = guardado(id);
    assert.equal(g.estado, 'expirado');
    assert.equal('dados' in g, false);
    assert.equal('assinatura' in g, false);
  }
});

test('estado marca como expirado o pendente vencido mesmo com o coletor parado', async () => {
  const cookie = await entrar();
  const vencido = cmdValido();
  await chamar(comando, { method: 'POST', body: vencido, headers: { cookie } });
  const novo = await comRelogio(119_000, async () => {
    const c = cmdValido();
    await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
    return c;
  });
  // Nenhum ingest: o coletor está parado. Só o painel consulta o estado.
  await comRelogio(121_000, async () => {
    const e = await chamar(estado, { headers: { cookie } });
    assert.equal(e.statusCode, 200);
    const porId = Object.fromEntries(e.body.comandos.map((c) => [c.id, c]));
    assert.equal(porId[vencido.id].estado, 'expirado');
    assert.equal(porId[novo.id].estado, 'pendente');
  });
  const g = guardado(vencido.id);
  assert.equal(g.estado, 'expirado');
  assert.equal('dados' in g, false);
  assert.equal('assinatura' in g, false);
  assert.ok(!redisFalso.db.get('moises:cmds').get(vencido.id).includes(MARCA));
  // O que ainda está na validade continua inteiro para o coletor.
  assert.equal(guardado(novo.id).dados, novo.dados);
  // Se o coletor confirmar depois, o resultado dele prevalece, como no ingest.
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: vencido.id, estado: 'feito' }] }, headers: coletor });
  assert.equal(guardado(vencido.id).estado, 'feito');
});

test('ack feito de abrir grava a chave nova', async () => {
  const cookie = await entrar();
  const novaChave = 'conta2:0f0e0d0c-0b0a-4908-8706-050403020100';
  const abrir = cmdValido({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: 'oi' }) });
  const msg = cmdValido();
  const ruim = cmdValido({ tipo: 'abrir', chave: null });
  for (const c of [abrir, msg, ruim]) await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  const acks = [
    { id: abrir.id, estado: 'feito', chaveNova: novaChave },
    { id: msg.id, estado: 'feito', chaveNova: novaChave }, // só vale para abrir
    { id: ruim.id, estado: 'feito', chaveNova: '../../etc' }, // fora do formato
  ];
  await chamar(ingest, { method: 'POST', body: { acks }, headers: coletor });
  const porId = Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((c) => [c.id, c]));
  assert.equal(porId[abrir.id].chave, novaChave);
  assert.equal(porId[abrir.id].estado, 'feito');
  assert.equal(porId[msg.id].chave, CHAVE);
  assert.equal(porId[ruim.id].chave, null);
});

test('ack recusado guarda o erro e o motivo, e motivo fora do formato é descartado', async () => {
  const cookie = await entrar();
  const [a, b, c] = [cmdValido(), cmdValido(), cmdValido()];
  for (const x of [a, b, c]) await chamar(comando, { method: 'POST', body: x, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  const acks = [
    { id: a.id, estado: 'recusado', erro: 'Este aparelho não está autorizado neste computador.', motivo: 'aparelho' },
    { id: b.id, estado: 'recusado', erro: 'x'.repeat(250), motivo: 'Motivo<script>' },
    { id: c.id, estado: 'recusado', motivo: 'a'.repeat(21) },
  ];
  await chamar(ingest, { method: 'POST', body: { acks }, headers: coletor });
  const porId = Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((x) => [x.id, x]));
  assert.deepEqual(
    { estado: porId[a.id].estado, erro: porId[a.id].erro, motivo: porId[a.id].motivo },
    { estado: 'recusado', erro: 'Este aparelho não está autorizado neste computador.', motivo: 'aparelho' },
  );
  assert.equal(porId[b.id].estado, 'recusado');
  assert.equal(porId[b.id].erro.length, 200);
  assert.equal(porId[b.id].motivo, null);
  assert.equal(porId[c.id].motivo, null);
  assert.ok(porId[c.id].erro);
  for (const x of [a, b, c]) assert.equal('dados' in guardado(x.id), false);
  // estado desconhecido no ack não muda o comando
  const d = cmdValido();
  await chamar(comando, { method: 'POST', body: d, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: d.id, estado: 'apagado' }] }, headers: coletor });
  assert.equal(guardado(d.id).estado, 'pendente');
});

test('comando recebido há 10 min sem resultado vira falhou', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  await chamar(ingest, { method: 'POST', body: {}, headers: coletor });
  await chamar(ingest, { method: 'POST', body: { acks: [{ id: c.id, estado: 'recebido' }] }, headers: coletor });
  await comRelogio(590_000, () => chamar(ingest, { method: 'POST', body: {}, headers: coletor }));
  assert.equal(guardado(c.id).estado, 'recebido');
  await comRelogio(601_000, () => chamar(ingest, { method: 'POST', body: {}, headers: coletor }));
  const e = await chamar(estado, { headers: { cookie } });
  assert.equal(e.body.comandos[0].estado, 'falhou');
  assert.equal(e.body.comandos[0].erro, 'O coletor não confirmou o resultado.');
});

test('estado grava painelVistoEm e o ingest devolve', async () => {
  const cookie = await entrar();
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.painelVistoEm, null);
  const antes = Date.now();
  await chamar(estado, { headers: { cookie } });
  const visto = (await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.painelVistoEm;
  assert.equal(typeof visto, 'number');
  assert.ok(visto >= antes && visto <= Date.now());
  // sem login, o painel não conta como visto
  redisFalso.limpar();
  await chamar(estado);
  assert.equal((await chamar(ingest, { method: 'POST', body: {}, headers: coletor })).body.painelVistoEm, null);
});

test('cabeçalhos: CSP com trusted types e COOP', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const cab = Object.fromEntries(cfg.headers[0].headers.map(({ key, value }) => [key, value]));
  const csp = cab['Content-Security-Policy'].split(';').map((s) => s.trim());
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("require-trusted-types-for 'script'"));
  assert.equal(cab['Cross-Origin-Opener-Policy'], 'same-origin');
});
