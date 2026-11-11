// Correção final (CR1 a CR4): a abertura só vale com o `init` conferido, pedido pendente que sai da lista
// recebe a negativa, filho que nem o SIGKILL encerra não segura a vaga e a cota do dia volta quando o
// `spawn` falha. Tudo com o claude falso (test/fixtures/claude-falso.js) e pastas temporárias.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orquestrador } from '../collector/orquestrador.js';
import { Coletor } from '../collector/sessoes.js';
import { diaLocal } from '../collector/transcript.js';

const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
// Pasta só com dígitos no nome: o caminho do registro vai em argsExtra, que o construtor filtra por palavras.
const BASE = path.join(os.tmpdir(), `moises-corr3-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const ERRO_INIT = 'A sessão abriu com configuração diferente da esperada e foi encerrada.';
const ERRO_DEMOROU = 'A sessão não respondeu a tempo e foi encerrada.';
const ERRO_INICIAR = 'Não foi possível iniciar o Claude Code neste computador.';
const ERRO_NAO_ENCERROU = 'O processo da sessão não respondeu ao pedido de encerrar.';

let casos = 0;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, descricao, ms = 5000) {
  const limite = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`esperou demais: ${descricao}`);
    await espera(20);
  }
}
const cmd = (tipo, chave = null) => ({ v: 1, kid: 'ab2cd3', id: `c_${crypto.randomBytes(8).toString('hex')}`, tipo, chave, criadoEm: Date.now(), idadeMs: 0 });

function preparar(t, opcoes = {}) {
  const raiz = path.join(BASE, `caso-${++casos}`);
  const principal = path.join(raiz, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(principal, s), { recursive: true });
  const proj = path.join(raiz, 'projeto-a');
  fs.mkdirSync(proj);
  const registro = path.join(raiz, 'registro.json');
  const pastaEstado = path.join(raiz, 'estado');
  const coletor = new Coletor({ dirs: [principal] });
  const orq = new Orquestrador({
    coletor,
    projetos: () => ({ 'projeto-a': proj }),
    pastaEstado,
    claudeBin: FALSO,
    argsExtra: [`--system-prompt=registro:${registro}`],
    esperaAberturaMs: 5000,
    esperaRetomarMs: 200,
    ...opcoes,
  });
  t.after(() => orq.fechar());
  const entrada = () => {
    try {
      return fs.readFileSync(`${registro}.entrada`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const publicada = (chave) => orq.aplicar(coletor.retrato()).sessoes.find((s) => s.chave === chave);
  const arqContagem = path.join(pastaEstado, 'abrir.json');
  return { raiz, pastaEstado, arqContagem, coletor, orq, entrada, publicada };
}

const abrirCom = (ctx, pedido) => ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido });
async function abrir(ctx, pedido = 'Olá, comece') {
  const r = await abrirCom(ctx, pedido);
  assert.equal(r.ok, true, r.erro);
  await ate(() => ctx.publicada(r.chaveNova)?.estado === 'esperando_mensagem', 'sessão aberta esperar mensagem');
  return r.chaveNova;
}
const vistoDe = (ctx, chave) => {
  const s = ctx.publicada(chave);
  return { projeto: s.projeto, nome: s.nome ?? null };
};
const mensagem = (ctx, chave, texto) => ctx.orq.executar(cmd('mensagem', chave), { texto, visto: vistoDe(ctx, chave) });
const pedidosPendentes = (ctx, chave, n = 1) =>
  ate(() => {
    const s = ctx.publicada(chave);
    return s?.estado === 'esperando_permissao' && s.permissoes.length >= n && s.permissoes;
  }, 'pedido de permissão aparecer');
const respostasPara = (ctx, id) => ctx.entrada().filter((l) => l.type === 'control_response' && l.response?.request_id === id);

// ---------------------------------------------------------------- CA1 (CR1): sucesso só com o init conferido

test('CA1: um system de hook antes de um init divergente não faz a abertura valer: o comando falha com o erro do init', async (t) => {
  const ctx = preparar(t);
  const r = await abrirCom(ctx, 'hook:init-ruim');
  assert.deepEqual(r, { ok: false, erro: ERRO_INIT });
  await ate(() => ctx.orq.abertas() === 0, 'filho morrer');
});

test('CA1: com o hook antes de um init certo, a abertura vale e devolve a chave nova', async (t) => {
  const ctx = preparar(t);
  const r = await abrirCom(ctx, 'hook:Olá, comece');
  assert.equal(r.ok, true, r.erro);
  assert.match(r.chaveNova, /^principal:[0-9a-f-]{36}$/);
  await ate(() => ctx.publicada(r.chaveNova)?.estado === 'esperando_mensagem', 'sessão esperar mensagem');
});

test('CA1: sessão que morre depois do hook e antes do init responde falha com o motivo da saída', async (t) => {
  const ctx = preparar(t);
  const r = await abrirCom(ctx, 'hook:morre');
  assert.equal(r.ok, false);
  assert.match(r.erro, /^A sessão terminou antes de responder \(código 3\)/);
  assert.doesNotMatch(r.erro, /sk-ant-B{10}/, 'o fim do stderr sai mascarado');
  assert.equal(ctx.orq.abertas(), 0);
});

test('CA1: só o hook, sem init nenhum, não vale como abertura: o comando falha por demora e a sessão é encerrada', async (t) => {
  const ctx = preparar(t, { esperaAberturaMs: 400 });
  const r = await abrirCom(ctx, 'hook:mudo');
  assert.deepEqual(r, { ok: false, erro: ERRO_DEMOROU });
  await ate(() => ctx.orq.abertas() === 0, 'filho morrer');
});

// ---------------------------------------------------------------- CA2 (CR2): negativa antes de sair da lista

test('CA2: interromper nega o pedido pendente no stdin antes do interrupt; o pedido já respondido não recebe outra resposta', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx);
  assert.equal((await mensagem(ctx, chave, 'permissoes:echo um;;echo dois')).ok, true);
  const [p1, p2] = await pedidosPendentes(ctx, chave, 2);
  const r1 = await ctx.orq.executar(cmd('permissao', chave), { pedido: p1.pedido, decisao: 'negar', visto: vistoDe(ctx, chave) });
  assert.equal(r1.ok, true, r1.erro);
  await ate(() => respostasPara(ctx, p1.pedido).length === 1, 'resposta ao primeiro pedido chegar');

  assert.equal((await ctx.orq.executar(cmd('interromper', chave), { visto: vistoDe(ctx, chave) })).ok, true);
  assert.deepEqual(ctx.publicada(chave).permissoes, []);
  await ate(() => ctx.entrada().some((l) => l.type === 'control_request' && l.request?.subtype === 'interrupt'), 'interrupt chegar');

  const linhas = ctx.entrada();
  const iNega = linhas.findIndex((l) => l.type === 'control_response' && l.response?.request_id === p2.pedido);
  const iInt = linhas.findIndex((l) => l.type === 'control_request' && l.request?.subtype === 'interrupt');
  assert.ok(iNega !== -1, 'o pedido pendente recebeu a negativa');
  assert.ok(iNega < iInt, 'a negativa vai antes do interrupt');
  assert.deepEqual(linhas[iNega].response, { subtype: 'success', request_id: p2.pedido, response: { behavior: 'deny', message: 'Interrompido pelo painel.' } });
  assert.equal(respostasPara(ctx, p1.pedido).length, 1, 'o pedido já respondido não recebe segunda resposta');
  assert.equal(respostasPara(ctx, p2.pedido).length, 1);
  await ate(() => ctx.publicada(chave).estado === 'esperando_mensagem', 'sessão voltar a esperar mensagem');
});

test('CA2: o pedido que ainda está pendente quando o turno acaba (result) recebe a negativa', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx);
  assert.equal((await mensagem(ctx, chave, 'pedido-solto:echo solto')).ok, true);
  await ate(() => respostasPara(ctx, 'req_solto').length === 1, 'negativa do pedido solto chegar');
  assert.deepEqual(respostasPara(ctx, 'req_solto')[0].response, { subtype: 'success', request_id: 'req_solto', response: { behavior: 'deny', message: 'Pedido encerrado.' } });
  const s = ctx.publicada(chave);
  assert.equal(s.estado, 'esperando_mensagem');
  assert.deepEqual(s.permissoes, []);
});

// ---------------------------------------------------------------- CA3 (CR3): filho que nem o SIGKILL encerra

test('CA3: se nem o SIGKILL encerra o filho no prazo, o registro é finalizado, sai da contagem e o log cita o pid', async (t) => {
  const ctx = preparar(t, { maxSessoes: 1, esperaFimMs: 100, esperaTermMs: 100, esperaKillMs: 200 });
  const chave = await abrir(ctx);
  assert.equal((await mensagem(ctx, chave, 'teimoso')).ok, true); // ignora o fim do stdin e o SIGTERM
  await ate(() => ctx.publicada(chave)?.estado === 'esperando_mensagem', 'teimoso responder');
  const { pid } = ctx.orq.sessoes.get(chave).filho;

  // O SIGKILL "não chega": process.kill substituído só para este pid e os sinais de encerrar.
  const killOriginal = process.kill;
  const errOriginal = console.error;
  const logs = [];
  process.kill = function (alvo, sinal) {
    if (Math.abs(alvo) === pid && (sinal === 'SIGKILL' || sinal === 'SIGTERM')) return true;
    return killOriginal.call(process, alvo, sinal);
  };
  console.error = (...a) => logs.push(a.join(' '));
  let r;
  try {
    r = await ctx.orq.executar(cmd('encerrar', chave), { visto: vistoDe(ctx, chave) });
  } finally {
    process.kill = killOriginal;
    console.error = errOriginal;
  }
  try {
    assert.deepEqual(r, { ok: false, erro: ERRO_NAO_ENCERROU });
    assert.equal(ctx.orq.abertas(), 0, 'a vaga foi liberada');
    assert.equal(ctx.orq.sessoes.has(chave), false);
    const log = logs.find((l) => l.includes('não respondeu ao SIGKILL'));
    assert.ok(log, `log do SIGKILL: ${JSON.stringify(logs)}`);
    assert.ok(log.includes(String(pid)), 'o log cita o pid');
    // A vaga liberada vale de verdade: com maxSessoes 1, outra abertura passa.
    const outra = await abrirCom(ctx, 'Outra sessão');
    assert.equal(outra.ok, true, outra.erro);
  } finally {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* já morreu */
    }
  }
});

// ---------------------------------------------------------------- CA4 (CR4): cota do dia volta se o spawn falha

const lerContador = (ctx) => JSON.parse(fs.readFileSync(ctx.arqContagem, 'utf8'));
function semearContador(ctx, n) {
  fs.mkdirSync(ctx.pastaEstado, { recursive: true });
  fs.writeFileSync(ctx.arqContagem, JSON.stringify({ dia: diaLocal(Date.now()), n }));
}

test('CA4: com o claude inexistente (ENOENT no evento error), três aberturas falham e o contador do dia fica igual', async (t) => {
  const ctx = preparar(t, { claudeBin: path.join(BASE, 'nao-existe', 'claude') });
  semearContador(ctx, 2);
  for (let i = 0; i < 3; i++) {
    const r = await abrirCom(ctx, 'Olá');
    assert.deepEqual(r, { ok: false, erro: ERRO_INICIAR });
  }
  assert.deepEqual(lerContador(ctx), { dia: diaLocal(Date.now()), n: 2 });
  assert.equal(ctx.orq.abertas(), 0);
});

test('CA4: falha síncrona do spawn também devolve a abertura (contador sem arquivo volta a zero)', async (t) => {
  const ctx = preparar(t, { claudeBin: `claude${String.fromCharCode(0)}x` });
  for (let i = 0; i < 3; i++) assert.deepEqual(await abrirCom(ctx, 'Olá'), { ok: false, erro: ERRO_INICIAR });
  assert.equal(lerContador(ctx).n, 0);
});

test('CA4: contador corrompido não é tocado pela devolução (continua valendo como teto)', async (t) => {
  const ctx = preparar(t);
  fs.mkdirSync(ctx.pastaEstado, { recursive: true });
  fs.writeFileSync(ctx.arqContagem, 'lixo{');
  const errOriginal = console.error;
  console.error = () => {};
  try {
    ctx.orq.devolverAbertura();
    assert.equal(fs.readFileSync(ctx.arqContagem, 'utf8'), 'lixo{');
    assert.match((await abrirCom(ctx, 'Olá')).erro, /^Limite de 20 aberturas/);
  } finally {
    console.error = errOriginal;
  }
});

test('CA4: falha ao gravar a devolução fica só no log, sem lançar e sem citar dado', async (t) => {
  const ctx = preparar(t);
  semearContador(ctx, 3);
  const errOriginal = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  fs.chmodSync(ctx.pastaEstado, 0o500);
  try {
    assert.doesNotThrow(() => ctx.orq.devolverAbertura());
  } finally {
    fs.chmodSync(ctx.pastaEstado, 0o700);
    console.error = errOriginal;
  }
  assert.equal(lerContador(ctx).n, 3);
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.match(logs[0], /^orquestrador: não foi possível devolver a abertura ao contador \(abrir\.json\) \(E[A-Z]+\)/);
});
