// QA, rodada 2 (verificação final): o estado dos comandos no servidor só avança (R9, S20). Complementa
// test/corr2c-estado-so-avanca.test.js com o que a mutação mostrou sem prova: o primeiro `recebido` e o
// primeiro resultado valem mesmo quando o escritor atrasado grava por último, o expirado nunca esconde um
// comando que já foi confirmado (também muito depois) e a junção das três fontes em api/_lib.js.
// Redis em memória; as corridas seguram a gravação de uma chamada até a outra terminar.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gerarHashSenha, juntarComando } from '../api/_lib.js';
import login from '../api/login.js';
import estado from '../api/estado.js';
import comando from '../api/comando.js';
import ingest from '../api/ingest.js';
import { instalarRedisFalso } from '../scripts/redis-memoria.js';

const redisFalso = instalarRedisFalso();
const SENHA = 'abcd-efgh-jkmn-pqrs';
process.env.PANEL_PASSWORD_HASH = gerarHashSenha(SENHA);
process.env.SESSION_SECRET = 'q'.repeat(48);
process.env.MOISES_TOKEN = 'k'.repeat(43);

const MIN = 60_000;
const SEM_RESULTADO_MS = 10 * MIN; // o tempo limite do recebido sem resultado em api/ingest.js

// ---------------------------------------------------------------- porta que segura a gravação de uma chamada
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
// Falha em vez de travar se a chamada segurada não chegar a gravar.
function chegada(p) {
  let relogio;
  const limite = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new Error('a chamada segurada não chegou a gravar')), 5_000);
  });
  return Promise.race([p.chegou, limite]).finally(() => clearTimeout(relogio));
}
// `antiga` lê o Redis e fica presa na gravação; `nova` roda inteira; depois a antiga grava por último.
async function intercalar(antiga, nova) {
  const p = segurar();
  const primeira = antiga();
  await chegada(p);
  const r = await nova();
  p.abrir();
  return [await primeira, r];
}

beforeEach(() => {
  porta = null;
  redisFalso.limpar();
  redisFalso.db.set('moises:retrato', JSON.stringify({ sessoes: [], orquestracao: { aparelhos: [{ kid: 'ab2cd3', rotulo: 'x' }] } }));
});

async function chamar(handler, { method = 'GET', url = '/', body, headers = {} } = {}) {
  const txt = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(txt ? [Buffer.from(txt)] : []);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.8.7.6', ...headers }, socket: {} });
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
// Roda `fn` com o relógio do servidor adiantado.
function comRelogio(deslocamentoMs, fn) {
  const real = Date.now;
  Date.now = () => real() + deslocamentoMs;
  return Promise.resolve().then(fn).finally(() => {
    Date.now = real;
  });
}

const coletor = { authorization: `Bearer ${'k'.repeat(43)}` };
const CHAVE = 'principal:4e00abb1-1234-4abc-8def-0123456789ab';
const ASSINATURA = 'QaQa_-0123456789abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, 85) + 'Q';
let seq = 0;
const cmdValido = (extra = {}) => ({
  v: 1, kid: 'ab2cd3', id: `c_${(++seq).toString(16).padStart(16, 'c')}`, tipo: 'mensagem', chave: CHAVE, criadoEm: Date.now(),
  dados: JSON.stringify({ texto: 'TEXTO-SIGILOSO-QA3', visto: { projeto: 'p', nome: null } }), assinatura: ASSINATURA, ...extra,
});
const enviar = async (cookie, c) => (await chamar(comando, { method: 'POST', body: c, headers: { cookie } })).statusCode;
const ingerir = (corpo = {}) => chamar(ingest, { method: 'POST', body: { protocolo: 2, ...corpo }, headers: coletor });
const porId = async (cookie) => Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((c) => [c.id, c]));
const hash = (k) => redisFalso.db.get(k) ?? new Map();

// ---------------------------------------------------------------- o primeiro recebido vale

test('R9: dois ingests que confirmam o recebimento ao mesmo tempo: vale a hora do primeiro a gravar, e o tempo limite conta dela', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  assert.equal(await enviar(cookie, c), 200);
  const T0 = Date.now();
  // A antiga leu primeiro (relógio real) e grava por último; a nova gravou antes, 1 min adiante no relógio.
  await intercalar(
    () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }] }),
    () => comRelogio(MIN, () => ingerir({ acks: [{ id: c.id, estado: 'recebido' }] })),
  );
  const rec = Number(hash('moises:cmds-rec').get(c.id));
  assert.ok(rec - T0 >= MIN - 2_000, `a hora do primeiro a gravar (T0 + 1 min) ficou; veio T0 + ${rec - T0} ms`);
  // 10 min menos 5 s depois da hora do primeiro: ainda recebido. Com a hora do atrasado (1 min antes) já seria falhou.
  const quase = await comRelogio(MIN + SEM_RESULTADO_MS - 5_000, async () => {
    await ingerir();
    return (await porId(cookie))[c.id].estado;
  });
  assert.equal(quase, 'recebido');
});

// ---------------------------------------------------------------- o primeiro resultado vale, também o do tempo limite

test('R9: o ingest que declara falhou por tempo limite e grava por último não apaga o feito que chegou no meio', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await ingerir({ acks: [{ id: c.id, estado: 'recebido' }] });
  // 11 min depois: um ingest lê o comando já vencido e vai declarar falhou; antes de gravar, chega o feito.
  await comRelogio(11 * MIN, () =>
    intercalar(
      () => ingerir(),
      () => ingerir({ acks: [{ id: c.id, estado: 'feito' }] }),
    ),
  );
  const v = (await porId(cookie))[c.id];
  assert.deepEqual([v.estado, v.erro], ['feito', null]);
  const fim = JSON.parse(hash('moises:cmds-fim').get(c.id));
  assert.deepEqual([fim.estado, fim.erro], ['feito', null]);
});

test('R9: o inverso também: o falhou por tempo limite gravado primeiro vale, e o feito atrasado não o desfaz', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await ingerir({ acks: [{ id: c.id, estado: 'recebido' }] });
  await comRelogio(11 * MIN, () => ingerir());
  assert.deepEqual([(await porId(cookie))[c.id].estado, (await porId(cookie))[c.id].erro], ['falhou', 'O coletor não confirmou o resultado.']);
  // O coletor reenvia o resultado tarde: o estado não volta para feito (o estado só avança uma vez por etapa).
  await ingerir({ acks: [{ id: c.id, estado: 'feito' }] });
  assert.equal((await porId(cookie))[c.id].estado, 'falhou');
});

test('R9: dois feitos de abrir com chaves novas diferentes: vale a do primeiro a gravar', async () => {
  const cookie = await entrar();
  const c = cmdValido({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: 'oi' }) });
  await enviar(cookie, c);
  const primeira = 'principal:00000000-0000-4000-8000-000000000001';
  const segunda = 'principal:00000000-0000-4000-8000-000000000002';
  await intercalar(
    () => ingerir({ acks: [{ id: c.id, estado: 'feito', chaveNova: segunda }] }),
    () => ingerir({ acks: [{ id: c.id, estado: 'feito', chaveNova: primeira }] }),
  );
  const v = (await porId(cookie))[c.id];
  assert.deepEqual([v.estado, v.chave], ['feito', primeira]);
});

// ---------------------------------------------------------------- S20: o expirado nunca esconde o que o coletor confirmou

for (const [descricao, acks, esperado] of [
  ['recebido', [{ estado: 'recebido' }], 'recebido'],
  ['feito', [{ estado: 'recebido' }, { estado: 'feito' }], 'feito'],
  ['falhou', [{ estado: 'falhou', erro: 'x' }], 'falhou'],
  ['recusado', [{ estado: 'recusado', erro: 'não', motivo: 'repetido' }], 'recusado'],
]) {
  test(`S20: comando confirmado como ${descricao} continua ${esperado} no painel e no ingest muito depois dos 2 min de validade`, async () => {
    const cookie = await entrar();
    const c = cmdValido();
    await enviar(cookie, c);
    await ingerir();
    await ingerir({ acks: acks.map((a) => ({ id: c.id, ...a })) });
    // O objeto guardado continua "pendente" (só o resultado vai para cmds-rec e cmds-fim): 5 min depois,
    // nenhuma leitura pode trocar o estado por "expirado".
    const depois = await comRelogio(5 * MIN, async () => {
      const painel = (await porId(cookie))[c.id].estado;
      await ingerir();
      return [painel, (await porId(cookie))[c.id].estado];
    });
    assert.deepEqual(depois, [esperado, esperado]);
    // E um POST /api/comando novo, que também expira o que venceu, não mexe no comando confirmado.
    await comRelogio(5 * MIN, () => enviar(cookie, cmdValido({ criadoEm: Date.now() })));
    assert.equal((await porId(cookie))[c.id].estado, esperado);
  });
}

test('S20: o comando que ninguém buscou continua expirando depois dos 2 min, e expirado perde o conteúdo', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  const v = await comRelogio(3 * MIN, async () => (await porId(cookie))[c.id]);
  assert.equal(v.estado, 'expirado');
  const bruto = hash('moises:cmds').get(c.id);
  assert.ok(!bruto.includes('TEXTO-SIGILOSO-QA3') && !bruto.includes(ASSINATURA));
});

// ---------------------------------------------------------------- idempotência

test('R9: o mesmo feito entregue duas vezes em sequência não muda a hora nem o resultado gravados', async () => {
  const cookie = await entrar();
  const c = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ nome: 'x', visto: { projeto: 'p', nome: null } }) });
  await enviar(cookie, c);
  await ingerir({ acks: [{ id: c.id, estado: 'feito', log: { nome: 'log', projeto: 'p' } }] });
  const fim = hash('moises:cmds-fim').get(c.id);
  await comRelogio(30_000, () => ingerir({ acks: [{ id: c.id, estado: 'feito', log: { nome: 'outro', projeto: 'p' } }] }));
  assert.equal(hash('moises:cmds-fim').get(c.id), fim);
  assert.equal([...hash('moises:logs').values()].length, 1);
  assert.equal(JSON.parse([...hash('moises:logs').values()][0]).nome, 'log');
});

// ---------------------------------------------------------------- junção das três fontes (api/_lib.js)

test('juntarComando: o resultado final vale sobre o recebido; recebido sobre o expirado do objeto; ilegível não vale', () => {
  const base = { id: 'c_0000000000000001', tipo: 'mensagem', chave: CHAVE, criadoEm: 1 };
  const fim = JSON.stringify({ estado: 'falhou', erro: 'ruim', motivo: 'ritmo', feitoEm: 9 });
  const v = juntarComando({ ...base, estado: 'expirado' }, '1234', fim);
  assert.deepEqual([v.estado, v.erro, v.motivo, v.feitoEm], ['falhou', 'ruim', 'ritmo', 9]);
  const r = juntarComando({ ...base, estado: 'expirado' }, '1234', null);
  assert.deepEqual([r.estado, r.recebidoPeloColetorEm, r.erro], ['recebido', 1234, null]);
  // Resultado ilegível ou com estado que não é final: como se não existisse.
  for (const ruim of ['{quebrado', JSON.stringify({ estado: 'pendente' }), JSON.stringify({ estado: 'recebido' }), 'null', '42', JSON.stringify([])]) {
    assert.equal(juntarComando({ ...base, estado: 'pendente' }, null, ruim).estado, 'pendente', ruim);
    assert.equal(juntarComando({ ...base, estado: 'pendente' }, '55', ruim).estado, 'recebido', ruim);
  }
  // Hora de recebido ilegível conta como antiga (zero): o comando vira falhou pelo tempo limite em vez de ficar parado.
  assert.equal(juntarComando({ ...base, estado: 'pendente' }, 'lixo', null).recebidoPeloColetorEm, 0);
  // Um objeto já final (formato antigo) não volta a recebido por causa de um cmds-rec.
  assert.equal(juntarComando({ ...base, estado: 'feito', feitoEm: 3 }, '77', null).estado, 'feito');
  // Sem nenhuma das duas fontes, vale o do objeto, e o objeto original não é alterado.
  const guardado = { ...base, estado: 'pendente' };
  assert.equal(juntarComando(guardado, null, null).estado, 'pendente');
  juntarComando(guardado, '1', fim);
  assert.equal(guardado.estado, 'pendente');
});

test('juntarComando: chaveNova só vale em abrir e só no formato de chave', () => {
  const fim = (chaveNova) => JSON.stringify({ estado: 'feito', erro: null, motivo: null, feitoEm: 1, chaveNova });
  const boa = 'principal:00000000-0000-4000-8000-000000000009';
  assert.equal(juntarComando({ id: 'c_1', tipo: 'abrir', chave: null, estado: 'pendente' }, null, fim(boa)).chave, boa);
  assert.equal(juntarComando({ id: 'c_1', tipo: 'abrir', chave: null, estado: 'pendente' }, null, fim('../../etc/passwd')).chave, null);
  assert.equal(juntarComando({ id: 'c_1', tipo: 'mensagem', chave: CHAVE, estado: 'pendente' }, null, fim(boa)).chave, CHAVE);
});
