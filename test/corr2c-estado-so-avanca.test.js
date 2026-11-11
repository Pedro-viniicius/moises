// Rodada de correção 2 (R9 e S20): o estado de um comando no Redis só anda para a frente, mesmo com
// duas chamadas concorrentes (ingest reenviado pelo coletor depois do tempo limite, ou o painel expirando
// o comando enquanto o coletor confirma). Redis em memória; as corridas são intercaladas segurando a
// gravação de uma das chamadas até a outra terminar.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gerarHashSenha } from '../api/_lib.js';
import login from '../api/login.js';
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

// ---------------------------------------------------------------- porta: segura um pipeline de gravação
// A primeira chamada ao /pipeline depois de `segurar()` que não é uma leitura fica parada até `abrir()`.
// Leituras: o pipeline que começa por HGETALL/GET ou pelo SET de moises:recebidoEm (a leitura do ingest).
const fetchRedis = globalThis.fetch;
let porta = null;
const ehLeitura = (cmds) => ['GET', 'HGETALL'].includes(cmds[0]?.[0]) || (cmds[0]?.[0] === 'SET' && cmds[0][1] === 'moises:recebidoEm');
globalThis.fetch = async (url, opts) => {
  if (porta && String(url).endsWith('/pipeline') && !ehLeitura(JSON.parse(opts.body))) {
    const p = porta;
    porta = null;
    p.chegou();
    await p.aberta;
  }
  return fetchRedis(url, opts);
};
function segurar() {
  let chegou;
  let abrir;
  const p = { chegouP: new Promise((r) => (chegou = r)), aberta: new Promise((r) => (abrir = r)) };
  p.chegou = chegou;
  porta = p;
  return { chegou: p.chegouP, abrir };
}
// Espera a chamada segurada chegar à gravação; se ela não gravar nada, falha em vez de travar o teste.
function chegada(p) {
  let relogio;
  const limite = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new Error('a chamada segurada não chegou a gravar')), 5_000);
  });
  return Promise.race([p.chegou, limite]).finally(() => clearTimeout(relogio));
}

beforeEach(() => {
  porta = null;
  redisFalso.limpar();
  redisFalso.db.set('moises:retrato', JSON.stringify({ sessoes: [], orquestracao: { aparelhos: [{ kid: 'ab2cd3', rotulo: 'x' }] } }));
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
  return r.h['set-cookie'].split(';')[0];
}
function comRelogio(deslocamentoMs, fn) {
  const real = Date.now;
  Date.now = () => real() + deslocamentoMs;
  return Promise.resolve().then(fn).finally(() => {
    Date.now = real;
  });
}

const coletor = { authorization: `Bearer ${'y'.repeat(43)}` };
const CHAVE = 'principal:4e00abb1-1234-4abc-8def-0123456789ab';
const ASSINATURA = 'QaQa_-0123456789abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, 85) + 'Q';
const MARCA = 'TEXTO-SIGILOSO-CORR2C';
let seq = 0;
const cmdValido = (extra = {}) => ({
  v: 1, kid: 'ab2cd3', id: `c_${(++seq).toString(16).padStart(16, 'b')}`, tipo: 'mensagem', chave: CHAVE, criadoEm: Date.now(),
  dados: JSON.stringify({ texto: MARCA, visto: { projeto: 'p', nome: null } }), assinatura: ASSINATURA, ...extra,
});
const encerrar = () => cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ nome: MARCA, visto: { projeto: 'p', nome: null } }) });
const enviar = async (cookie, c) => (await chamar(comando, { method: 'POST', body: c, headers: { cookie } })).statusCode;
const ingerir = (corpo = {}) => chamar(ingest, { method: 'POST', body: { protocolo: 2, ...corpo }, headers: coletor });
const porId = async (cookie) => Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((c) => [c.id, c]));

// Roda `antiga` até ela ler o Redis e tentar gravar; segura a gravação, roda `nova` inteira e só então
// solta a antiga. É a ordem do defeito: a mais antiga lê antes e grava por último.
async function intercalar(antiga, nova) {
  const p = segurar();
  const primeira = antiga();
  await chegada(p);
  const r = await nova();
  p.abrir();
  return [await primeira, r];
}

// ---------------------------------------------------------------- CA1: R9, dois ingests concorrentes

test('R9: o ingest antigo (só recebido) que grava por último não apaga o feito do ingest novo', async () => {
  const cookie = await entrar();
  const c = encerrar();
  assert.equal(await enviar(cookie, c), 200);
  assert.equal((await ingerir()).body.comandos.length, 1);
  const log = { nome: 'encerrada pelo painel', projeto: 'p', custo: 1 };
  const [ra, rb] = await intercalar(
    () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }] }),
    () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }, { id: c.id, estado: 'feito', log }] }),
  );
  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 200);
  assert.equal((await porId(cookie))[c.id].estado, 'feito');
  // Ninguém manda feito de novo: o comando não pode virar falhou pelo tempo limite de 10 min.
  await comRelogio(11 * 60_000, () => ingerir());
  const depois = (await porId(cookie))[c.id];
  assert.deepEqual([depois.estado, depois.erro], ['feito', null]);
  assert.equal((await ingerir()).body.comandos.length, 0, 'não é entregue de novo');
  assert.deepEqual((await chamar(logs, { headers: { cookie } })).body.logs.map((l) => l.nome), ['encerrada pelo painel']);
});

test('R9: o mesmo vale quando o ingest antigo grava falhou depois de um feito (o primeiro resultado vale)', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await ingerir();
  await intercalar(
    () => ingerir({ acks: [{ id: c.id, estado: 'falhou', erro: 'tarde' }] }),
    () => ingerir({ acks: [{ id: c.id, estado: 'feito' }] }),
  );
  const v = (await porId(cookie))[c.id];
  assert.deepEqual([v.estado, v.erro], ['feito', null]);
});

test('R9: o ingest atrasado não devolve dados nem assinatura ao Redis', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await ingerir();
  // A antiga leu o comando ainda com o conteúdo e só grava depois que a nova já o esqueceu.
  await intercalar(
    () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }] }),
    () => ingerir({ acks: [{ id: c.id, estado: 'feito' }] }),
  );
  const bruto = redisFalso.db.get('moises:cmds').get(c.id);
  assert.ok(!bruto.includes(MARCA) && !bruto.includes(ASSINATURA), 'conteúdo esquecido continua esquecido');
  assert.equal((await porId(cookie))[c.id].estado, 'feito');
});

test('R9: o feito reenviado que grava por último não volta o nome editado do log', async () => {
  const cookie = await entrar();
  const c = encerrar();
  await enviar(cookie, c);
  await ingerir();
  await ingerir({ acks: [{ id: c.id, estado: 'recebido' }] });
  // O feito chega primeiro; um segundo feito igual (reenvio) lê antes e grava depois que o dono renomeou o log.
  const log = { nome: 'nome do coletor', projeto: 'p' };
  const p = segurar();
  const reenvio = ingerir({ acks: [{ id: c.id, estado: 'feito', log }] });
  await chegada(p);
  await ingerir({ acks: [{ id: c.id, estado: 'feito', log }] });
  assert.equal((await chamar(logs, { method: 'PATCH', body: { id: c.id, nome: 'nome do dono' }, headers: { cookie } })).statusCode, 200);
  p.abrir();
  await reenvio;
  const lista = (await chamar(logs, { headers: { cookie } })).body.logs;
  assert.deepEqual(lista.map((l) => l.nome), ['nome do dono']);
  // Mais tarde o ingest com o relógio 11 min adiante não troca o feito por falhou.
  await comRelogio(11 * 60_000, () => ingerir());
  assert.equal((await porId(cookie))[c.id].estado, 'feito');
});

// ---------------------------------------------------------------- CA1: S20, expiração versus ack

for (const [ack, esperado] of [
  [{ estado: 'recebido' }, 'recebido'],
  [{ estado: 'feito' }, 'feito'],
  [{ estado: 'falhou', erro: 'x' }, 'falhou'],
  [{ estado: 'recusado', erro: 'não', motivo: 'repetido' }, 'recusado'],
]) {
  test(`S20: o painel que expira o comando e grava por último não esconde o ack ${esperado}`, async () => {
    const cookie = await entrar();
    const c = cmdValido();
    await enviar(cookie, c);
    // O coletor buscou pouco antes de vencer; o ack chega depois dos 2 min.
    await comRelogio(119_000, () => ingerir());
    await comRelogio(121_000, () =>
      intercalar(
        () => chamar(estado, { headers: { cookie } }),
        () => ingerir({ acks: [{ id: c.id, ...ack }] }),
      ),
    );
    const v = (await porId(cookie))[c.id];
    assert.equal(v.estado, esperado);
    assert.ok(!redisFalso.db.get('moises:cmds').get(c.id).includes(MARCA));
  });
}

test('S20: o POST /api/comando que expira o comando também não esconde o ack', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await comRelogio(119_000, () => ingerir());
  await comRelogio(121_000, () =>
    intercalar(
      () => chamar(comando, { method: 'POST', body: cmdValido(), headers: { cookie } }),
      () => ingerir({ acks: [{ id: c.id, estado: 'feito' }] }),
    ),
  );
  assert.equal((await porId(cookie))[c.id].estado, 'feito');
});

test('S20: o ingest que expira o comando também não esconde o ack de outro ingest', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await comRelogio(119_000, () => ingerir());
  await comRelogio(121_000, () =>
    intercalar(
      () => ingerir(),
      () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }] }),
    ),
  );
  assert.equal((await porId(cookie))[c.id].estado, 'recebido');
});

// ---------------------------------------------------------------- CA2: chaves novas e compatibilidade

const hashDe = (k) => (redisFalso.db.has(k) ? redisFalso.db.get(k) : redisFalso.db.set(k, new Map()).get(k));
function esquecer(c) {
  delete c.dados;
  delete c.assinatura;
  return c;
}

test('CA2: recebido vai para moises:cmds-rec e o resultado para moises:cmds-fim, uma vez só', async () => {
  const cookie = await entrar();
  const novaChave = 'conta2:0f0e0d0c-0b0a-4908-8706-050403020100';
  const abrir = cmdValido({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: 'oi' }) });
  await enviar(cookie, abrir);
  await ingerir();
  await ingerir({ acks: [{ id: abrir.id, estado: 'recebido' }] });
  const rec = hashDe('moises:cmds-rec').get(abrir.id);
  assert.ok(Number(rec) > 0, 'hora do recebido');
  // Recebido repetido não regrava a hora.
  await comRelogio(5_000, () => ingerir({ acks: [{ id: abrir.id, estado: 'recebido' }] }));
  assert.equal(hashDe('moises:cmds-rec').get(abrir.id), rec);
  await ingerir({ acks: [{ id: abrir.id, estado: 'feito', chaveNova: novaChave, motivo: 'ignorado', erro: 'ignorado' }] });
  const fim = JSON.parse(hashDe('moises:cmds-fim').get(abrir.id));
  assert.deepEqual(Object.keys(fim).sort(), ['chaveNova', 'erro', 'estado', 'feitoEm', 'motivo']);
  assert.deepEqual([fim.estado, fim.erro, fim.chaveNova], ['feito', null, novaChave]);
  assert.ok(fim.feitoEm > 0);
  const v = (await porId(cookie))[abrir.id];
  assert.deepEqual([v.estado, v.chave], ['feito', novaChave]);
  // Um segundo resultado não regrava o primeiro.
  await ingerir({ acks: [{ id: abrir.id, estado: 'falhou', erro: 'outro' }] });
  assert.deepEqual(JSON.parse(hashDe('moises:cmds-fim').get(abrir.id)), fim);
  // O objeto guarda só o comando, sem conteúdo, e não é tocado pelo resultado.
  const obj = JSON.parse(hashDe('moises:cmds').get(abrir.id));
  assert.deepEqual([obj.estado, obj.chave, 'dados' in obj, 'assinatura' in obj], ['pendente', null, false, false]);
});

test('CA2: comando gravado antes das chaves novas aparece e anda com o estado do objeto', async () => {
  const cookie = await entrar();
  const agora = Date.now();
  const antigo = (estado, extra = {}) => esquecer({ ...cmdValido(), estado, erro: null, recebidoNoServidorEm: agora, ...extra });
  const rec = antigo('recebido', { recebidoPeloColetorEm: agora });
  const feito = antigo('feito', { feitoEm: agora });
  const falhou = antigo('falhou', { erro: 'deu ruim', feitoEm: agora });
  const expirado = antigo('expirado');
  const velhoRec = antigo('recebido', { recebidoPeloColetorEm: agora - 11 * 60_000 });
  for (const c of [rec, feito, falhou, expirado, velhoRec]) hashDe('moises:cmds').set(c.id, JSON.stringify(c));
  const vista = await porId(cookie);
  assert.deepEqual([rec, feito, falhou, expirado].map((c) => vista[c.id].estado), ['recebido', 'feito', 'falhou', 'expirado']);
  assert.equal(vista[falhou.id].erro, 'deu ruim');
  // Nenhum deles é entregue; o recebido antigo há mais de 10 min vira falhou pelo tempo limite.
  assert.equal((await ingerir()).body.comandos.length, 0);
  const vr = (await porId(cookie))[velhoRec.id];
  assert.deepEqual([vr.estado, vr.erro], ['falhou', 'O coletor não confirmou o resultado.']);
  // Ack atrasado não desfaz o resultado antigo; o recebido antigo ainda aceita o resultado.
  await ingerir({ acks: [{ id: feito.id, estado: 'recebido' }, { id: falhou.id, estado: 'feito' }, { id: rec.id, estado: 'feito' }] });
  const depois = await porId(cookie);
  assert.deepEqual([feito, falhou, rec].map((c) => depois[c.id].estado), ['feito', 'falhou', 'feito']);
  assert.equal(depois[falhou.id].erro, 'deu ruim');
});

test('CA2: o ingest só entrega o pendente que não tem recebido nem resultado', async () => {
  const cookie = await entrar();
  const [a, b, c] = [cmdValido(), cmdValido(), cmdValido()];
  for (const x of [a, b, c]) await enviar(cookie, x);
  // Resultados gravados por outra chamada cuja regravação do objeto ainda não chegou.
  hashDe('moises:cmds-rec').set(a.id, String(Date.now()));
  hashDe('moises:cmds-fim').set(b.id, JSON.stringify({ estado: 'recusado', erro: 'não', motivo: 'repetido', feitoEm: Date.now() }));
  assert.deepEqual((await ingerir()).body.comandos.map((x) => x.id), [c.id]);
  const v = await porId(cookie);
  assert.deepEqual([v[a.id].estado, v[b.id].estado, v[b.id].motivo, v[c.id].estado], ['recebido', 'recusado', 'repetido', 'pendente']);
});

test('CA2: o POST /api/comando conta como pendente só o que não tem recebido nem resultado, e recusa id que já tem resultado', async () => {
  const cookie = await entrar();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const c = cmdValido();
    ids.push(c.id);
    assert.equal(await enviar(cookie, c), 200);
  }
  assert.equal(await enviar(cookie, cmdValido()), 429);
  // O coletor confirmou um em outra chamada (só cmds-rec gravado): abre vaga.
  hashDe('moises:cmds-rec').set(ids[0], String(Date.now()));
  assert.equal(await enviar(cookie, cmdValido()), 200);
  // Resultado que sobrou de um comando já apagado: o mesmo id é repetido.
  const sobra = cmdValido();
  hashDe('moises:cmds-fim').set(sobra.id, JSON.stringify({ estado: 'feito', erro: null, motivo: null, feitoEm: Date.now() }));
  assert.equal(await enviar(cookie, sobra), 409);
  assert.equal(hashDe('moises:cmds').has(sobra.id), false);
});

test('CA2: a limpeza de 24 h apaga o comando, o recebido e o resultado, e o que sobrou sem comando', async () => {
  const cookie = await entrar();
  const c = encerrar();
  await enviar(cookie, c);
  await ingerir();
  await ingerir({ acks: [{ id: c.id, estado: 'recebido' }, { id: c.id, estado: 'feito', log: { nome: 'x' } }] });
  // Sobras sem comando: as velhas (e a ilegível) saem; a nova fica (pode ser de uma chamada em andamento).
  const velha = Date.now() - 25 * 3600_000;
  hashDe('moises:cmds-rec').set('c_00000000000000aa', String(velha));
  hashDe('moises:cmds-fim').set('c_00000000000000aa', JSON.stringify({ estado: 'feito', erro: null, motivo: null, feitoEm: velha }));
  hashDe('moises:cmds-rec').set('c_00000000000000bb', String(Date.now() + 24 * 3600_000)); // nova no relógio adiantado abaixo
  hashDe('moises:cmds-fim').set('c_00000000000000cc', '{ilegível');
  await comRelogio(23 * 3600_000, () => ingerir());
  assert.ok(hashDe('moises:cmds').has(c.id), 'antes de 24 h fica');
  assert.ok(hashDe('moises:cmds-fim').has(c.id));
  await comRelogio(24 * 3600_000 + 1_000, () => ingerir());
  assert.equal(hashDe('moises:cmds').has(c.id), false);
  assert.equal(hashDe('moises:cmds-rec').has(c.id), false);
  assert.equal(hashDe('moises:cmds-fim').has(c.id), false);
  assert.deepEqual([...hashDe('moises:cmds-rec').keys()], ['c_00000000000000bb']);
  assert.deepEqual([...hashDe('moises:cmds-fim').keys()], []);
  // O log do Histórico não é apagado com o comando.
  assert.equal((await chamar(logs, { headers: { cookie } })).body.logs.length, 1);
});

// ---------------------------------------------------------------- CA3: Redis em memória como o Upstash

test('CA3: o Redis em memória aceita HDEL com vários campos e devolve o erro na posição do comando, sem parar o pipeline', async () => {
  const { pipeline, redis } = await import('../api/_lib.js');
  const r = await fetch(`${process.env.KV_REST_API_URL}/pipeline`, {
    method: 'POST',
    body: JSON.stringify([['HSET', 'h', 'a', '1'], ['HSET', 'h', 'b', '2'], ['HSET', 'h', 'c', '3'], ['APAGAR_TUDO'], ['HDEL', 'h', 'a', 'b', 'z'], ['HGETALL', 'h']]),
  });
  const corpo = await r.json();
  assert.deepEqual(corpo.slice(0, 3), [{ result: 1 }, { result: 1 }, { result: 1 }]);
  assert.match(corpo[3].error, /APAGAR_TUDO/);
  assert.deepEqual(corpo.slice(4), [{ result: 2 }, { result: ['c', '3'] }]);
  // O cliente do servidor transforma o erro em exceção (a rota responde 500 genérico).
  await assert.rejects(pipeline([['GET', 'x'], ['APAGAR_TUDO']]), /Redis: /);
  await assert.rejects(redis('APAGAR_TUDO'), /Redis: /);
  assert.equal(await redis('HSETNX', 'h', 'c', 'outro'), 0);
  assert.equal(await redis('HGET', 'h', 'c'), '3');
});
