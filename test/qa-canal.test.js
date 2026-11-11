// QA da orquestração, canal de comandos de ponta a ponta no lado do coletor: assinatura feita pelo
// módulo do navegador (WebCrypto de verdade) conferida pelo porteiro de verdade, fronteiras do relógio,
// repetição depois de reinício e de enxurrada de lixo, e nenhum texto de sessão em log, auditoria, ack
// ou retrato. Tudo em pastas temporárias, com segredos sorteados aqui, o claude falso do projeto e um
// painel falso em 127.0.0.1: nada lê ~/.config/moises, ~/.local/state/moises, ~/.claude* nem .env*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rodar, tratarComandos } from '../collector/index.js';
import { Auditoria } from '../collector/auditoria.js';
import { Chaveiro, Porteiro, JANELA_MS, FOLGA_FUTURO_MS } from '../collector/comandos.js';
import * as col from '../collector/assinatura.js';
import * as nav from '../public/assinatura.js';
import { aparelho as novoAparelho, assinarCom, gravarChaves as gravarChavesNoFormato } from './fixtures/aparelho.js';

// O ambiente de quem roda os testes não pode desligar o canal nem esconder texto por acidente.
delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_SUBIR_TEXTO;

const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
// Só dígitos no nome: o caminho do registro vai em argsExtra, que o construtor filtra por palavras.
const BASE = path.join(os.tmpdir(), `moises-qa-canal-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const T0 = 1_794_387_000_000;

// Rodada 2 (A1): sem código do aparelho. Um aparelho do navegador (par ECDSA P-256 de public/assinatura.js,
// privada não extraível) e um do Node (para assinar fora do navegador), os dois autorizados no arquivo de chaves.
const doNavegador = await nav.gerarAparelho();
const doColetor = novoAparelho(null, 'celular');

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
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const novoId = () => `c_${crypto.randomBytes(8).toString('hex')}`;
const assinar = (privada, c) => assinarCom(privada, c);
const lerLinhas = (arq) => (fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const processosCom = (trecho) => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(trecho) && !l.includes('ps -eo'));

function gravarChaves(arquivo) {
  gravarChavesNoFormato(arquivo, [doColetor, { ...doNavegador, rotulo: 'celular' }]);
}

// Porteiro de verdade com relógio injetado e a chave derivada do mesmo código do navegador.
function porteiroComRelogio(extra = {}) {
  const d = novaPasta();
  const chavesArq = path.join(d, 'chaves-comandos.json');
  gravarChaves(chavesArq);
  const estado = path.join(d, 'estado');
  const relogio = { agora: T0 };
  const audArq = path.join(estado, 'auditoria.jsonl');
  const porteiro = new Porteiro({
    chaveiro: new Chaveiro({ arquivo: chavesArq }),
    pastaEstado: estado,
    auditoria: new Auditoria({ arquivo: audArq, agora: () => relogio.agora }),
    agora: () => relogio.agora,
    ...extra,
  });
  const comando = (campos = {}) =>
    assinar(doColetor.privada, { v: 1, kid: doColetor.kid, id: novoId(), tipo: 'mensagem', chave: SESSAO, criadoEm: relogio.agora, dados: JSON.stringify({ texto: 'oi', visto: { projeto: 'p', nome: null } }), ...campos });
  // Rodada 2 (achado S21): recusas ficam em auditoria-recusas.jsonl; as duas juntas são a trilha completa.
  const recusasArq = path.join(estado, 'auditoria-recusas.jsonl');
  const linhas = () => [...lerLinhas(audArq), ...(fs.existsSync(recusasArq) ? lerLinhas(recusasArq) : [])];
  return { d, estado, relogio, porteiro, comando, linhas };
}

const espiao = (impl = async () => ({ ok: true })) => {
  const chamadas = [];
  return { chamadas, executar: (cmd, dados) => (chamadas.push({ cmd, dados }), impl(cmd, dados)) };
};
const tratar = async (m, comandos, orq = espiao()) => {
  const acks = [];
  const execucoes = await tratarComandos({ comandos, porteiro: m.porteiro, orquestrador: orq, acks, aoTerminar: () => {}, log: () => {} });
  await Promise.all(execucoes);
  return { acks, orq };
};

// ---------------------------------------------------------------- assinatura do navegador no porteiro

test('CA2: comando assinado no navegador (WebCrypto) passa no porteiro para cada verbo, com acentos, emoji e texto longo', async () => {
  const m = porteiroComRelogio();
  const visto = { projeto: 'moisés', nome: 'sessão ção 😀' };
  const textoDificil = `Olá, ação "aspas" \\ barra \n quebra \t tab 😀 𝒳   ${'ã'.repeat(5900)} \ud800 fim`;
  const hash = await nav.hashVisto('Bash', 'ls -la');
  const casos = [
    ['abrir', null, { projeto: 'moises', pedido: textoDificil, conta: 'principal', modelo: 'opus', esforco: 'xhigh', modoPermissao: 'plan', worktree: true, nome: 'qa-1' }],
    ['mensagem', SESSAO, { texto: textoDificil, visto }],
    ['permissao', SESSAO, { pedido: 'req_1', decisao: 'aprovar', vistoHash: hash, visto }],
    ['permissao', SESSAO, { pedido: 'req_2', decisao: 'negar', visto }],
    ['interromper', SESSAO, { visto }],
    ['encerrar', SESSAO, { nome: 'Encerrada às 10h – ação 😀', visto }],
    ['retomar', SESSAO, { modoPermissao: 'acceptEdits', modelo: 'haiku', esforco: 'low', visto }],
  ];
  for (const [tipo, chave, dados] of casos) {
    const cmd = await nav.assinarComando(doNavegador, { tipo, chave, dados }, T0);
    const r = m.porteiro.conferir(cmd);
    assert.equal(r.ok, true, `${tipo}: ${r.motivo}`);
    assert.deepEqual(JSON.parse(JSON.stringify(r.dados)), JSON.parse(JSON.stringify(dados)), `${tipo}: os dados que o porteiro entrega são os que o navegador assinou`);
    assert.equal(r.quem, `${doNavegador.kid} (celular)`);
  }
});

test('CA2: assinatura do navegador não vale para outro código, nem com um byte de dados trocado', async () => {
  const m = porteiroComRelogio();
  const outro = await nav.gerarAparelho();
  const dados = { texto: 'oi', visto: { projeto: 'p', nome: null } };
  const deOutroCodigo = await nav.assinarComando({ kid: doNavegador.kid, chave: outro.chave }, { tipo: 'mensagem', chave: SESSAO, dados }, T0);
  assert.equal(motivo(m.porteiro.conferir(deOutroCodigo)), 'assinatura');
  const bom = await nav.assinarComando(doNavegador, { tipo: 'mensagem', chave: SESSAO, dados }, T0);
  const adulterado = { ...bom, id: novoId(), dados: bom.dados.replace('oi', 'ói') };
  assert.equal(motivo(m.porteiro.conferir(adulterado)), 'assinatura');
  assert.equal(motivo(m.porteiro.conferir(bom)), 'aceito');
});

const motivo = (r) => (r.ok ? 'aceito' : r.motivo);

// ---------------------------------------------------------------- relógio

test('CA2: fronteiras da validade: 119,999 s aceita, 120 s expira, +30 s aceita, +30,001 s é relógio', () => {
  const m = porteiroComRelogio();
  assert.equal(JANELA_MS, 120_000);
  assert.equal(FOLGA_FUTURO_MS, 30_000);
  assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: T0 - 119_999 }))), 'aceito');
  assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: T0 - 120_000 }))), 'expirado');
  assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: T0 + 30_000 }))), 'aceito');
  const adiantado = m.porteiro.conferir(m.comando({ criadoEm: T0 + 30_001 }));
  assert.equal(adiantado.ok, false);
  assert.equal(adiantado.motivo, 'relogio');
  assert.match(adiantado.erro, /relógio/);
  assert.match(adiantado.erro, /acerte/i);
});

test('relógio adiantado: o comando recusado por isso não pode ser reenviado quando passar a caber na folga', () => {
  const m = porteiroComRelogio();
  const cmd = m.comando({ criadoEm: T0 + 40_000 });
  assert.equal(motivo(m.porteiro.conferir(cmd)), 'relogio');
  m.relogio.agora = T0 + 20_000; // agora ele cabe na folga de 30 s
  assert.equal(motivo(m.porteiro.conferir(cmd)), 'repetido');
});

test('relógio do celular ATRASADO: a recusa manda acertar o relógio, em vez de culpar a demora na entrega', async () => {
  const m = porteiroComRelogio();
  // O servidor diz que o comando chegou há 2 s (idadeMs), mas o celular o datou 5 minutos no passado.
  const atrasado = { ...m.comando({ criadoEm: T0 - 5 * 60_000 }), idadeMs: 2_000 };
  const { acks, orq } = await tratar(m, [atrasado]);
  assert.equal(orq.chamadas.length, 0, 'não executa');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].estado, 'recusado');
  const fala = `${acks[0].erro} ${acks[0].motivo}`;
  assert.match(fala, /rel[óo]gio/i, `a recusa precisa mencionar o relógio do aparelho; veio: ${fala}`);
});

// ---------------------------------------------------------------- recusas de ponta a ponta

test('CA2: toda recusa gera ack recusado com motivo e nenhuma chega ao orquestrador', async () => {
  const m = porteiroComRelogio();
  const intruso = novoAparelho().privada;
  const dadosOk = JSON.stringify({ texto: 'oi', visto: { projeto: 'p', nome: null } });
  const base = { v: 1, kid: doColetor.kid, id: null, tipo: 'mensagem', chave: SESSAO, criadoEm: T0, dados: dadosOk };
  const novo = (campos, chave = doColetor.privada) => assinar(chave, { ...base, id: novoId(), ...campos });
  const { assinatura, ...semAssinatura } = novo({});
  const repetido = novo({});
  const comandos = [
    [semAssinatura, 'sem_credencial'],
    [novo({}, intruso), 'assinatura'],
    // Rodada de correção 2 (SE-B3): o kid tem de ser hexadecimal (senão é `formato`); este não é de ninguém.
    [novo({ kid: ['abcdef', 'fedcba', '012345'].find((k) => k !== doColetor.kid && k !== doNavegador.kid) }), 'aparelho'],
    [novo({ criadoEm: T0 - JANELA_MS }), 'expirado'],
    [novo({ criadoEm: T0 + FOLGA_FUTURO_MS + 1 }), 'relogio'],
    [novo({ tipo: 'apagar' }), 'verbo'],
    [novo({ v: 2 }), 'formato'],
    [novo({ dados: '[]' }), 'formato'],
    [novo({ dados: JSON.stringify({ texto: 'oi' }) }), 'formato'],
    [repetido, 'aceito'],
    [repetido, 'repetido'],
  ];
  const orq = espiao();
  const { acks } = await tratar(m, comandos.map(([c]) => c), orq);
  const finais = new Map();
  for (const a of acks) finais.set(a.id, a);
  // O único aceito é o primeiro `repetido`; o resto nem chegou ao orquestrador.
  assert.equal(orq.chamadas.length, 1);
  assert.equal(orq.chamadas[0].cmd.id, repetido.id);
  const recusas = acks.filter((a) => a.estado === 'recusado');
  assert.deepEqual(recusas.map((a) => a.motivo), comandos.filter(([, mot]) => mot !== 'aceito').map(([, mot]) => mot));
  for (const a of recusas) {
    assert.equal(typeof a.erro, 'string');
    assert.ok(a.erro.length > 0);
    assert.match(a.motivo, /^[a-z_]{1,20}$/);
  }
  // Cada decisão deixou uma linha na auditoria, sem o texto dos dados.
  assert.equal(m.linhas().filter((l) => l.decisao === 'recusado').length, recusas.length);
});

test('o mesmo comando duas vezes no mesmo lote executa uma vez só', async () => {
  const m = porteiroComRelogio();
  const cmd = m.comando();
  const { acks, orq } = await tratar(m, [cmd, { ...cmd }]);
  assert.equal(orq.chamadas.length, 1);
  assert.deepEqual(acks.map((a) => [a.estado, a.motivo ?? null]), [['recebido', null], ['recusado', 'repetido'], ['feito', null]]);
});

// ---------------------------------------------------------------- laço com painel falso

// Painel falso: guarda cada corpo recebido e entrega os comandos da fila.
async function painelFalso(t, token) {
  const pedidos = [];
  const fila = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.setEncoding('utf8');
    req.on('data', (p) => (corpo += p));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/ingest' || req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end('{}');
      pedidos.push(JSON.parse(corpo));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ comandos: fila.splice(0, 20), painelVistoEm: Date.now() })); // Rodada 2 (R1): como o servidor, no máximo 20 por resposta; o coletor trata no máximo 20
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  return {
    url: `http://127.0.0.1:${servidor.address().port}`,
    pedidos,
    fila,
    acks: () => pedidos.flatMap((p) => p.acks || []),
    retratos: () => pedidos.map((p) => p.retrato).filter(Boolean),
  };
}

function ambiente() {
  const d = novaPasta();
  const dirClaude = path.join(d, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(dirClaude, s), { recursive: true });
  const proj = path.join(d, 'projeto-x');
  fs.mkdirSync(proj);
  const projetosArq = path.join(d, 'projetos.json');
  fs.writeFileSync(projetosArq, JSON.stringify({ 'projeto-x': proj }));
  const chavesArq = path.join(d, 'chaves-comandos.json');
  gravarChaves(chavesArq);
  return { d, dirClaude, projetosArq, chavesArq, registro: path.join(d, 'registro.json'), pastaEstado: path.join(d, 'estado'), token: crypto.randomBytes(32).toString('base64url') };
}

async function iniciar(t, amb, painel, extra = {}) {
  const logs = [];
  const coletor = await rodar({
    url: painel.url, token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0,
    argsExtra: [`--system-prompt=registro:${amb.registro}`],
    conferirPainel: false, // Rodada 2 (S15): o painel falso não serve os arquivos de public/; a conferência tem testes próprios em laco.test.js
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

// Manda um comando assinado pela chave do coletor (mesma derivação do navegador) e espera o ack final.
function remetente(painel) {
  return async (tipo, chave, dados, campos = {}) => {
    const cmd = assinar(doColetor.privada, { v: 1, kid: doColetor.kid, id: novoId(), tipo, chave, criadoEm: Date.now(), dados: JSON.stringify(dados), ...campos });
    painel.fila.push({ ...cmd, idadeMs: 5 });
    const final = await ate(() => painel.acks().find((a) => a.id === cmd.id && a.estado !== 'recebido'), `resultado de ${tipo}`);
    return { cmd, final };
  };
}

const entradasDoFilho = (amb) => (fs.existsSync(`${amb.registro}.entrada`) ? fs.readFileSync(`${amb.registro}.entrada`, 'utf8') : '');

test('foco 1: comando válido repetido por quem controla o Redis, depois de enxurrada de lixo e de reinício, executa uma vez só', async (t) => {
  const amb = ambiente();
  const PEDIDO = 'PEDIDO-UNICO-DO-QA';
  const painel1 = await painelFalso(t, amb.token);
  const c1 = await iniciar(t, amb, painel1);
  const enviar = remetente(painel1);
  const { cmd, final } = await enviar('abrir', null, { projeto: 'projeto-x', pedido: PEDIDO, nome: 'qa-repeticao' });
  assert.equal(final.estado, 'feito', JSON.stringify(final));
  assert.equal(entradasDoFilho(amb).split(PEDIDO).length - 1, 1);

  // Enxurrada: 300 comandos com formato de verdade e assinatura qualquer (Rodada 2 (A1): 64 bytes, como a ECDSA).
  for (let i = 0; i < 300; i++) {
    painel1.fila.push({ v: 1, kid: doColetor.kid, id: novoId(), tipo: 'mensagem', chave: SESSAO, criadoEm: Date.now(), dados: '{}', assinatura: crypto.randomBytes(64).toString('base64url'), idadeMs: 1 });
  }
  await ate(() => painel1.acks().filter((a) => a.estado === 'recusado' && a.motivo === 'assinatura').length >= 300, '300 recusas por assinatura', 20_000);
  // O mesmo comando, de novo, na mesma janela de validade.
  painel1.fila.push({ ...cmd, idadeMs: 9 });
  const rep1 = await ate(() => painel1.acks().find((a) => a.id === cmd.id && a.estado === 'recusado'), 'repetição recusada');
  assert.equal(rep1.motivo, 'repetido');
  await c1.parar();
  // Rodada de correção 2 (R7/Q3): procura pelo caminho do registro, que é único desta execução (vai no
  // argv do filho), e não pelo nome da sessão, que outra execução do mesmo teste também usa.
  assert.deepEqual(processosCom(amb.registro), [], 'nenhum filho ficou vivo');

  // Reinício do coletor: novo `rodar` com a mesma pasta de estado, e o painel (Redis) devolve o mesmo comando.
  const painel2 = await painelFalso(t, amb.token);
  const c2 = await iniciar(t, amb, painel2);
  painel2.fila.push({ ...cmd, idadeMs: 20 });
  const rep2 = await ate(() => painel2.acks().find((a) => a.id === cmd.id), 'repetição depois do reinício');
  assert.equal(rep2.estado, 'recusado');
  assert.equal(rep2.motivo, 'repetido');
  await espera(300);
  assert.equal(entradasDoFilho(amb).split(PEDIDO).length - 1, 1, 'o pedido chegou ao filho uma única vez');
  assert.equal(painel2.acks().filter((a) => a.id === cmd.id && a.estado === 'feito').length, 0);
  await c2.parar();
  const aud = lerLinhas(path.join(amb.pastaEstado, 'auditoria.jsonl'));
  assert.equal(aud.filter((l) => l.id === cmd.id && l.decisao === 'aceito').length, 1);
});

test('nenhum texto de sessão (pedido, mensagem, resposta de erro) vai para log, auditoria, ack ou retrato; o pedido de permissão só aparece no retrato', async (t) => {
  const amb = ambiente();
  const SEG_PEDIDO = 'SEGREDO-DO-PEDIDO-INICIAL';
  const SEG_MSG = 'SEGREDO-DA-MENSAGEM-DEPOIS';
  const SEG_CMD = 'SEGREDO-DO-COMANDO-BASH';
  const painel = await painelFalso(t, amb.token);
  const { parar, logs } = await iniciar(t, amb, painel);
  const enviar = remetente(painel);
  const sessaoNoRetrato = (chave) => painel.retratos().at(-1)?.sessoes.find((s) => s.chave === chave);

  const aberto = await enviar('abrir', null, { projeto: 'projeto-x', pedido: SEG_PEDIDO, nome: 'qa-vazamento' });
  assert.equal(aberto.final.estado, 'feito', JSON.stringify(aberto.final));
  const chave = aberto.final.chaveNova;
  assert.match(chave, new RegExp(`^principal:${UUID}$`));
  const visto = { projeto: 'projeto-x', nome: 'qa-vazamento' };

  assert.equal((await enviar('mensagem', chave, { texto: SEG_MSG, visto })).final.estado, 'feito');
  assert.equal((await enviar('mensagem', chave, { texto: `permissao:echo ${SEG_CMD}`, visto })).final.estado, 'feito');
  const pedido = await ate(() => sessaoNoRetrato(chave)?.permissoes?.[0], 'pedido de permissão no retrato');
  assert.equal(pedido.entrada, `echo ${SEG_CMD}`);
  assert.equal(pedido.completo, true);
  const aprovado = await enviar('permissao', chave, { pedido: pedido.pedido, decisao: 'aprovar', vistoHash: col.hashVisto(pedido.ferramenta, pedido.entrada), visto });
  assert.equal(aprovado.final.estado, 'feito', JSON.stringify(aprovado.final));
  await ate(() => sessaoNoRetrato(chave)?.estado === 'esperando_mensagem' && sessaoNoRetrato(chave).permissoes.length === 0, 'sessão volta a esperar mensagem');

  // O filho morre com um segredo no stderr: o erro publicado passa por redigir.
  assert.equal((await enviar('mensagem', chave, { texto: 'morre', visto })).final.estado, 'feito');
  await ate(() => sessaoNoRetrato(chave)?.erro, 'erro da sessão que morreu no retrato');
  await parar();

  const recusasArq = path.join(amb.pastaEstado, 'auditoria-recusas.jsonl');
  const auditoria = fs.readFileSync(path.join(amb.pastaEstado, 'auditoria.jsonl'), 'utf8') + (fs.existsSync(recusasArq) ? fs.readFileSync(recusasArq, 'utf8') : '');
  const acks = JSON.stringify(painel.acks());
  const retratos = painel.retratos().map((r) => ({ ...r, sessoes: r.sessoes.map((s) => ({ ...s, permissoes: [] })) }));
  for (const [onde, texto] of [['logs', logs.join('\n')], ['auditoria', auditoria], ['acks', acks], ['retrato', JSON.stringify(retratos)]]) {
    for (const segredo of [SEG_PEDIDO, SEG_MSG, SEG_CMD, 'sk-ant-BBBB']) assert.ok(!texto.includes(segredo), `${onde} vazou ${segredo}`);
  }
  assert.match(JSON.stringify(painel.retratos().at(-1).sessoes.find((s) => s.chave === chave).erro), /código 3/);
});

test('CA3: todo arquivo que o coletor grava na pasta de estado (auditoria, vistos, contador de aberturas) tem permissão 600', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const c = await iniciar(t, amb, painel);
  const enviar = remetente(painel);
  const { final } = await enviar('abrir', null, { projeto: 'projeto-x', pedido: 'olá', nome: 'qa-modos' });
  assert.equal(final.estado, 'feito', JSON.stringify(final));
  // Uma recusa também deixa linha na auditoria (Rodada 2 (A1): assinatura de 64 bytes, como a ECDSA).
  painel.fila.push({ v: 1, kid: doColetor.kid, id: novoId(), tipo: 'mensagem', chave: SESSAO, criadoEm: Date.now(), dados: '{}', assinatura: crypto.randomBytes(64).toString('base64url'), idadeMs: 1 });
  await ate(() => painel.acks().some((a) => a.estado === 'recusado'), 'recusa');
  await c.parar();
  const arquivos = fs.readdirSync(amb.pastaEstado).filter((n) => !n.startsWith('ideias'));
  for (const nome of ['auditoria.jsonl', 'comandos-vistos.json', 'abrir.json']) assert.ok(arquivos.includes(nome), `${nome} existe`);
  for (const nome of arquivos) {
    const modo = fs.statSync(path.join(amb.pastaEstado, nome)).mode & 0o777;
    assert.equal(modo & 0o077, 0, `${nome} está com permissão ${modo.toString(8)}; só o dono pode ler`);
  }
  assert.equal(fs.statSync(path.join(amb.pastaEstado, 'auditoria.jsonl')).mode & 0o777, 0o600);
  assert.equal(arquivos.filter((n) => n.endsWith('.tmp')).length, 0, 'nenhum temporário ficou para trás');
});

test('CA3: a pasta de estado criada pelo coletor (vistos, auditoria, contador) é só do dono, mesmo com umask frouxa', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb.token);
  const umaskAntes = process.umask(0o002); // como em muitas distribuições: grupo com escrita
  try {
    const c = await iniciar(t, amb, painel);
    await ate(() => painel.retratos()[0], 'primeiro retrato');
    await c.parar();
  } finally {
    process.umask(umaskAntes);
  }
  const modo = fs.statSync(amb.pastaEstado).mode & 0o777;
  assert.equal(modo & 0o077, 0, `a pasta de estado ficou com permissão ${modo.toString(8)}; quem apaga comandos-vistos.json desarma a proteção contra repetição`);
});
