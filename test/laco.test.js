// Laço do coletor e configuração local do canal de comandos (PLANO, tarefa 7). Tudo em pastas
// temporárias, com segredos sorteados aqui, o claude falso (test/fixtures/claude-falso.js) e um painel
// falso em 127.0.0.1: nada lê ~/.config/moises, ~/.local/state/moises, ~/.claude* nem .env*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lerProjetos, proximoIntervalo, contarOcupadas, tratarComandos, conferirPainelPublicado, rodar } from '../collector/index.js';
import { Auditoria } from '../collector/auditoria.js';
import { Chaveiro, Porteiro } from '../collector/comandos.js';
import { MODELOS, ESFORCOS, MODOS } from '../collector/orquestrador.js';
import * as col from '../collector/assinatura.js';
import * as nav from '../public/assinatura.js';
import { aparelho as novoAparelho, assinarCom, gravarChaves as gravarChavesNoFormato } from './fixtures/aparelho.js';

// O ambiente de quem roda os testes não pode desligar o canal nem esconder texto por acidente.
delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_SUBIR_TEXTO;

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const INDEX = path.join(RAIZ, 'collector/index.js');
const CONFIGURAR = path.join(RAIZ, 'scripts/configurar-comandos.js');
const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
const PUBLICA = path.join(RAIZ, 'public');
// Rodada 2 (S27): a conferência cobre todos os arquivos de public/ (com as subpastas) e o caminho `/`.
const arquivosDe = (pasta) =>
  fs.readdirSync(pasta, { recursive: true }).map((n) => n.split(path.sep).join('/')).filter((n) => fs.statSync(path.join(pasta, n)).isFile()).sort();
const ARQUIVOS_PAINEL = arquivosDe(PUBLICA);
const PEDIDOS_DA_CONFERENCIA = [...ARQUIVOS_PAINEL, ''].sort(); // '' é o GET de `/`
const PAINEL_ALTERADO = 'O painel publicado é diferente do código deste computador; comandos desligados.';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-laco-'));
// O encerrar antigo grava os limites onde a variável manda (lida no primeiro uso, não na importação).
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
const SEGREDO = 'TEXTO-SECRETO-DA-SESSAO que nao pode ir para log nem auditoria';
const ERRO_GENERICO = 'Erro interno do coletor.';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let casos = 0;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, descricao, ms = 10_000) {
  const limite = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`esperou demais: ${descricao}`);
    await espera(20);
  }
}
function adiado() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const assinar = (privada, c) => assinarCom(privada, c);
const novoId = () => `c_${crypto.randomBytes(8).toString('hex')}`;
const lerLinhas = (arq) => (fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const gravarChaves = (arquivo, aparelhos) => gravarChavesNoFormato(arquivo, aparelhos);

// Porteiro de verdade (chaveiro, auditoria e vistos numa pasta própria) e um aparelho autorizado.
function canal() {
  const d = novaPasta();
  const ap = novoAparelho(null, 'celular'); // kid derivado da chave pública (Rodada 2, SE-B3 do dev B)
  const chavesArq = path.join(d, 'chaves-comandos.json');
  gravarChaves(chavesArq, [ap]);
  const estado = path.join(d, 'estado');
  const audArq = path.join(estado, 'auditoria.jsonl');
  const chaveiro = new Chaveiro({ arquivo: chavesArq });
  const porteiro = new Porteiro({ chaveiro, pastaEstado: estado, auditoria: new Auditoria({ arquivo: audArq }) });
  const comando = (campos = {}) =>
    assinar(ap.privada, {
      v: 1, kid: ap.kid, id: novoId(), tipo: 'mensagem', chave: SESSAO, criadoEm: Date.now(),
      dados: JSON.stringify({ texto: SEGREDO, visto: { projeto: 'p', nome: null } }), ...campos,
    });
  // Aceito, feito e falhou em auditoria.jsonl; recusas em auditoria-recusas.jsonl (S21).
  return { d, ap, porteiro, comando, linhas: () => lerLinhas(audArq), recusas: () => lerLinhas(path.join(estado, 'auditoria-recusas.jsonl')) };
}

// Orquestrador espião: registra as chamadas e responde com `impl`.
function espiao(impl = async () => ({ ok: true })) {
  const chamadas = [];
  return { chamadas, executar: (cmd, dados) => (chamadas.push({ cmd, dados }), impl(cmd, dados)) };
}

// ---------------------------------------------------------------- lerProjetos e proximoIntervalo

test('lerProjetos ignora nome ou caminho inválido e arquivo ausente', () => {
  const d = novaPasta();
  const arq = path.join(d, 'projetos.json');
  assert.deepEqual(Object.entries(lerProjetos(arq)), [], 'arquivo ausente');
  fs.writeFileSync(arq, '{quebrado');
  assert.deepEqual(Object.entries(lerProjetos(arq)), [], 'JSON inválido');
  fs.writeFileSync(arq, '["/tmp"]');
  assert.deepEqual(Object.entries(lerProjetos(arq)), [], 'lista no lugar de objeto');
  fs.writeFileSync(arq, 'null');
  assert.deepEqual(Object.entries(lerProjetos(arq)), [], 'null');
  fs.writeFileSync(
    arq,
    JSON.stringify({
      moises: '/home/x/moises',
      'outro_projeto.v2': '/srv/outro',
      '../fora': '/tmp',
      'com espaço': '/tmp',
      [`${'a'.repeat(61)}`]: '/tmp',
      '': '/tmp',
      relativo: 'pasta/relativa',
      numero: 3,
      nulo: null,
      lista: ['/tmp'],
    }),
  );
  assert.deepEqual(Object.entries(lerProjetos(arq)), [
    ['moises', '/home/x/moises'],
    ['outro_projeto.v2', '/srv/outro'],
  ]);
  assert.deepEqual(Object.entries(lerProjetos(path.join(d, 'pasta-que-nao-existe', 'p.json'))), []);
  assert.deepEqual(Object.entries(lerProjetos(d)), [], 'pasta no lugar do arquivo');
});

test('proximoIntervalo: rápido com o painel aberto, sessão comandada trabalhando ou esperando permissão, ou ack na fila; senão lento', () => {
  const agora = 1_794_387_000_000;
  const base = { painelVistoEm: null, ocupadas: 0, acksPendentes: 0, agora, lento: 20_000, rapido: 3_000 };
  // 1. nada acontecendo
  assert.equal(proximoIntervalo(base), 20_000);
  assert.equal(proximoIntervalo({ ...base, painelVistoEm: agora - 60_000 }), 20_000, 'painel visto há 60 s já não conta');
  // 2. painel visto há menos de 60 s
  assert.equal(proximoIntervalo({ ...base, painelVistoEm: agora - 59_000 }), 3_000);
  assert.equal(proximoIntervalo({ ...base, painelVistoEm: agora }), 3_000);
  // 3. sessão comandada trabalhando ou esperando permissão
  assert.equal(proximoIntervalo({ ...base, ocupadas: 1 }), 3_000);
  // Sessão comandada só aberta (esperando mensagem) já não acelera (A4).
  assert.equal(proximoIntervalo({ ...base, abertas: 1 }), 20_000);
  // 4. ack na fila
  assert.equal(proximoIntervalo({ ...base, acksPendentes: 2 }), 3_000);
  // Valor de painelVistoEm que não é número, ou muito no futuro (vem do servidor), não acelera.
  assert.equal(proximoIntervalo({ ...base, painelVistoEm: 'agora' }), 20_000);
  assert.equal(proximoIntervalo({ ...base, painelVistoEm: agora + 10 * 60_000 }), 20_000);
});

test('contarOcupadas conta só sessões comandadas trabalhando ou esperando permissão', () => {
  const s = (gerenciada, estado) => ({ chave: SESSAO, gerenciada, estado });
  const retrato = {
    sessoes: [
      s(true, 'trabalhando'),
      s(true, 'esperando_permissao'),
      s(true, 'esperando_mensagem'),
      s(true, 'encerrada'),
      s(false, 'trabalhando'),
      s(undefined, 'esperando_permissao'),
      null,
    ],
  };
  assert.equal(contarOcupadas(retrato), 2);
  assert.equal(contarOcupadas({ sessoes: [] }), 0);
  assert.equal(contarOcupadas({}), 0);
  assert.equal(contarOcupadas(null), 0);
});

// ---------------------------------------------------------------- tratarComandos

test('tratarComandos recusa sem credencial e não executa', async () => {
  const m = canal();
  const orq = espiao();
  const acks = [];
  const { assinatura, ...semAssinatura } = m.comando();
  const trocada = m.comando();
  trocada.assinatura = (trocada.assinatura[0] === 'A' ? 'B' : 'A') + trocada.assinatura.slice(1);
  const execucoes = await tratarComandos({ comandos: [semAssinatura, trocada], porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: () => {} });
  assert.equal(orq.chamadas.length, 0);
  assert.deepEqual(execucoes, []);
  assert.deepEqual(acks, [
    { id: semAssinatura.id, estado: 'recusado', erro: 'Comando sem assinatura.', motivo: 'sem_credencial' },
    { id: trocada.id, estado: 'recusado', erro: 'A assinatura do comando não confere com a chave deste aparelho.', motivo: 'assinatura' },
  ]);
  assert.deepEqual(m.linhas(), [], 'recusa não vai para o arquivo dos aceitos');
  assert.deepEqual(m.recusas().map((l) => [l.id, l.decisao, l.motivo]), [
    [semAssinatura.id, 'recusado', 'sem_credencial'],
    [trocada.id, 'recusado', 'assinatura'],
  ]);
  // Com o canal desligado, nem um comando válido passa.
  process.env.MOISES_COMANDOS = '0';
  try {
    const valido = m.comando();
    acks.length = 0;
    await tratarComandos({ comandos: [valido], porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: () => {} });
    assert.equal(orq.chamadas.length, 0);
    assert.deepEqual([acks[0].estado, acks[0].motivo], ['recusado', 'desligado']);
  } finally {
    delete process.env.MOISES_COMANDOS;
  }
});

test('tratarComandos confirma o recebimento antes do resultado e depois o resultado', async () => {
  const m = canal();
  const pendentes = [];
  const orq = espiao(() => {
    const a = adiado();
    pendentes.push(a);
    return a.promise;
  });
  const acks = [];
  let acordou = 0;
  const logs = [];
  // O que o laço passa ao porteiro ao concluir (R3: a chave da sessão criada vai junto).
  const concluidos = [];
  const concluirReal = m.porteiro.concluir.bind(m.porteiro);
  m.porteiro.concluir = (c, fim) => {
    concluidos.push([c.id, fim]);
    return concluirReal(c, fim);
  };
  const ok = { ...m.comando(), idadeMs: 1234 };
  const ruim = m.comando({ tipo: 'interromper', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  const execucoes = await tratarComandos({ comandos: [ok, ruim], porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => acordou++, log: (...a) => logs.push(a.join(' ')) });

  // Os dois foram recebidos e estão executando; nenhum resultado ainda.
  assert.deepEqual(acks, [{ id: ok.id, estado: 'recebido' }, { id: ruim.id, estado: 'recebido' }]);
  assert.equal(execucoes.length, 2);
  assert.equal(acordou, 0);
  assert.equal(orq.chamadas.length, 2);
  // O orquestrador recebe os campos de que precisa, sem dados nem assinatura, e os dados conferidos pelo porteiro.
  const [{ cmd, dados }] = orq.chamadas;
  assert.deepEqual({ id: cmd.id, tipo: cmd.tipo, chave: cmd.chave, idadeMs: cmd.idadeMs }, { id: ok.id, tipo: 'mensagem', chave: SESSAO, idadeMs: 1234 });
  assert.equal('dados' in cmd, false);
  assert.equal('assinatura' in cmd, false);
  assert.equal(dados.texto, SEGREDO);
  assert.equal(orq.chamadas[1].cmd.idadeMs, 0, 'sem idadeMs do servidor, conta zero');

  // O segundo termina antes do primeiro: cada resultado sai quando fica pronto.
  pendentes[1].resolve({ ok: false, erro: 'Esta sessão não foi aberta pelo Moisés; só é possível ver e encerrar.' });
  await ate(() => acordou === 1, 'primeiro resultado');
  assert.deepEqual(acks[2], { id: ruim.id, estado: 'falhou', erro: 'Esta sessão não foi aberta pelo Moisés; só é possível ver e encerrar.' });
  const log = { nome: 'x', custo: 1 };
  pendentes[0].resolve({ ok: true, log, chaveNova: 'principal:0f0e0d0c-0b0a-4908-8706-050403020100' });
  await Promise.all(execucoes);
  assert.equal(acordou, 2);
  assert.deepEqual(acks[3], { id: ok.id, estado: 'feito', erro: null, log, chaveNova: 'principal:0f0e0d0c-0b0a-4908-8706-050403020100' });
  assert.equal(acks.length, 4);
  assert.deepEqual(concluidos, [
    [ruim.id, { ok: false, erro: 'Esta sessão não foi aberta pelo Moisés; só é possível ver e encerrar.', chaveNova: null }],
    [ok.id, { ok: true, erro: null, chaveNova: 'principal:0f0e0d0c-0b0a-4908-8706-050403020100' }],
  ]);

  // Auditoria: aceito e depois feito ou falhou, via porteiro.concluir; sem o texto da mensagem.
  const linhas = m.linhas();
  assert.deepEqual(linhas.map((l) => [l.id, l.decisao]), [
    [ok.id, 'aceito'],
    [ruim.id, 'aceito'],
    [ruim.id, 'falhou'],
    [ok.id, 'feito'],
  ]);
  assert.equal(linhas[3].quem, `${m.ap.kid} (celular)`);
  const tudo = JSON.stringify(linhas) + logs.join('\n');
  assert.ok(!tudo.includes('TEXTO-SECRETO'));
});

test('comando sem tipo é recusado e não vira encerrar', async () => {
  const m = canal();
  const orq = espiao();
  const acks = [];
  // O pedido de encerrar antigo, sem tipo e sem assinatura.
  const antigo = { id: novoId(), chave: SESSAO, criadoEm: Date.now(), idadeMs: 0 };
  // Assinado de verdade, mas sem tipo.
  const { v, kid, id, chave, criadoEm, dados } = m.comando({ tipo: 'encerrar' });
  const assinadoSemTipo = assinar(m.ap.privada, { v, kid, id, chave, criadoEm, dados });
  assert.equal('tipo' in assinadoSemTipo, false);
  // Ids que não são texto: ignorados sem ack.
  const lixo = [null, 'x', 7, { id: 7, tipo: 'encerrar', chave: SESSAO }, { tipo: 'encerrar', chave: SESSAO }];
  await tratarComandos({ comandos: [antigo, assinadoSemTipo, ...lixo], porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: () => {} });
  assert.equal(orq.chamadas.length, 0);
  assert.deepEqual(acks.map((a) => [a.id, a.estado, a.motivo]), [
    [antigo.id, 'recusado', 'sem_credencial'],
    [assinadoSemTipo.id, 'recusado', 'formato'],
  ]);
  // Lista que não é lista também não quebra.
  await tratarComandos({ comandos: null, porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: () => {} });
  assert.equal(acks.length, 2);
  // O laço não executa mais nada fora do porteiro: o encerrar antigo saiu do coletor.
  const fonte = fs.readFileSync(INDEX, 'utf8');
  assert.ok(!fonte.includes('executarEncerrar'));
});

test('tratarComandos trata no máximo 20 comandos por resposta', async () => {
  const m = canal();
  const orq = espiao();
  const acks = [];
  const cmds = Array.from({ length: 25 }, () => m.comando());
  const execucoes = await tratarComandos({ comandos: cmds, porteiro: m.porteiro, orquestrador: orq, acks, log: () => {} });
  await Promise.all(execucoes);
  assert.equal(orq.chamadas.length, 20);
  const ids = new Set(acks.map((a) => a.id));
  assert.deepEqual([...ids], cmds.slice(0, 20).map((c) => c.id), 'os 5 últimos ficam sem ack (o servidor entrega de novo)');
  // Lixo também conta no teto: 20 itens sem id ocupam a vez dos comandos depois deles.
  acks.length = 0;
  await tratarComandos({ comandos: [...Array(20).fill(null), m.comando()], porteiro: m.porteiro, orquestrador: orq, acks, log: () => {} });
  assert.deepEqual(acks, []);
});

test('tratarComandos com o painel alterado recusa tudo antes do porteiro (porteiro sem desligar)', async () => {
  const m = canal();
  const orq = espiao();
  const acks = [];
  const logs = [];
  let conferidos = 0;
  // Porteiro sem desligar/religar: o laço é quem recusa.
  const porteiro = { conferir: (c) => (conferidos++, m.porteiro.conferir(c)), concluir: (c, f) => m.porteiro.concluir(c, f), ativo: () => m.porteiro.ativo() };
  const bloqueio = { motivo: 'painel_alterado', erro: PAINEL_ALTERADO };
  const cmds = [m.comando(), m.comando({ tipo: 'interromper', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) })];
  const execucoes = await tratarComandos({ comandos: [...cmds, { id: 7 }], porteiro, orquestrador: orq, acks, bloqueio, log: (...a) => logs.push(a.join(' ')) });
  assert.deepEqual(execucoes, []);
  assert.equal(orq.chamadas.length, 0);
  assert.equal(conferidos, 0);
  assert.deepEqual(acks, cmds.map((c) => ({ id: c.id, estado: 'recusado', erro: PAINEL_ALTERADO, motivo: 'painel_alterado' })));
  assert.ok(logs.every((l) => l.includes('painel_alterado')));
  assert.equal(logs.length, 2);
  // Sem bloqueio, o mesmo porteiro aceita um comando novo.
  acks.length = 0;
  await Promise.all(await tratarComandos({ comandos: [m.comando()], porteiro, orquestrador: orq, acks, log: () => {} }));
  assert.equal(acks[0].estado, 'recebido');
});

test('exceção na execução vira falhou com erro genérico', async (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const m = canal();
  let n = 0;
  const orq = espiao(() => {
    n++;
    if (n === 1) throw new Error(SEGREDO); // síncrona
    if (n === 2) return Promise.reject(new TypeError(SEGREDO)); // assíncrona
    if (n === 3) return undefined; // resultado fora do formato
    return { ok: false }; // falhou sem erro
  });
  const acks = [];
  const logs = [];
  const cmds = [m.comando(), m.comando(), m.comando(), m.comando()];
  const execucoes = await tratarComandos({ comandos: cmds, porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: (...a) => logs.push(a.map(String).join(' ')) });
  await Promise.all(execucoes);
  const finais = acks.filter((a) => a.estado !== 'recebido');
  assert.deepEqual(finais, cmds.map((c) => ({ id: c.id, estado: 'falhou', erro: ERRO_GENERICO })));
  assert.deepEqual(m.linhas().filter((l) => l.decisao === 'falhou').length, 4);
  // O detalhe vai para o log, sem o texto da exceção (que poderia trazer texto de sessão).
  assert.ok(logs.some((l) => /TypeError/.test(l)));
  const tudo = logs.join('\n') + avisos.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n') + fs.readFileSync(path.join(m.d, 'estado', 'auditoria.jsonl'), 'utf8');
  assert.ok(!tudo.includes('TEXTO-SECRETO'));
});

// ---------------------------------------------------------------- configurar-comandos

// Pasta de configuração temporária com os três arquivos que o script não pode tocar, e a pasta de
// estado do coletor (onde ele grava os pedidos de pareamento que o servidor entrega).
function configuracao() {
  const d = novaPasta();
  const conf = path.join(d, 'conf');
  const home = path.join(d, 'home');
  const estado = path.join(d, 'estado');
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(home);
  fs.mkdirSync(estado, { mode: 0o700 });
  const outros = { 'coletor.env': 'MOISES_URL=https://falso.example\nMOISES_TOKEN=token-falso\n', 'vercel.env': 'SESSION_SECRET=falso\n', 'senha-painel.txt': 'senha-falsa\n' };
  const antigo = new Date('2026-01-02T03:04:05Z');
  for (const [nome, conteudo] of Object.entries(outros)) {
    fs.writeFileSync(path.join(conf, nome), conteudo, { mode: 0o600 });
    fs.utimesSync(path.join(conf, nome), antigo, antigo);
  }
  const rodarScript = (...args) =>
    spawnSync(process.execPath, [CONFIGURAR, ...args], { env: { PATH: process.env.PATH, HOME: home, MOISES_PASTA_CONF: conf, MOISES_ESTADO: estado }, encoding: 'utf8', timeout: 20_000 });
  const outrosIntactos = () => {
    for (const [nome, conteudo] of Object.entries(outros)) {
      const arq = path.join(conf, nome);
      assert.equal(fs.readFileSync(arq, 'utf8'), conteudo, nome);
      assert.equal(fs.statSync(arq).mtimeMs, antigo.getTime(), nome);
    }
  };
  const chavesArq = path.join(conf, 'chaves-comandos.json');
  const chaves = () => JSON.parse(fs.readFileSync(chavesArq, 'utf8'));
  const pedidosArq = path.join(estado, 'aparelhos-pedidos.json');
  // Grava os pedidos como o coletor grava (lista de { kid, publica, rotulo, criadoEm }), mas sem conferir.
  const pedidos = (lista) => fs.writeFileSync(pedidosArq, JSON.stringify(lista), { mode: 0o600 });
  return { conf, home, estado, rodarScript, outrosIntactos, chavesArq, chaves, pedidosArq, pedidos };
}
const modo = (arq) => fs.statSync(arq).mode & 0o777;
const pedidoDe = (ap, criadoEm = Date.now()) => ({ kid: ap.kid, publica: ap.publica, rotulo: ap.rotulo, criadoEm });

// Dois aparelhos diferentes com o mesmo kid (24 bits): pelo paradoxo do aniversário, alguns milhares de
// pares bastam (menos de 1 s). Calculado uma vez, quando um teste precisa.
let colisao = null;
function doisComOMesmoKid() {
  if (colisao) return colisao;
  const vistos = new Map();
  for (;;) {
    const a = novoAparelho(null, 'celular');
    const b = vistos.get(a.kid);
    if (b && b.publica !== a.publica) return (colisao = [b, { ...a, rotulo: 'intruso' }]);
    vistos.set(a.kid, a);
  }
}

test('configurar-comandos --pedidos lista kid, rótulo e horário, e nunca a chave pública nem a impressão digital', () => {
  const c = configuracao();
  // Sem arquivo de pedidos: diz que não há e explica como pedir.
  const vazio = c.rodarScript('--pedidos');
  assert.equal(vazio.status, 0, vazio.stderr);
  assert.match(vazio.stdout, /Nenhum pedido de autorização/);
  const a = novoAparelho(null, 'celular do dono');
  const b = novoAparelho(null, 'tablet');
  const mentiroso = { ...pedidoDe(novoAparelho(null, 'mentiroso')), kid: a.kid.split('').reverse().join('') };
  const vencido = novoAparelho(null, 'vencido');
  const comControle = novoAparelho(null, `rtl${String.fromCodePoint(0x202e)}falso`);
  c.pedidos([pedidoDe(a), pedidoDe(b), mentiroso, pedidoDe(vencido, Date.now() - 2 * 3_600_000), pedidoDe(comControle), { lixo: true }, 'texto']);
  const r = c.rodarScript('--pedidos');
  assert.equal(r.status, 0, r.stderr);
  for (const ap of [a, b]) {
    const linha = r.stdout.split('\n').find((l) => l.includes(ap.kid));
    assert.ok(linha, `linha do ${ap.rotulo}`);
    assert.ok(linha.includes(ap.rotulo));
    assert.match(linha, /\d{2}:\d{2}/, 'horário do pedido');
  }
  const saida = r.stdout + r.stderr;
  // Rodada 2 (SE-M3): a impressão digital é digitada a partir do aparelho; copiá-la do terminal pularia a conferência.
  for (const ap of [a, b]) assert.ok(!saida.includes(ap.impressao) && !saida.includes(ap.impressao.replaceAll('-', '')), 'nunca a impressão digital');
  for (const ap of [a, b, vencido, comControle]) assert.ok(!saida.includes(ap.publica), 'nunca a chave pública');
  // Pedido incoerente (kid que não é o da chave), vencido ou com caractere de controle não aparece.
  assert.ok(!saida.includes('mentiroso'));
  assert.ok(!saida.includes(mentiroso.kid));
  assert.ok(!saida.includes(vencido.kid));
  assert.ok(!saida.includes(comControle.kid));
  // Depois de autorizado, o pedido some da lista.
  assert.equal(c.rodarScript('--autorizar', a.kid, a.impressao).status, 0);
  const depois = c.rodarScript('--pedidos');
  assert.ok(!depois.stdout.includes(a.kid));
  assert.ok(depois.stdout.includes(b.kid));
  c.outrosIntactos();
  assert.deepEqual(fs.readdirSync(c.home), [], 'nada fora da pasta indicada');
});

test('configurar-comandos --autorizar grava a chave pública conferida com permissão 600, sem imprimi-la e sem tocar nos outros arquivos', async () => {
  const c = configuracao();
  // O aparelho é o do navegador (public/assinatura.js): privada não extraível, pública raw em base64url.
  const doNavegador = await nav.gerarAparelho();
  const pedido = { kid: doNavegador.kid, publica: doNavegador.publica, rotulo: 'celular do dono', criadoEm: Date.now() };
  c.pedidos([pedido]);
  // A impressão digital vale sem hífens e em maiúsculas.
  const r = c.rodarScript('--autorizar', doNavegador.kid, doNavegador.impressao.replaceAll('-', '').toUpperCase());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(c.chaves()), [doNavegador.kid]);
  const entrada = c.chaves()[doNavegador.kid];
  assert.deepEqual(Object.keys(entrada).sort(), ['criadaEm', 'publica', 'rotulo']);
  assert.equal(entrada.publica, doNavegador.publica);
  assert.equal(entrada.rotulo, 'celular do dono');
  assert.ok(!Number.isNaN(Date.parse(entrada.criadaEm)));
  assert.equal(modo(c.chavesArq), 0o600);
  // Só kid, rótulo, impressão digital (e a instrução de conferir); nunca a chave pública.
  const saida = r.stdout + r.stderr;
  assert.ok(!saida.includes(doNavegador.publica));
  assert.ok(r.stdout.includes(doNavegador.kid));
  assert.ok(r.stdout.includes(doNavegador.impressao));
  assert.ok(r.stdout.includes('celular do dono'));
  assert.match(r.stdout, /--revogar/);
  // Não existe mais código do aparelho em arquivo.
  assert.deepEqual(fs.readdirSync(c.conf).filter((n) => n.startsWith('codigo-')), []);
  // projetos.json nasce vazio, e não é recriado se já existe.
  const projetosArq = path.join(c.conf, 'projetos.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(projetosArq, 'utf8')), {});
  c.outrosIntactos();
  assert.deepEqual(fs.readdirSync(c.home), [], 'nada fora da pasta indicada');
  // O formato gravado é o que o chaveiro do coletor lê, e um comando assinado no navegador passa no porteiro.
  const chaveiro = new Chaveiro({ arquivo: c.chavesArq });
  assert.deepEqual(chaveiro.aparelhos(), [{ kid: doNavegador.kid, rotulo: 'celular do dono' }]);
  const porteiro = new Porteiro({ chaveiro, pastaEstado: path.join(c.estado, 'p'), auditoria: new Auditoria({ arquivo: path.join(c.estado, 'p', 'a.jsonl') }) });
  const cmd = await nav.assinarComando(doNavegador, { tipo: 'interromper', chave: SESSAO, dados: { visto: { projeto: 'p', nome: null } } });
  assert.equal(porteiro.conferir(cmd).ok, true);
  // Autorizar de novo o mesmo aparelho não muda nada.
  fs.writeFileSync(projetosArq, '{"moises":"/tmp"}');
  const antes = fs.readFileSync(c.chavesArq, 'utf8');
  // E também em grupos separados por espaço (vários argumentos).
  const de_novo = c.rodarScript('--autorizar', doNavegador.kid, ...doNavegador.impressao.split('-'));
  assert.equal(de_novo.status, 0, de_novo.stderr);
  assert.match(de_novo.stdout, /já está autorizado/);
  assert.equal(fs.readFileSync(c.chavesArq, 'utf8'), antes);
  assert.deepEqual(JSON.parse(fs.readFileSync(projetosArq, 'utf8')), { moises: '/tmp' });
});

test('configurar-comandos --autorizar não autoriza sem a impressão digital certa, nem kid sem pedido, pedido incoerente ou vencido', () => {
  const c = configuracao();
  const a = novoAparelho(null, 'celular');
  const foraDaCurva = Buffer.from(a.publica, 'base64url');
  foraDaCurva[64] ^= 1;
  const publicaRuim = foraDaCurva.toString('base64url');
  const hashRuim = crypto.createHash('sha256').update(foraDaCurva).digest('hex');
  const kidRuim = hashRuim.slice(0, 6);
  const outro = novoAparelho(null, 'outro');
  const vencido = novoAparelho(null, 'vencido');
  const [x, y] = doisComOMesmoKid();
  c.pedidos([
    { kid: kidRuim, publica: publicaRuim, rotulo: 'fora da curva', criadoEm: Date.now() },
    { ...pedidoDe(outro), kid: a.kid }, // kid de um aparelho, chave de outro
    { ...pedidoDe(a), publica: a.publica.slice(0, 86) }, // chave pública curta
    pedidoDe(vencido, Date.now() - 3_600_001),
    pedidoDe(x),
    pedidoDe(y), // mesmo kid, outra chave
  ]);
  const casos = [
    [[], 'sem argumento'],
    [['celular'], 'rótulo solto (uso antigo, que gerava código)'],
    [['--desconhecida'], 'opção desconhecida'],
    [['--autorizar'], 'sem kid'],
    [['--autorizar', '../coletor.env'], 'kid fora do formato'],
    [['--autorizar', 'zzzzzz', x.impressao], 'kid sem pedido'],
    [['--autorizar', kidRuim, hashRuim.slice(0, 16)], 'ponto fora da curva'],
    [['--autorizar', a.kid, a.impressao], 'kid de outra chave e chave curta'],
    [['--autorizar', vencido.kid, vencido.impressao], 'pedido vencido'],
    [['--autorizar', x.kid], 'sem a impressão digital'],
    [['--autorizar', x.kid, '0000-0000-0000-0000'], 'impressão digital errada'],
    [['--autorizar', x.kid, x.impressao.slice(0, -1)], 'impressão digital curta'],
    [['--autorizar', x.kid, `${x.impressao}0`], 'impressão digital longa'],
    [['--autorizar', x.kid, x.impressao.replace(/[0-9a-f]$/, 'g')], 'impressão digital fora do hexadecimal'],
  ];
  for (const [args, nome] of casos) {
    const r = c.rodarScript(...args);
    assert.equal(r.status, 1, nome);
    const saida = r.stdout + r.stderr;
    for (const ap of [a, x, y, outro, vencido]) assert.ok(!saida.includes(ap.publica), `${nome}: não imprime chave`);
  }
  assert.equal(fs.existsSync(c.chavesArq), false, 'nada foi autorizado');
  // Sem a impressão, ou com outra, a recusa explica o que fazer.
  for (const extra of [[], ['0000-0000-0000-0000']]) {
    const r = c.rodarScript('--autorizar', x.kid, ...extra);
    assert.ok(r.stderr.includes('Confira a impressão digital mostrada no aparelho e passe-a: --autorizar <kid> <impressão>'), r.stderr);
  }
  // Pedido trocado entre --pedidos e --autorizar, com o mesmo kid: o dono viu (e digita) a impressão de x,
  // mas o servidor passou a entregar y. Nada é gravado.
  c.pedidos([pedidoDe(x)]);
  assert.ok(c.rodarScript('--pedidos').stdout.includes(x.kid));
  c.pedidos([pedidoDe(y)]);
  const trocado = c.rodarScript('--autorizar', x.kid, x.impressao);
  assert.equal(trocado.status, 1);
  assert.match(trocado.stderr, /não é a do pedido/);
  assert.equal(fs.existsSync(c.chavesArq), false, 'o pedido trocado não foi gravado');
  // Com os dois pedidos do mesmo kid, a impressão digital escolhe o certo.
  c.pedidos([pedidoDe(x), pedidoDe(y)]);
  assert.equal(c.rodarScript('--autorizar', x.kid, x.impressao).status, 0);
  assert.deepEqual(Object.keys(c.chaves()), [x.kid]);
  assert.equal(c.chaves()[x.kid].publica, x.publica);
  // Aparelho já autorizado com o mesmo kid e outra chave: não substitui (o dono revoga antes).
  c.pedidos([pedidoDe(y)]);
  const r = c.rodarScript('--autorizar', y.kid, y.impressao);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--revogar/);
  assert.equal(c.chaves()[x.kid].publica, x.publica);
  // Arquivo de chaves corrompido: o script não sobrescreve (perderia os aparelhos).
  fs.writeFileSync(c.chavesArq, '{quebrado', { mode: 0o600 });
  c.pedidos([pedidoDe(outro)]);
  assert.equal(c.rodarScript('--autorizar', outro.kid, outro.impressao).status, 1);
  assert.equal(fs.readFileSync(c.chavesArq, 'utf8'), '{quebrado');
  c.outrosIntactos();
});

test('segundo aparelho não apaga o primeiro, e o rótulo repetido gera aviso', () => {
  const c = configuracao();
  const a = novoAparelho(null, 'celular');
  const b = novoAparelho(null, 'celular');
  c.pedidos([pedidoDe(a), pedidoDe(b)]);
  const r1 = c.rodarScript('--autorizar', a.kid, a.impressao);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(!/mesmo rótulo/.test(r1.stdout + r1.stderr));
  const primeiro = c.chaves();
  const r2 = c.rodarScript('--autorizar', b.kid, b.impressao);
  assert.equal(r2.status, 0, r2.stderr);
  // Avisa do rótulo repetido, citando o kid do outro, para o dono revogar o antigo se for o mesmo aparelho.
  assert.match(r2.stdout + r2.stderr, new RegExp(`mesmo rótulo[\\s\\S]*${a.kid}`));
  const ambos = c.chaves();
  assert.deepEqual(Object.keys(ambos).sort(), [a.kid, b.kid].sort());
  assert.deepEqual(ambos[a.kid], primeiro[a.kid]);
  // --listar mostra kid, rótulo e impressão digital, e nada da chave pública.
  const lista = c.rodarScript('--listar');
  assert.equal(lista.status, 0, lista.stderr);
  for (const ap of [a, b]) {
    assert.match(lista.stdout, new RegExp(`${ap.kid}.*${ap.rotulo}.*${ap.impressao}`));
    assert.ok(!lista.stdout.includes(ap.publica));
  }
  c.outrosIntactos();
});

test('--revogar tira o aparelho, e --listar aponta o aparelho do formato antigo', () => {
  const c = configuracao();
  const a = novoAparelho(null, 'celular');
  const b = novoAparelho(null, 'tablet');
  c.pedidos([pedidoDe(a), pedidoDe(b)]);
  assert.equal(c.rodarScript('--autorizar', a.kid, a.impressao).status, 0);
  assert.equal(c.rodarScript('--autorizar', b.kid, b.impressao).status, 0);
  const chaveiro = new Chaveiro({ arquivo: c.chavesArq });
  assert.equal(chaveiro.aparelhos().length, 2);
  const r = c.rodarScript('--revogar', a.kid);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(c.chaves()), [b.kid]);
  assert.equal(modo(c.chavesArq), 0o600);
  // Vale sem reiniciar o coletor: o chaveiro relê o arquivo.
  assert.deepEqual(chaveiro.aparelhos().map((x) => x.kid), [b.kid]);
  // kid desconhecido ou fora do formato: erro, nada muda.
  assert.equal(c.rodarScript('--revogar', a.kid).status, 1);
  assert.equal(c.rodarScript('--revogar', '../coletor.env').status, 1);
  assert.equal(c.rodarScript('--revogar').status, 1);
  assert.deepEqual(Object.keys(c.chaves()), [b.kid]);
  // Entrada do formato antigo (chave do código do aparelho): --listar avisa que não vale mais, sem a chave.
  const json = c.chaves();
  json.ab2cd3 = { rotulo: 'velho', chave: 'f'.repeat(64), criadaEm: new Date().toISOString() };
  fs.writeFileSync(c.chavesArq, JSON.stringify(json), { mode: 0o600 });
  const lista = c.rodarScript('--listar');
  assert.equal(lista.status, 0, lista.stderr);
  assert.match(lista.stdout, /ab2cd3.*velho.*formato antigo/);
  assert.ok(!lista.stdout.includes('f'.repeat(64)));
  assert.equal(c.rodarScript('--revogar', 'ab2cd3').status, 0);
  assert.deepEqual(Object.keys(c.chaves()), [b.kid]);
  c.outrosIntactos();
});

// ---------------------------------------------------------------- rodar e main

// Painel falso: guarda cada corpo recebido e entrega os comandos da fila. Serve todos os arquivos de
// `publica` (por padrão, o public/ do repositório) e `/` como index.html; `trocados` muda o que é servido
// (null: 404), pelo nome pedido ('' é `/`).
// POST cujo corpo satisfaz `estado.segurar` fica sem resposta e o corpo vai para `segurados`.
async function painelFalso(t, token, { sempre = () => [], publica = PUBLICA, aparelhosPedidos = null } = {}) {
  const pedidos = [];
  const fila = [];
  const gets = [];
  const segurados = [];
  const trocados = new Map();
  let negados = 0;
  const estado = { segurar: null };
  const servidor = http.createServer((req, res) => {
    if (req.method === 'GET') {
      const nome = decodeURIComponent(req.url.slice(1));
      gets.push(nome);
      if (req.headers.authorization) negados++; // o token nunca vai junto
      const arq = path.join(publica, nome || 'index.html');
      const existe = arq.startsWith(publica + path.sep) && fs.existsSync(arq) && fs.statSync(arq).isFile();
      if (!trocados.has(nome) && !existe) return res.writeHead(404).end();
      const conteudo = trocados.has(nome) ? trocados.get(nome) : fs.readFileSync(arq);
      if (conteudo === null) return res.writeHead(404).end();
      if (typeof conteudo === 'function') return conteudo(res);
      return res.writeHead(200).end(conteudo);
    }
    let corpo = '';
    req.setEncoding('utf8');
    req.on('data', (p) => (corpo += p));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/ingest' || req.headers.authorization !== `Bearer ${token}`) {
        negados++;
        res.writeHead(401).end('{}');
        return;
      }
      if (estado.segurar?.(JSON.parse(corpo))) {
        segurados.push(JSON.parse(corpo));
        return;
      }
      pedidos.push(JSON.parse(corpo));
      const resposta = { comandos: [...fila.splice(0), ...sempre()], painelVistoEm: Date.now() };
      // Pedidos de pareamento de aparelho, como o ingest entrega ao coletor com protocolo 2 (tarefa 15).
      if (aparelhosPedidos) resposta.aparelhosPedidos = aparelhosPedidos();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(resposta));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  const acks = () => pedidos.flatMap((p) => p.acks || []);
  const retratos = () => pedidos.map((p) => p.retrato).filter(Boolean);
  return { url: `http://127.0.0.1:${servidor.address().port}`, pedidos, fila, gets, segurados, trocados, estado, acks, retratos, negados: () => negados };
}

// Cópia dos arquivos do painel numa pasta do caso (o public/ do repositório pode mudar durante o teste).
function copiaPublica() {
  const d = path.join(novaPasta(), 'public');
  fs.cpSync(PUBLICA, d, { recursive: true });
  return d;
}

// Conta principal vazia, um projeto e um aparelho autorizado.
function ambiente() {
  const d = novaPasta();
  const dirClaude = path.join(d, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(dirClaude, s), { recursive: true });
  const proj = path.join(d, 'projeto-x');
  fs.mkdirSync(proj);
  const projetosArq = path.join(d, 'projetos.json');
  fs.writeFileSync(projetosArq, JSON.stringify({ 'projeto-x': proj }));
  const ap = novoAparelho(null, 'celular'); // kid derivado da chave pública (Rodada 2, SE-B3 do dev B)
  const chavesArq = path.join(d, 'chaves-comandos.json');
  gravarChaves(chavesArq, [ap]);
  return { d, dirClaude, proj, projetosArq, ap, chavesArq, pastaEstado: path.join(d, 'estado'), token: crypto.randomBytes(32).toString('base64url') };
}

// Processos vivos cuja linha de comando cita o texto (o id da sessão vai em --session-id=).
const processosCom = (trecho) => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(trecho) && !l.includes('ps -eo'));

test('rodar com um servidor local falso: manda o retrato com orquestracao e trata um comando assinado até o ack final', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const logs = [];
  const coletor = await rodar({
    url: painel.url,
    token: amb.token,
    pastaEstado: amb.pastaEstado,
    chavesArq: amb.chavesArq,
    projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude],
    intervaloMs: 200,
    intervaloRapidoMs: 50,
    claudeBin: FALSO,
    ideiasTetoDia: 0,
    log: (...a) => logs.push(a.map(String).join(' ')),
  });
  let parado = false;
  t.after(async () => {
    if (!parado) await coletor.parar();
  });

  // Primeiro retrato: com a seção orquestracao.
  const primeiro = await ate(() => painel.retratos()[0], 'primeiro retrato');
  assert.deepEqual(primeiro.orquestracao, {
    ativa: true,
    motivo: null,
    projetos: ['projeto-x'],
    contas: ['principal'],
    modelos: MODELOS,
    esforcos: ESFORCOS,
    modos: MODOS,
    maxSessoes: 4,
    abertas: 0,
    aparelhos: [{ kid: amb.ap.kid, rotulo: 'celular' }],
  });
  assert.equal(painel.negados(), 0);
  // Antes do primeiro envio, o laço conferiu todos os arquivos do painel e `/` (S15, S27), sem mandar o token.
  assert.deepEqual([...painel.gets].sort(), PEDIDOS_DA_CONFERENCIA);
  // Todo corpo anuncia o protocolo novo (S22).
  assert.equal(painel.pedidos[0].protocolo, 2);

  // Um abrir assinado e um comando sem assinatura chegam juntos.
  const abrir = assinar(amb.ap.privada, {
    v: 1, kid: amb.ap.kid, id: novoId(), tipo: 'abrir', chave: null, criadoEm: Date.now(),
    dados: JSON.stringify({ projeto: 'projeto-x', pedido: SEGREDO, nome: 'sessao de teste' }),
  });
  const { assinatura, ...semAssinatura } = assinar(amb.ap.privada, { ...abrir, id: novoId() });
  painel.fila.push({ ...abrir, idadeMs: 10 }, semAssinatura);

  const feito = await ate(() => painel.acks().find((a) => a.id === abrir.id && a.estado !== 'recebido'), 'resultado do abrir');
  assert.equal(feito.estado, 'feito', JSON.stringify(feito));
  assert.equal(feito.erro, null);
  assert.match(feito.chaveNova, new RegExp(`^principal:${UUID}$`));
  const todos = painel.acks();
  const recebido = todos.findIndex((a) => a.id === abrir.id && a.estado === 'recebido');
  assert.ok(recebido >= 0 && recebido < todos.indexOf(feito), 'recebido sai antes do resultado');
  assert.deepEqual(todos.find((a) => a.id === semAssinatura.id), { id: semAssinatura.id, estado: 'recusado', erro: 'Comando sem assinatura.', motivo: 'sem_credencial' });

  // O retrato seguinte mostra a sessão comandada e a contagem de abertas.
  const comSessao = await ate(() => painel.retratos().find((r) => r.sessoes.some((s) => s.chave === feito.chaveNova && s.gerenciada === true)), 'sessão comandada no retrato');
  assert.equal(comSessao.orquestracao.abertas, 1);
  const s = comSessao.sessoes.find((x) => x.chave === feito.chaveNova);
  assert.deepEqual([s.projeto, s.nome], ['projeto-x', 'sessao de teste']);
  const sessionId = feito.chaveNova.split(':')[1];
  assert.equal(processosCom(sessionId).length, 1, 'o claude falso da sessão está vivo');

  // Auditoria local: aceito e feito do abrir (com a sessão criada, R3); recusa do sem assinatura no arquivo das recusas.
  const linhas = lerLinhas(path.join(amb.pastaEstado, 'auditoria.jsonl'));
  assert.deepEqual(linhas.filter((l) => l.id === abrir.id).map((l) => l.decisao), ['aceito', 'feito']);
  assert.equal(linhas.find((l) => l.id === abrir.id && l.decisao === 'feito').sessao, feito.chaveNova);
  const recusas = lerLinhas(path.join(amb.pastaEstado, 'auditoria-recusas.jsonl'));
  assert.deepEqual(recusas.filter((l) => l.id === semAssinatura.id).map((l) => [l.decisao, l.motivo]), [['recusado', 'sem_credencial']]);

  // parar() encerra o laço e os filhos, e só resolve depois.
  await coletor.parar();
  parado = true;
  assert.deepEqual(processosCom(sessionId), []);
  const n = painel.pedidos.length;
  await espera(300);
  assert.equal(painel.pedidos.length, n, 'o laço parou de chamar o painel');
  // Nada de texto de sessão nos logs, no que foi para o painel em acks nem na auditoria.
  const tudo = logs.join('\n') + JSON.stringify(painel.acks()) + JSON.stringify(linhas) + JSON.stringify(recusas);
  assert.ok(!tudo.includes('TEXTO-SECRETO'));
  assert.ok(painel.pedidos.every((p) => p.protocolo === 2));
  // Ao iniciar, o log diz como estão as chaves de desligar (S17).
  assert.ok(logs.some((l) => /comandos: ligados; texto: sobe/.test(l)), logs.join('\n'));
});

test('rodar com soPrefixo: o retrato só leva sessões cujo nome começa pelo prefixo', async (t) => {
  const amb = ambiente();
  // Duas sessões com atividade agora no transcript, cada uma com um título.
  const pastaProj = path.join(amb.dirClaude, 'projects', '-tmp-projeto-x');
  const ids = { 'moises-teste-a': '11111111-1111-4111-8111-111111111111', 'outra coisa': '22222222-2222-4222-8222-222222222222' };
  for (const [titulo, id] of Object.entries(ids)) {
    fs.mkdirSync(path.join(pastaProj, id), { recursive: true });
    const linha = { type: 'assistant', timestamp: new Date().toISOString(), cwd: amb.proj, requestId: `req_${id}`, message: { id: `msg_${id}`, model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 1 } } };
    fs.writeFileSync(path.join(pastaProj, `${id}.jsonl`), JSON.stringify(linha) + '\n');
    fs.writeFileSync(path.join(pastaProj, id, 'custom-title.json'), JSON.stringify({ customTitle: titulo }));
  }
  const painel = await painelFalso(t, amb.token);
  const coletor = await rodar({
    url: painel.url, token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0, soPrefixo: 'moises-teste-', log: () => {},
  });
  t.after(() => coletor.parar());
  const r = await ate(() => painel.retratos()[0], 'primeiro retrato');
  assert.deepEqual(r.sessoes.map((x) => x.nome), ['moises-teste-a']);
  // Sem prefixo, as duas aparecem (o filtro é do prefixo, não do transcript).
  const painel2 = await painelFalso(t, amb.token);
  const outro = await rodar({
    url: painel2.url, token: amb.token, pastaEstado: path.join(amb.d, 'estado2'), chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0, log: () => {},
  });
  t.after(() => outro.parar());
  const r2 = await ate(() => painel2.retratos()[0], 'primeiro retrato sem prefixo');
  assert.deepEqual(r2.sessoes.map((x) => x.nome).sort(), ['moises-teste-a', 'outra coisa']);
});

test('rodar grava em aparelhos-pedidos.json (600) só os pedidos de pareamento coerentes, sem confiar no servidor', async (t) => {
  const amb = ambiente();
  const validos = Array.from({ length: 6 }, (_, i) => novoAparelho(null, `aparelho ${i}`));
  const foraDaCurva = Buffer.from(validos[1].publica, 'base64url');
  foraDaCurva[64] ^= 1;
  const pedido = (ap, extra = {}) => ({ kid: ap.kid, publica: ap.publica, rotulo: ap.rotulo, criadoEm: Date.now(), ...extra });
  const estado = { lista: [
    pedido(validos[0]),
    pedido(validos[1], { kid: validos[2].kid }), // kid de outra chave
    pedido(validos[1], { publica: foraDaCurva.toString('base64url'), kid: crypto.createHash('sha256').update(foraDaCurva).digest('hex').slice(0, 6) }),
    pedido(validos[1], { rotulo: 'linha\nquebrada' }),
    pedido(validos[1], { rotulo: 'a'.repeat(41) }),
    pedido(validos[1], { criadoEm: 'ontem' }),
    null,
    'texto',
    pedido(validos[1], { impressao: '0000-0000-0000-0000', extra: 'x' }), // só os quatro campos ficam
    ...validos.slice(2).map((ap) => pedido(ap)), // 4 válidos a mais: passa do teto de 5
  ] };
  const painel = await painelFalso(t, amb.token, { aparelhosPedidos: () => estado.lista });
  const { logs } = await iniciarColetor(t, amb, painel);
  const arq = path.join(amb.pastaEstado, 'aparelhos-pedidos.json');
  const gravado = await ate(() => fs.existsSync(arq) && JSON.parse(fs.readFileSync(arq, 'utf8')), 'arquivo de pedidos');
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.deepEqual(gravado.map((p) => p.kid), validos.slice(0, 5).map((ap) => ap.kid));
  for (const p of gravado) assert.deepEqual(Object.keys(p).sort(), ['criadoEm', 'kid', 'publica', 'rotulo']);
  assert.equal(gravado[1].rotulo, 'aparelho 1');
  // Nada dos pedidos (chave pública, rótulo) vai para o log.
  const tudo = logs.join('\n');
  for (const ap of validos) assert.ok(!tudo.includes(ap.publica) && !tudo.includes(ap.rotulo), tudo);
  // Pedidos que somem no servidor somem do arquivo; resposta sem a lista (servidor antigo) não mexe nele.
  estado.lista = [];
  await ate(() => JSON.parse(fs.readFileSync(arq, 'utf8')).length === 0, 'arquivo de pedidos vazio');
  estado.lista = [pedido(validos[0])];
  await ate(() => JSON.parse(fs.readFileSync(arq, 'utf8')).length === 1, 'pedido de novo');
  estado.lista = undefined;
  const n = painel.pedidos.length;
  await ate(() => painel.pedidos.length >= n + 2, 'mais dois ciclos');
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).length, 1);
  // Os pedidos não autorizam nada: o chaveiro continua só com o aparelho do arquivo de chaves.
  assert.deepEqual(painel.retratos().at(-1).orquestracao.aparelhos, [{ kid: amb.ap.kid, rotulo: 'celular' }]);
});

test('rodar: um painel que devolve comandos em toda resposta não faz o laço girar sem pausa', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token, { sempre: () => [{ id: novoId(), tipo: 'encerrar', chave: SESSAO }] });
  const coletor = await rodar({
    url: painel.url, token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 1, claudeBin: FALSO, ideiasTetoDia: 0, log: () => {},
  });
  t.after(() => coletor.parar());
  await ate(() => painel.pedidos.length >= 2, 'segundo pedido');
  const n0 = painel.pedidos.length;
  await espera(1000);
  const porSegundo = painel.pedidos.length - n0;
  // Só o teto importa (o piso de 200 ms dá no máximo 5 ciclos por segundo); máquina lenta faz menos (R5).
  assert.ok(porSegundo >= 1 && porSegundo <= 6, `ciclos em 1 s: ${porSegundo}`);
  // Cada comando lixo foi recusado e confirmado, nenhum executado.
  assert.ok(painel.acks().length >= porSegundo);
  assert.ok(painel.acks().every((a) => a.estado === 'recusado' && a.motivo === 'sem_credencial'));
});

// Coletor em processo contra o painel falso; parar() fica para o fim do teste.
async function iniciarColetor(t, amb, painel, extra = {}) {
  const logs = [];
  const coletor = await rodar({
    url: painel.url, token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0,
    log: (...a) => logs.push(a.map(String).join(' ')),
    ...extra,
  });
  let parado = false;
  const parar = async () => {
    if (!parado) {
      parado = true;
      await coletor.parar();
    }
  };
  t.after(parar);
  return { parar, logs };
}

test('conferirPainelPublicado compara o SHA-256 de todos os arquivos de public/ e de / com os locais', async (t) => {
  const publica = copiaPublica();
  // Uma subpasta também entra na conferência.
  fs.mkdirSync(path.join(publica, 'img'));
  fs.writeFileSync(path.join(publica, 'img', 'icone.svg'), '<svg/>');
  const painel = await painelFalso(t, 'x', { publica });
  const conferir = () => conferirPainelPublicado({ url: painel.url, pastaPublica: publica, sinal: AbortSignal.timeout(10_000) });
  assert.deepEqual(await conferir(), { ok: true });
  // Rodada 2 (S27): todos os arquivos, em ordem, e `/` por último.
  assert.deepEqual(painel.gets, [...arquivosDe(publica), '']);
  assert.ok(painel.gets.includes('login.js') && painel.gets.includes('login.html') && painel.gets.includes('img/icone.svg'));
  assert.equal(painel.negados(), 0, 'sem token nos GET');

  // login.js, login.html ou `/` servidos diferentes desligam (S27); arquivo da subpasta que não baixa também.
  for (const nome of ['login.js', 'login.html']) {
    painel.trocados.set(nome, Buffer.from('/* trocado */'));
    assert.deepEqual(await conferir(), { ok: false, arquivo: nome, causa: 'diferente' });
    painel.trocados.clear();
  }
  painel.trocados.set('', Buffer.from('<p>outra página na raiz</p>'));
  assert.deepEqual(await conferir(), { ok: false, arquivo: '/', causa: 'diferente' });
  painel.trocados.clear();
  painel.trocados.set('img/icone.svg', null);
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'img/icone.svg', causa: 'download' });
  painel.trocados.clear();
  // Com duas divergências, a primeira na ordem é a relatada (ordem determinística).
  painel.trocados.set('style.css', Buffer.from('x'));
  painel.trocados.set('cofre.js', Buffer.from('x'));
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'cofre.js', causa: 'diferente' });
  painel.trocados.clear();

  // Um byte a mais no app.js servido.
  painel.trocados.set('app.js', Buffer.concat([fs.readFileSync(path.join(publica, 'app.js')), Buffer.from(' ')]));
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'app.js', causa: 'diferente' });
  painel.trocados.clear();
  // Arquivo que não baixa (404), redirecionamento e resposta grande demais contam como falha.
  painel.trocados.set('cofre.js', null);
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'cofre.js', causa: 'download' });
  painel.trocados.clear();
  painel.trocados.set('style.css', (res) => res.writeHead(302, { location: '/index.html' }).end());
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'style.css', causa: 'download' });
  painel.trocados.clear();
  painel.trocados.set('index.html', Buffer.alloc(6_000_000, 0x20));
  assert.deepEqual(await conferir(), { ok: false, arquivo: 'index.html', causa: 'download' });
  painel.trocados.clear();
  // Sem index.html local, `/` não tem com o que comparar: desliga. Pasta pública que não existe também.
  fs.rmSync(path.join(publica, 'index.html'));
  assert.deepEqual(await conferir(), { ok: false, arquivo: '/', causa: 'local' });
  const semPasta = await conferirPainelPublicado({ url: painel.url, pastaPublica: path.join(publica, 'nao-existe'), sinal: AbortSignal.timeout(10_000) });
  assert.deepEqual([semPasta.ok, semPasta.causa], [false, 'local']);
  // Painel fora do ar: o primeiro arquivo da ordem não baixa.
  const fechado = await conferirPainelPublicado({ url: 'http://127.0.0.1:9', pastaPublica: PUBLICA, sinal: AbortSignal.timeout(10_000) });
  assert.deepEqual([fechado.ok, fechado.arquivo, fechado.causa], [false, ARQUIVOS_PAINEL[0], 'download']);
});

test('rodar com o painel publicado diferente de public/: comandos recusados com painel_alterado até a conferência bater', async (t) => {
  const amb = ambiente();
  const publica = copiaPublica();
  const painel = await painelFalso(t, amb.token, { publica });
  painel.trocados.set('app.js', Buffer.from('/* painel trocado */'));
  const { logs } = await iniciarColetor(t, amb, painel, { pastaPublica: publica, conferirPainelMs: 300 });

  const primeiro = await ate(() => painel.retratos()[0], 'primeiro retrato');
  assert.deepEqual([primeiro.orquestracao.ativa, primeiro.orquestracao.motivo], [false, 'painel_alterado']);
  const visto = JSON.stringify({ visto: { projeto: 'p', nome: null } });
  const cmd1 = assinar(amb.ap.privada, { v: 1, kid: amb.ap.kid, id: novoId(), tipo: 'interromper', chave: SESSAO, criadoEm: Date.now(), dados: visto });
  painel.fila.push({ ...cmd1, idadeMs: 5 });
  const recusa = await ate(() => painel.acks().find((a) => a.id === cmd1.id), 'recusa do comando');
  assert.deepEqual(recusa, { id: cmd1.id, estado: 'recusado', erro: PAINEL_ALTERADO, motivo: 'painel_alterado' });
  assert.ok(logs.some((l) => /painel publicado.*app\.js/.test(l)), logs.join('\n'));
  assert.ok(!logs.join('\n').includes('painel trocado'), 'o log não cita o conteúdo servido');

  // O painel volta a ser o mesmo: na próxima conferência os comandos religam.
  painel.trocados.clear();
  await ate(() => painel.retratos().at(-1)?.orquestracao.ativa === true, 'orquestração religada');
  const cmd2 = assinar(amb.ap.privada, { v: 1, kid: amb.ap.kid, id: novoId(), tipo: 'interromper', chave: SESSAO, criadoEm: Date.now(), dados: visto });
  painel.fila.push({ ...cmd2, idadeMs: 5 });
  const recebido = await ate(() => painel.acks().find((a) => a.id === cmd2.id), 'ack do comando');
  assert.equal(recebido.estado, 'recebido');
  assert.ok(logs.some((l) => /painel publicado confere/.test(l)), logs.join('\n'));
});

test('rodar com o painel fora do ar desliga os comandos; com conferirPainel: false não confere', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  painel.trocados.set('index.html', null);
  await iniciarColetor(t, amb, painel);
  const r = await ate(() => painel.retratos()[0], 'primeiro retrato');
  assert.deepEqual([r.orquestracao.ativa, r.orquestracao.motivo], [false, 'painel_alterado']);

  const amb2 = ambiente();
  const painel2 = await painelFalso(t, amb2.token);
  painel2.trocados.set('index.html', null);
  await iniciarColetor(t, amb2, painel2, { conferirPainel: false });
  const r2 = await ate(() => painel2.retratos()[0], 'primeiro retrato sem conferência');
  assert.deepEqual([r2.orquestracao.ativa, r2.orquestracao.motivo], [true, null]);
  assert.deepEqual(painel2.gets, []);
});

test('rodar: sessão não comandada sobe sem última resposta e sem tarefa vinda do pedido', async (t) => {
  const amb = ambiente();
  const pastaProj = path.join(amb.dirClaude, 'projects', '-tmp-projeto-x');
  const agora = Date.now();
  const sessoes = { '33333333-3333-4333-8333-333333333333': 'sessao-manual', '44444444-4444-4444-8444-444444444444': null };
  for (const [id, titulo] of Object.entries(sessoes)) {
    fs.mkdirSync(path.join(pastaProj, id), { recursive: true });
    const linhas = [
      { type: 'user', timestamp: new Date(agora - 2000).toISOString(), cwd: amb.proj, message: { role: 'user', content: `PEDIDO-SECRETO-MANUAL faça a coisa ${id.slice(0, 4)}` } },
      {
        type: 'assistant', timestamp: new Date(agora - 1000).toISOString(), cwd: amb.proj, requestId: `req_${id}`,
        message: { id: `msg_${id}`, model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'RESPOSTA-SECRETA-MANUAL feito' }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    fs.writeFileSync(path.join(pastaProj, `${id}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (titulo) fs.writeFileSync(path.join(pastaProj, id, 'custom-title.json'), JSON.stringify({ customTitle: titulo }));
  }
  const painel = await painelFalso(t, amb.token);
  await iniciarColetor(t, amb, painel);
  const r = await ate(() => (painel.retratos()[0]?.sessoes.length === 2 ? painel.retratos()[0] : null), 'retrato com as duas sessões');
  const porId = Object.fromEntries(r.sessoes.map((s) => [s.sessionId, s]));
  const [comNome, semNome] = Object.keys(sessoes).map((id) => porId[id]);
  assert.deepEqual(
    [comNome.ultimaResposta, comNome.ultimaRespostaEm, comNome.tarefa, comNome.tarefaOrigem, comNome.nome],
    [null, null, 'sessao-manual', 'nome', 'sessao-manual'],
  );
  assert.deepEqual([semNome.ultimaResposta, semNome.ultimaRespostaEm, semNome.tarefa, semNome.tarefaOrigem], [null, null, null, null]);
  const tudo = JSON.stringify(painel.pedidos);
  assert.ok(!tudo.includes('PEDIDO-SECRETO'), 'o pedido de sessão aberta à mão não sai da máquina');
  assert.ok(!tudo.includes('RESPOSTA-SECRETA'), 'a resposta de sessão aberta à mão não sai da máquina');
});

test('parar() manda as confirmações que ficaram na fila, com tempo limite', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const { parar } = await iniciarColetor(t, amb, painel, { envioFinalMs: 400 });
  await ate(() => painel.retratos()[0], 'primeiro retrato');
  // Um comando lixo: o ack de recusa sai no envio seguinte, que o painel segura sem responder.
  const lixo = { id: novoId(), tipo: 'encerrar', chave: SESSAO };
  painel.estado.segurar = (c) => c.acks?.some((a) => a.id === lixo.id);
  painel.fila.push(lixo);
  await ate(() => painel.segurados.length > 0, 'envio com o ack segurado');
  painel.estado.segurar = null;
  const n = painel.pedidos.length;
  await parar();
  const finais = painel.pedidos.slice(n);
  assert.equal(finais.length, 1, 'um último envio');
  assert.equal(finais[0].retrato, null, 'só as confirmações');
  assert.equal(finais[0].protocolo, 2);
  assert.deepEqual(finais[0].acks.map((a) => [a.id, a.estado, a.motivo]), [[lixo.id, 'recusado', 'sem_credencial']]);

  // Painel que não responde: parar() desiste no tempo limite e resolve.
  const amb2 = ambiente();
  const painel2 = await painelFalso(t, amb2.token);
  const c2 = await iniciarColetor(t, amb2, painel2, { envioFinalMs: 400 });
  await ate(() => painel2.retratos()[0], 'primeiro retrato do segundo');
  const lixo2 = { id: novoId(), tipo: 'encerrar', chave: SESSAO };
  painel2.estado.segurar = (c) => c.acks?.some((a) => a.id === lixo2.id);
  painel2.fila.push(lixo2);
  await ate(() => painel2.segurados.length > 0, 'envio segurado do segundo');
  const inicio = Date.now();
  await c2.parar();
  const levou = Date.now() - inicio;
  assert.ok(levou >= 350 && levou < 3000, `parar levou ${levou} ms`);
  assert.equal(painel2.segurados.length, 2, 'tentou o último envio uma vez');
});

test('rodar recusa URL sem https ou sem token', async () => {
  const amb = ambiente();
  const base = { token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq, dirs: [amb.dirClaude], claudeBin: FALSO, ideiasTetoDia: 0, log: () => {} };
  await assert.rejects(rodar({ ...base, url: 'http://painel.example' }));
  await assert.rejects(rodar({ ...base, url: 'https://painel.example', token: '' }));
});

// Ambiente mínimo de um processo do coletor, todo apontado para a pasta do caso.
function ambienteDoProcesso(amb, extra = {}) {
  const home = path.join(amb.d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: home,
    MOISES_CONF: path.join(amb.d, 'nao-existe.env'),
    MOISES_ESTADO: amb.pastaEstado,
    MOISES_CONFIG_DIRS: amb.dirClaude,
    MOISES_LIMITES_ARQ: path.join(amb.d, 'limites.json'),
    MOISES_IDEIAS_TETO_DIA: '0',
    ...extra,
  };
}

test('importar collector/index.js não inicia nada; como ponto de entrada, sem configuração, diz o que falta', () => {
  const amb = ambiente();
  const env = ambienteDoProcesso(amb);
  const importar = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(INDEX).href)});`], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(importar.status, 0, importar.stderr);
  assert.equal(importar.stdout + importar.stderr, '');
  assert.equal(fs.existsSync(amb.pastaEstado), false, 'importar não cria a pasta de estado');

  const direto = spawnSync(process.execPath, [INDEX], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(direto.status, 1);
  assert.match(direto.stderr, /configure MOISES_URL/);

  // --uma-vez continua imprimindo o retrato sem enviar.
  const umaVez = spawnSync(process.execPath, [INDEX, '--uma-vez'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(umaVez.status, 0, umaVez.stderr);
  assert.deepEqual(JSON.parse(umaVez.stdout).sessoes, []);
});

test('main lê a configuração do ambiente, manda o retrato e sai limpo com SIGTERM', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const env = ambienteDoProcesso(amb, {
    MOISES_URL: painel.url,
    MOISES_TOKEN: amb.token,
    MOISES_CHAVES_ARQ: amb.chavesArq,
    MOISES_PROJETOS: amb.projetosArq,
    MOISES_MAX_SESSOES: '2',
    MOISES_INTERVALO_MS: '1000',
    MOISES_INTERVALO_RAPIDO_MS: '1000',
    MOISES_TETO_SESSAO_USD: 'muito', // inválido: vale o limite mais restritivo, com aviso (Rodada 2, SE-M7)
  });
  const filho = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  filho.stdout.on('data', (d) => (saida += d));
  filho.stderr.on('data', (d) => (saida += d));
  const fim = new Promise((r) => filho.on('exit', (codigo, sinal) => r({ codigo, sinal })));
  t.after(() => {
    if (filho.exitCode == null && filho.signalCode == null) filho.kill('SIGKILL');
  });
  const r = await ate(() => painel.retratos()[0], 'retrato do processo');
  assert.equal(r.orquestracao.maxSessoes, 2);
  assert.equal(r.orquestracao.ativa, true);
  assert.deepEqual(r.orquestracao.projetos, ['projeto-x']);
  assert.match(saida, /MOISES_TETO_SESSAO_USD/);
  assert.ok(!saida.includes('muito'), 'o aviso não repete o valor');
  assert.ok(!saida.includes(amb.token));
  filho.kill('SIGTERM');
  assert.deepEqual(await fim, { codigo: 0, sinal: null });
});

// Processo do coletor com um coletor.env do caso (MOISES_CONF) e o claude falso como `claude` no PATH.
function processoComConf(t, amb, linhasConf, extraEnv = {}) {
  const conf = path.join(amb.d, 'coletor.env');
  fs.writeFileSync(conf, `${linhasConf.join('\n')}\n`, { mode: 0o600 });
  const bin = path.join(amb.d, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(FALSO, path.join(bin, 'claude'));
  const env = ambienteDoProcesso(amb, { MOISES_CONF: conf, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv });
  const filho = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const saida = { texto: '' };
  filho.stdout.on('data', (d) => (saida.texto += d));
  filho.stderr.on('data', (d) => (saida.texto += d));
  const fim = new Promise((r) => filho.on('exit', (codigo, sinal) => r({ codigo, sinal })));
  t.after(() => {
    if (filho.exitCode == null && filho.signalCode == null) filho.kill('SIGKILL');
  });
  return { filho, saida, fim };
}

test('MOISES_COMANDOS=0 e MOISES_SUBIR_TEXTO=0 escritos no coletor.env valem; o ambiente do processo não os religa', async (t) => {
  // 1. Só o arquivo (com comentário e export, S28): canal desligado e texto que não sobe.
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const linhas = (p, a, desligar = ['MOISES_COMANDOS=0   # desligado de propósito', 'export MOISES_SUBIR_TEXTO=0']) => [
    `MOISES_URL=${p.url}`, `MOISES_TOKEN=${a.token}`, `MOISES_CHAVES_ARQ=${a.chavesArq}`, `MOISES_PROJETOS=${a.projetosArq}`,
    'MOISES_INTERVALO_MS=1000', 'MOISES_INTERVALO_RAPIDO_MS=1000', ...desligar,
  ];
  const p1 = processoComConf(t, amb, linhas(painel, amb));
  const r = await ate(() => painel.retratos()[0], 'retrato do processo');
  assert.deepEqual([r.orquestracao.ativa, r.orquestracao.motivo], [false, 'desligado']);
  assert.match(p1.saida.texto, /comandos: desligados \(desligado\); texto: não sobe/);
  p1.filho.kill('SIGTERM');
  assert.deepEqual(await p1.fim, { codigo: 0, sinal: null });

  // 2. Rodada 2 (S28): MOISES_COMANDOS=1 no ambiente não religa o que o coletor.env desligou.
  const amb1 = ambiente();
  const painel1 = await painelFalso(t, amb1.token);
  const p1b = processoComConf(t, amb1, linhas(painel1, amb1), { MOISES_COMANDOS: '1' });
  const r1b = await ate(() => painel1.retratos()[0], 'retrato com o ambiente tentando religar');
  assert.deepEqual([r1b.orquestracao.ativa, r1b.orquestracao.motivo], [false, 'desligado']);
  p1b.filho.kill('SIGTERM');
  assert.deepEqual(await p1b.fim, { codigo: 0, sinal: null });

  // 3. Comandos ligados; MOISES_SUBIR_TEXTO=1 no ambiente não religa o texto que o arquivo desligou
  // (pedido de permissão sem a entrada).
  const amb2 = ambiente();
  const painel2 = await painelFalso(t, amb2.token);
  const p2 = processoComConf(t, amb2, linhas(painel2, amb2, ['MOISES_SUBIR_TEXTO=desligado']), { MOISES_SUBIR_TEXTO: '1' });
  const r2 = await ate(() => painel2.retratos()[0], 'retrato do segundo processo');
  assert.deepEqual([r2.orquestracao.ativa, r2.orquestracao.motivo], [true, null]);
  assert.match(p2.saida.texto, /comandos: ligados; texto: não sobe/);
  const abrir = assinar(amb2.ap.privada, {
    v: 1, kid: amb2.ap.kid, id: novoId(), tipo: 'abrir', chave: null, criadoEm: Date.now(),
    dados: JSON.stringify({ projeto: 'projeto-x', pedido: 'permissao:echo COMANDO-SECRETO', nome: 'sem texto' }),
  });
  painel2.fila.push({ ...abrir, idadeMs: 5 });
  const feito = await ate(() => painel2.acks().find((a) => a.id === abrir.id && a.estado !== 'recebido'), 'resultado do abrir', 20_000);
  assert.equal(feito.estado, 'feito', JSON.stringify(feito));
  const comPedido = await ate(
    () => painel2.retratos().find((x) => x.sessoes.some((s) => s.chave === feito.chaveNova && s.permissoes?.length)),
    'pedido de permissão no retrato',
    20_000,
  );
  const [pedido] = comPedido.sessoes.find((s) => s.chave === feito.chaveNova).permissoes;
  assert.deepEqual([pedido.ferramenta, pedido.entrada, pedido.completo], ['Bash', '', false]);
  assert.ok(!JSON.stringify(painel2.pedidos).includes('COMANDO-SECRETO'));
  p2.filho.kill('SIGTERM');
  assert.deepEqual(await p2.fim, { codigo: 0, sinal: null });
  assert.deepEqual(processosCom(feito.chaveNova.split(':')[1]), [], 'a sessão morreu com o coletor');
});
