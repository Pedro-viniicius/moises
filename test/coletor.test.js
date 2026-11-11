import { test, after } from 'node:test';
process.env.MOISES_LIMITES_ARQ = path.join(os.tmpdir(), `moises-limites-${process.pid}.json`);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { custo } from '../collector/precos.js';
import { novoEstado, lerNovidades, somar, diaLocal } from '../collector/transcript.js';
import { Coletor, statusDe, estadoDe, inicioDoProcesso, fatorOficial } from '../collector/sessoes.js';
import { redigir, redigirBloco } from '../collector/redigir.js';
import { executarEncerrar, reiniciarLimites, nomePadrao, ehClaude, logDeEncerramento } from '../collector/encerrar.js';
import { urlAceita } from '../collector/index.js';
import { recomendar, lerResposta, Ideias } from '../collector/ideias.js';

const criadas = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'moises-'));
  criadas.push(d);
  return d;
};
after(() => {
  for (const d of criadas) fs.rmSync(d, { recursive: true, force: true });
});
const linha = (o) => JSON.stringify(o) + '\n';
const agoraIso = (ms = Date.now()) => new Date(ms).toISOString();

function resposta({ id = 'msg_1', req = 'req_1', model = 'claude-opus-5-5', ts = agoraIso(), usage, sidechain = false, effort = 'high' }) {
  return linha({
    type: 'assistant',
    isSidechain: sidechain,
    effort,
    requestId: req,
    timestamp: ts,
    cwd: '/home/x/Documentos/projeto-a',
    message: { id, model, usage: usage || { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

test('preço reproduz o cost-state real do Claude Code (Fable 5.2 e Opus 5.5)', () => {
  const fable = custo('claude-fable-5-2', {
    input_tokens: 284,
    output_tokens: 110303,
    cache_read_input_tokens: 20227305,
    cache_creation_input_tokens: 333347,
    cache_creation: { ephemeral_1h_input_tokens: 333347, ephemeral_5m_input_tokens: 0 },
  });
  assert.ok(Math.abs(fable - 13.793405) < 0.001, `fable ${fable}`);
  const opus = custo('claude-opus-5-5', {
    input_tokens: 2791,
    output_tokens: 126882,
    cache_read_input_tokens: 30034861,
    cache_creation_input_tokens: 1247224,
    cache_creation: { ephemeral_1h_input_tokens: 668747, ephemeral_5m_input_tokens: 578477 },
  });
  assert.ok(Math.abs(opus - 16.7981372) < 0.001, `opus ${opus}`);
  assert.equal(custo('modelo-inexistente', { input_tokens: 10 }), null);
  assert.equal(custo('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
});

test('transcript: a mesma resposta repetida conta uma vez; linha incompleta espera o resto', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  const r1 = resposta({});
  fs.writeFileSync(f, r1 + r1 + r1 + resposta({ id: 'msg_2', req: 'req_2', model: 'claude-sonnet-5-5', effort: 'medium' }));
  const est = novoEstado();
  lerNovidades(f, est);
  assert.equal(est.respostas.size, 2);
  // opus: 1000*4 + 1000*20 = 0.024; sonnet: 1000*2 + 1000*10 = 0.012
  assert.ok(Math.abs(somar([est]).custo - 0.036) < 1e-9);
  assert.equal(est.modelo, 'claude-sonnet-5-5');
  assert.equal(est.esforco, 'medium');
  const meia = linha({ type: 'ai-title', aiTitle: 'Título novo' });
  fs.appendFileSync(f, meia.slice(0, 10));
  lerNovidades(f, est);
  assert.equal(est.tituloIA, null);
  fs.appendFileSync(f, meia.slice(10));
  lerNovidades(f, est);
  assert.equal(est.tituloIA, 'Título novo');
  fs.appendFileSync(f, '{quebrado\n');
  lerNovidades(f, est);
  assert.equal(est.linhasRuins, 1);
});

test('transcript: custo separado por dia no fuso de Brasília', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, resposta({ ts: '2026-11-10T02:30:00Z' }) + resposta({ id: 'b', req: 'b', ts: '2026-11-10T03:30:00Z' }));
  const est = novoEstado();
  lerNovidades(f, est);
  assert.ok(Math.abs(somar([est], '2026-11-09').custo - 0.024) < 1e-9); // 23h30 do dia 9 em Brasília
  assert.ok(Math.abs(somar([est], '2026-11-10').custo - 0.024) < 1e-9);
});

test('status a partir do registro da sessão', () => {
  const agora = 10_000_000;
  assert.equal(statusDe({ status: 'busy' }, true, agora), 'ativa');
  assert.equal(statusDe({ status: 'idle', statusUpdatedAt: agora - 60_000 }, true, agora), 'aguardando');
  assert.equal(statusDe({ status: 'idle', statusUpdatedAt: agora - 20 * 60_000 }, true, agora), 'ociosa');
  assert.equal(statusDe({ status: 'busy' }, false, agora), 'encerrada');
});

test('redigir esconde segredos, e-mails e telefones e corta o tamanho', () => {
  const s = redigir(
    'chave sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA token gho_abcdefghijklmnopqrstuvwxyz123456 mail a.b@x.com tel (35) 99999-8888 senha=hunter2 ' +
      'postgres://admin:s3gr3d0@localhost:5432/app client_secret=cs123 access_token=at456 AIzaSyA1234567890abcdefghijklmnopqrstuv ' +
      'CPF 123.456.789-09 CNPJ 12.345.678/0001-90 a senha é hunter3xyz Authorization: Bearer abc.def sk_live_abcdefghij1234',
    2000,
  );
  for (const vazado of ['sk-ant', 'gho_', 'a.b@x.com', '99999', 'hunter2', 's3gr3d0', 'cs123', 'at456', 'AIza', '789-09', '0001-90', 'hunter3', 'abc.def', 'sk_live'])
    assert.ok(!s.includes(vazado), `${vazado} em ${s}`);
  assert.equal(redigir('Implementar login com senha forte no painel'), 'Implementar login com senha forte no painel');
  assert.equal(redigir('palavra '.repeat(100), 50).length, 50);
  assert.equal(redigir(null), null);
});

test('fator oficial só vale quando o cost-state cobre a sessão inteira', () => {
  assert.equal(fatorOficial({ custoOficial: { total: 11, inicio: 1000 }, primeiraAtividade: 2000 }, 10), 1.1);
  assert.equal(fatorOficial({ custoOficial: { total: 11, inicio: 1000 }, primeiraAtividade: 2000 }, 12), 1);
  assert.equal(fatorOficial({ custoOficial: { total: 50, inicio: 1000 }, primeiraAtividade: 2000 }, 10), 1);
  assert.equal(fatorOficial({ custoOficial: { total: 11, inicio: 10 * 60_000 }, primeiraAtividade: 0 }, 10), 1);
});

function montarConta(raiz, nome, { sessionId, pid, procStart, status = 'busy', linhas, subagente, name = 'minha-sessao' }) {
  const dir = path.join(raiz, nome);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const proj = path.join(dir, 'projects', '-home-x-Documentos-projeto-a');
  fs.mkdirSync(proj, { recursive: true });
  if (pid) {
    fs.writeFileSync(
      path.join(dir, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd: '/home/x/Documentos/projeto-a', startedAt: Date.now() - 3600_000, procStart, kind: 'interactive', name, status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }),
    );
  }
  fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), linhas);
  if (subagente) {
    fs.mkdirSync(path.join(proj, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, sessionId, 'subagents', 'agent-1.jsonl'), subagente);
  }
  return dir;
}

test('retrato: sessão viva, sessão encerrada hoje, subagentes e total do dia', () => {
  const raiz = tmp();
  const viva = montarConta(raiz, '.claude', {
    sessionId: 'aaaa',
    pid: process.pid,
    procStart: inicioDoProcesso(process.pid),
    linhas: resposta({}) + linha({ type: 'ai-title', aiTitle: 'Implementar login' }) + linha({ type: 'system', subtype: 'away_summary', content: 'Fez o login; token sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA' }),
    subagente: resposta({ id: 'sub', req: 'sub', model: 'claude-sonnet-5-5', sidechain: true }),
  });
  const morta = montarConta(raiz, '.claude-conta2', {
    sessionId: 'bbbb',
    pid: 999999,
    procStart: '1',
    linhas: resposta({ id: 'haiku', req: 'haiku', model: 'claude-haiku-5-5' }),
  });
  const c = new Coletor({ dirs: [viva, morta] });
  const r = c.retrato();
  assert.equal(r.sessoes.length, 2);
  const [a, b] = r.sessoes;
  assert.equal(a.chave, 'principal:aaaa');
  assert.equal(a.status, 'ativa');
  assert.equal(a.projeto, 'projeto-a');
  assert.equal(a.tarefa, 'Implementar login');
  assert.ok(!a.resumo.includes('sk-ant'));
  assert.equal(a.modelo, 'claude-opus-5-5'); // subagente não muda o modelo da sessão
  assert.ok(Math.abs(a.custo - 0.036) < 1e-6); // inclui o subagente
  assert.equal(b.chave, 'conta2:bbbb');
  assert.equal(b.status, 'encerrada');
  assert.ok(Math.abs(r.totalDia - (0.036 + 0.0006)) < 1e-6);
  assert.equal(r.dia, diaLocal(Date.now()));
});

test('encerrar: só o processo indicado, conferindo pid, início e nome; grava o log', async (t) => {
  const raiz = tmp();
  const bin = path.join(raiz, 'claude');
  fs.symlinkSync(process.execPath, bin); // o nome do processo vira "claude"
  const filho = spawn(bin, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  const dir = montarConta(raiz, '.claude', {
    sessionId: 'cccc',
    pid: filho.pid,
    procStart: inicioDoProcesso(filho.pid),
    linhas: resposta({}) + linha({ type: 'ai-title', aiTitle: 'Revisar textos' }),
  });
  const c = new Coletor({ dirs: [dir] });
  c.retrato();

  assert.match((await executarEncerrar(c, { id: 'a1', chave: 'principal:cccc', idadeMs: 130_000 })).erro, /antigo/);
  assert.match((await executarEncerrar(c, { id: 'a2', chave: 'principal:zzzz', idadeMs: 1000 })).erro, /não está registrada/);

  // pid certo, mas início diferente (pid reaproveitado): recusa
  const regArq = path.join(dir, 'sessions', `${filho.pid}.json`);
  const reg = JSON.parse(fs.readFileSync(regArq, 'utf8'));
  fs.writeFileSync(regArq, JSON.stringify({ ...reg, procStart: '1' }));
  assert.match((await executarEncerrar(c, { id: 'a3', chave: 'principal:cccc', idadeMs: 1000 })).erro, /já terminou/);
  fs.writeFileSync(regArq, JSON.stringify({ ...reg, procStart: undefined }));
  assert.match((await executarEncerrar(c, { id: 'a4', chave: 'principal:cccc', idadeMs: 1000 })).erro, /sem início do processo/);
  fs.writeFileSync(regArq, JSON.stringify(reg));

  const sinais = [];
  const r = await executarEncerrar(c, { id: 'a5', chave: 'principal:cccc', idadeMs: 1000, nome: null }, { kill: (pid, s) => (sinais.push([pid, s]), process.kill(pid, s)) });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(sinais, [[filho.pid, 'SIGTERM']]);
  assert.equal(r.log.nome, `${diaLocal(Date.now())} projeto-a – Revisar textos`);
  assert.equal(r.log.modelo, 'claude-opus-5-5');
  assert.ok(r.log.custo > 0 && r.log.duracaoMs > 0);
  assert.match((await executarEncerrar(c, { id: 'a5', chave: 'principal:cccc', idadeMs: 1000 })).erro, /repetido/);
});

test('encerrar recusa processo que não é do Claude Code', async (t) => {
  const raiz = tmp();
  const filho = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  const dir = montarConta(raiz, '.claude', { sessionId: 'dddd', pid: filho.pid, procStart: inicioDoProcesso(filho.pid), linhas: resposta({}) });
  const c = new Coletor({ dirs: [dir] });
  let chamou = false;
  const r = await executarEncerrar(c, { id: 'b1', chave: 'principal:dddd', idadeMs: 0 }, { kill: () => (chamou = true) });
  assert.match(r.erro, /não é do Claude Code/);
  assert.equal(chamou, false);
});

test('encerrar usa o arquivo de limites definido depois da importação', async (t) => {
  const anterior = process.env.MOISES_LIMITES_ARQ;
  const arq = path.join(tmp(), 'limites.json');
  process.env.MOISES_LIMITES_ARQ = arq;
  reiniciarLimites();
  t.after(() => {
    process.env.MOISES_LIMITES_ARQ = anterior;
    reiniciarLimites();
  });
  const r = await executarEncerrar({}, { id: 'limites-novo-1', chave: null, idadeMs: 0 });
  assert.match(r.erro, /sem sessão válida/);
  assert.ok(fs.existsSync(arq), 'o arquivo de limites da variável de ambiente deveria ter sido gravado');
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')).executados, ['limites-novo-1']);
});

test('nome padrão do log', () => {
  assert.equal(nomePadrao({ projeto: 'p', tarefa: 'x'.repeat(80) }, Date.parse('2026-11-10T15:00:00Z')), `2026-11-10 p – ${'x'.repeat(60)}`);
});

test('recomendação de modelo e esforço', () => {
  assert.equal(recomendar('claude-opus-5-5', 'high', 'mecanica').modelo, 'claude-sonnet-5-5');
  assert.equal(recomendar('claude-sonnet-5-5', 'high', 'mecanica').esforco, 'medium');
  assert.equal(recomendar('claude-sonnet-5-5', 'medium', 'mecanica').adequado, true);
  assert.equal(recomendar('claude-fable-5-2', 'high', 'moderada').modelo, 'claude-opus-5-5');
  assert.equal(recomendar('claude-haiku-5-5', 'high', 'complexa').modelo, 'claude-opus-5-5');
  assert.equal(recomendar('claude-opus-5-5', 'low', 'complexa').esforco, 'high');
  assert.equal(recomendar('claude-opus-5-5', 'high', 'complexa').adequado, true);
  assert.equal(recomendar(null, 'high', 'complexa'), null);
});

test('resposta do Haiku: aceita JSON válido, rejeita o resto', () => {
  assert.deepEqual(lerResposta('```json\n{"complexidade":"moderada","ideias":["a","b","c","d"],"motivo":"m"}\n```'), { complexidade: 'moderada', ideias: ['a', 'b', 'c'], motivo: 'm' });
  assert.equal(lerResposta('{"complexidade":"outra","ideias":["a","b"]}'), null);
  assert.equal(lerResposta('{"complexidade":"moderada","ideias":["a"]}'), null);
  assert.equal(lerResposta('sem json'), null);
});

test('ideias: gera uma vez por mudança relevante e respeita o intervalo', async () => {
  let agora = 1_000_000_000;
  let chamadas = 0;
  const id = new Ideias({
    pastaEstado: tmp(),
    agora: () => agora,
    chamar: async () => (chamadas++, { texto: '{"complexidade":"mecanica","ideias":["a","b"],"motivo":"m"}', custo: 0.0002 }),
  });
  const ret = () => ({ sessoes: [{ chave: 'k', status: 'ativa', projeto: 'p', tarefa: 't1', modelo: 'claude-opus-5-5', esforco: 'high' }] });
  id.aplicar(ret());
  await new Promise((r) => setImmediate(r));
  assert.equal(chamadas, 1);
  const r2 = id.aplicar(ret());
  assert.equal(chamadas, 1); // nada mudou
  assert.equal(r2.sessoes[0].sugestao.recomendacao.modelo, 'claude-sonnet-5-5');
  assert.equal(r2.custoIdeiasHoje, 0.0002);
  const mudou = ret();
  mudou.sessoes[0].tarefa = 't2';
  id.aplicar(mudou);
  assert.equal(chamadas, 1); // mudou, mas dentro do intervalo de 10 min
  agora += 11 * 60_000;
  id.aplicar(mudou);
  await new Promise((r) => setImmediate(r));
  assert.equal(chamadas, 2);
  const enc = ret();
  enc.sessoes[0].status = 'encerrada';
  enc.sessoes[0].chave = 'outra';
  id.aplicar(enc);
  assert.equal(chamadas, 2); // sessão encerrada não gera ideias
});

test('ideias: falha tenta de novo depois do intervalo, sem a sessão precisar mudar', async () => {
  let agora = 1_000_000_000;
  let chamadas = 0;
  const id = new Ideias({ pastaEstado: path.join(tmp(), 'nao-existe-ainda'), agora: () => agora, chamar: async () => (chamadas++, { erro: 'falhou' }) });
  const ret = () => ({ sessoes: [{ chave: 'k', status: 'ativa', projeto: 'p', tarefa: 't', modelo: 'claude-opus-5-5', esforco: 'high' }] });
  id.aplicar(ret());
  await new Promise((r) => setImmediate(r));
  id.aplicar(ret());
  assert.equal(chamadas, 1);
  agora += 11 * 60_000;
  id.aplicar(ret());
  await new Promise((r) => setImmediate(r));
  assert.equal(chamadas, 2);
});

test('ideias: tarefa vinda do primeiro pedido não entra no prompt; vai o nome da sessão', async () => {
  const PEDIDO = 'texto do pedido que nao pode alimentar as ideias';
  let agora = 1_000_000_000;
  const perguntas = [];
  const id = new Ideias({
    pastaEstado: tmp(),
    agora: () => agora,
    chamar: async (pergunta) => (perguntas.push(pergunta), { texto: '{"complexidade":"mecanica","ideias":["a","b"],"motivo":"m"}', custo: 0 }),
  });
  const sessao = (extra) => ({ chave: 'k', status: 'ativa', projeto: 'p', tarefa: PEDIDO, tarefaOrigem: 'pedido', nome: 'refatorar login', resumo: null, modelo: 'claude-opus-5-5', esforco: 'high', ...extra });
  id.aplicar({ sessoes: [sessao()] });
  await new Promise((r) => setImmediate(r));
  assert.equal(perguntas.length, 1);
  assert.match(perguntas[0], /- tarefa atual: refatorar login\n/);
  assert.ok(!perguntas[0].includes(PEDIDO));
  // O pedido mudar não conta como mudança relevante (a assinatura usa o mesmo texto do prompt).
  agora += 11 * 60_000;
  id.aplicar({ sessoes: [sessao({ tarefa: `${PEDIDO} outro` })] });
  await new Promise((r) => setImmediate(r));
  assert.equal(perguntas.length, 1);
  // Sem nome e sem resumo, a sessão nem vira alvo: o pedido sozinho não basta.
  id.aplicar({ sessoes: [sessao({ chave: 'k2', nome: null })] });
  await new Promise((r) => setImmediate(r));
  assert.equal(perguntas.length, 1);
  // Título ou resumo continuam indo como tarefa.
  id.aplicar({ sessoes: [sessao({ chave: 'k3', tarefa: 'título da IA', tarefaOrigem: 'titulo' })] });
  await new Promise((r) => setImmediate(r));
  assert.equal(perguntas.length, 2);
  assert.match(perguntas[1], /- tarefa atual: título da IA\n/);
});

test('ideias: o teto diário vem do construtor', async () => {
  let chamadas = 0;
  const id = new Ideias({ pastaEstado: tmp(), tetoDia: 0, chamar: async () => (chamadas++, { erro: 'x' }) });
  id.aplicar({ sessoes: [{ chave: 'k', status: 'ativa', projeto: 'p', tarefa: 't', modelo: 'claude-opus-5-5', esforco: 'high' }] });
  await new Promise((r) => setImmediate(r));
  assert.equal(chamadas, 0);
});

test('R1: resposta copiada entre sessões (retomada) conta uma vez, na sessão de origem', async () => {
  const raiz = tmp();
  const dir = path.join(raiz, '.claude');
  const proj = path.join(dir, 'projects', '-home-x-Documentos-projeto-a');
  fs.mkdirSync(proj, { recursive: true });
  const antiga = new Date(Date.now() - 3600_000).toISOString();
  const comum = resposta({ id: 'orig', req: 'orig', ts: antiga });
  fs.writeFileSync(path.join(proj, 'origem.jsonl'), comum);
  await new Promise((r) => setTimeout(r, 30)); // a cópia nasce depois
  fs.writeFileSync(path.join(proj, 'copia.jsonl'), comum + resposta({ id: 'nova', req: 'nova' }));
  const r = new Coletor({ dirs: [dir] }).retrato();
  const origem = r.sessoes.find((s) => s.sessionId === 'origem');
  const copia = r.sessoes.find((s) => s.sessionId === 'copia');
  assert.ok(Math.abs(origem.custo - 0.024) < 1e-9);
  assert.ok(Math.abs(copia.custo - 0.024) < 1e-9, `cópia ${copia.custo}`);
  assert.ok(Math.abs(r.totalDia - 0.048) < 1e-9, `total ${r.totalDia}`);
});

test('R5: custo só aparece como conferido quando o cost-state bate ou corrigiu', () => {
  const raiz = tmp();
  const mk = (id, total) =>
    montarConta(raiz, `.claude-${id}`, { sessionId: id, linhas: resposta({ id, req: id }) + linha({ type: 'cost-state', totalCostUSD: total, startTime: Date.now() - 7200_000 }) });
  const dirs = [mk('bate', 0.024), mk('corrige', 0.03), mk('diverge', 0.004)];
  const r = new Coletor({ dirs }).retrato();
  const por = Object.fromEntries(r.sessoes.map((s) => [s.sessionId, s]));
  assert.equal(por.bate.custoConferido, true);
  assert.equal(por.corrige.custoConferido, true);
  assert.ok(Math.abs(por.corrige.custo - 0.03) < 1e-9);
  assert.equal(por.diverge.custoConferido, false);
});

test('R3: registro órfão com o mesmo sessionId não esconde o registro vivo', () => {
  const raiz = tmp();
  const dir = montarConta(raiz, '.claude', { sessionId: 'vivo', pid: process.pid, procStart: inicioDoProcesso(process.pid), linhas: resposta({}) });
  fs.writeFileSync(path.join(dir, 'sessions', '1.json'), JSON.stringify({ pid: 999999, sessionId: 'vivo', procStart: '1', updatedAt: Date.now() + 10_000, status: 'idle' }));
  const c = new Coletor({ dirs: [dir] });
  assert.equal(c.registroDe(dir, 'vivo').pid, process.pid);
  assert.equal(c.retrato().sessoes[0].status, 'ativa');
});

test('R2: log de sessão ociosa desde ontem sai completo', async (t) => {
  const raiz = tmp();
  const bin = path.join(raiz, 'claude');
  fs.symlinkSync(process.execPath, bin);
  const filho = spawn(bin, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  const ontem = new Date(Date.now() - 30 * 3600_000).toISOString();
  const dir = montarConta(raiz, '.claude', {
    sessionId: 'velha',
    pid: filho.pid,
    procStart: inicioDoProcesso(filho.pid),
    status: 'idle',
    linhas: resposta({ ts: ontem }) + linha({ type: 'ai-title', aiTitle: 'Tarefa de ontem' }),
  });
  const proj = path.join(dir, 'projects', '-home-x-Documentos-projeto-a', 'velha.jsonl');
  const velho = new Date(Date.now() - 30 * 3600_000);
  fs.utimesSync(proj, velho, velho);
  const c = new Coletor({ dirs: [dir] });
  const r = await executarEncerrar(c, { id: 'v1', chave: 'principal:velha', idadeMs: 0 });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.log.projeto, 'projeto-a');
  assert.equal(r.log.modelo, 'claude-opus-5-5');
  assert.ok(r.log.custo > 0);
  assert.match(r.log.nome, /projeto-a – Tarefa de ontem$/);
});

test('ehClaude não aceita processo que só cita "claude-code" nos argumentos', async (t) => {
  const filho = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'notas-claude-code.md'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ehClaude(filho.pid), false);
});

test('coletor só envia para https (ou servidor local)', () => {
  assert.equal(urlAceita('https://moises-iota.vercel.app'), true);
  assert.equal(urlAceita('http://localhost:3800'), true);
  assert.equal(urlAceita('http://moises-iota.vercel.app'), false);
  assert.equal(urlAceita('lixo'), false);
});

test('R1 no log: encerrar a sessão retomada não leva o custo copiado da origem', async (t) => {
  const raiz = tmp();
  const bin = path.join(raiz, 'claude');
  fs.symlinkSync(process.execPath, bin);
  const filho = spawn(bin, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  const antiga = new Date(Date.now() - 3600_000).toISOString();
  const comum = resposta({ id: 'o1', req: 'o1', ts: antiga });
  const dir = path.join(raiz, '.claude');
  const proj = path.join(dir, 'projects', '-home-x-Documentos-projeto-a');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'origem2.jsonl'), comum);
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(path.join(proj, 'copia2.jsonl'), comum + resposta({ id: 'c1', req: 'c1' }));
  fs.writeFileSync(
    path.join(dir, 'sessions', `${filho.pid}.json`),
    JSON.stringify({ pid: filho.pid, sessionId: 'copia2', cwd: '/home/x/Documentos/projeto-a', procStart: inicioDoProcesso(filho.pid), status: 'busy', updatedAt: Date.now() }),
  );
  const c = new Coletor({ dirs: [dir] });
  const r = await executarEncerrar(c, { id: 'cp1', chave: 'principal:copia2', idadeMs: 0 });
  assert.equal(r.ok, true, r.erro);
  assert.ok(Math.abs(r.log.custo - 0.024) < 1e-9, `log ${r.log.custo}`);
});

test('redigir não trava com texto enorme e repetitivo', () => {
  const t0 = Date.now();
  redigir('secret'.repeat(2000), 280);
  redigir('a'.repeat(40000), 280);
  redigir('x-'.repeat(20000) + 'token', 280);
  assert.ok(Date.now() - t0 < 500, `levou ${Date.now() - t0} ms`);
});

// ---- Tarefa 5: estado ao vivo, última resposta, tarefa e redação de blocos ----

const pedidoDoDono = (conteudo, extra = {}) =>
  linha({ type: 'user', timestamp: agoraIso(), cwd: '/home/x/Documentos/projeto-a', message: { role: 'user', content: conteudo }, ...extra });
const falaDoClaude = (conteudo, { ts = agoraIso(), model = 'claude-opus-5-5', ...extra } = {}) =>
  linha({ type: 'assistant', timestamp: ts, cwd: '/home/x/Documentos/projeto-a', message: { id: `m_${Math.random()}`, model, content: conteudo }, ...extra });

// Monta uma sessão viva com as linhas dadas e devolve a sessão do retrato.
function sessaoViva(linhas, opts = {}) {
  const dir = montarConta(tmp(), '.claude', { sessionId: 'tttt', pid: process.pid, procStart: inicioDoProcesso(process.pid), linhas, ...opts });
  return new Coletor({ dirs: [dir] }).retrato().sessoes[0];
}

test('estado ao vivo a partir do registro', () => {
  const agora = 10_000_000;
  assert.equal(estadoDe({ status: 'busy' }, false, agora), 'encerrada');
  assert.equal(estadoDe({ status: 'waiting', waitingFor: 'permission prompt' }, false, agora), 'encerrada');
  for (const status of ['busy', 'shell', 'running', 'BUSY']) assert.equal(estadoDe({ status }, true, agora), 'trabalhando', status);
  for (const waitingFor of ['permission prompt', 'sandbox request', 'worker request', 'Permission Prompt'])
    assert.equal(estadoDe({ status: 'waiting', waitingFor }, true, agora), 'esperando_permissao', waitingFor);
  assert.equal(estadoDe({ status: 'waiting', waitingFor: 'input needed' }, true, agora), 'esperando_mensagem');
  assert.equal(estadoDe({ status: 'waiting' }, true, agora), 'esperando_mensagem');
  assert.equal(estadoDe({ status: 'idle', statusUpdatedAt: agora - 60_000 }, true, agora), 'esperando_mensagem');
  assert.equal(estadoDe({ status: 'idle', statusUpdatedAt: agora - 20 * 60_000 }, true, agora), 'parada');
  assert.equal(estadoDe({ status: 'idle', updatedAt: agora - 20 * 60_000 }, true, agora), 'parada');
  assert.equal(estadoDe({}, true, agora), 'parada'); // sem status nem horário: nada indica atividade
  // o campo antigo continua valendo
  assert.equal(statusDe({ status: 'waiting', waitingFor: 'permission prompt' }, true, agora), 'aguardando');
  // e chega ao retrato
  assert.equal(sessaoViva(resposta({}), { status: 'busy' }).estado, 'trabalhando');
  assert.equal(sessaoViva(resposta({}), { status: 'busy' }).status, 'ativa');
  const morta = montarConta(tmp(), '.claude', { sessionId: 'mmmm', pid: 999999, procStart: '1', linhas: resposta({}) });
  assert.equal(new Coletor({ dirs: [morta] }).retrato().sessoes[0].estado, 'encerrada');
});

test('transcript guarda o primeiro pedido e a última resposta', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  const t1 = Date.parse('2026-11-11T10:00:00Z');
  const t2 = Date.parse('2026-11-11T10:05:00Z');
  fs.writeFileSync(
    f,
    pedidoDoDono('texto de meta', { isMeta: true }) +
      pedidoDoDono('<command-name>/clear</command-name>') +
      pedidoDoDono('pedido de subagente', { isSidechain: true }) +
      pedidoDoDono([{ type: 'tool_result', tool_use_id: 't1', content: 'saída da ferramenta' }]) +
      pedidoDoDono([{ type: 'text', text: 'Primeiro pedido de verdade' }]) +
      pedidoDoDono('Segundo pedido') +
      falaDoClaude([{ type: 'text', text: 'Primeira resposta' }], { ts: agoraIso(t1) }) +
      falaDoClaude([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]) +
      falaDoClaude([{ type: 'text', text: 'Fala de subagente' }], { isSidechain: true }) +
      falaDoClaude([{ type: 'text', text: 'No response requested.' }], { model: '<synthetic>' }),
  );
  const est = novoEstado();
  assert.equal(est.primeiroPedido, null);
  assert.equal(est.ultimaResposta, null);
  assert.equal(est.ultimaRespostaEm, null);
  lerNovidades(f, est);
  assert.equal(est.primeiroPedido, 'Primeiro pedido de verdade');
  assert.equal(est.ultimaResposta, 'Primeira resposta');
  assert.equal(est.ultimaRespostaEm, t1);

  // com vários blocos de texto, vale o último; o pedido não é trocado
  fs.appendFileSync(f, falaDoClaude([{ type: 'text', text: 'rascunho' }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }, { type: 'text', text: 'Resposta final' }], { ts: agoraIso(t2) }));
  lerNovidades(f, est);
  assert.equal(est.ultimaResposta, 'Resposta final');
  assert.equal(est.ultimaRespostaEm, t2);
  assert.equal(est.primeiroPedido, 'Primeiro pedido de verdade');

  // corte em 4.000 caracteres ao ler
  const f2 = path.join(dir, 's2.jsonl');
  fs.writeFileSync(f2, pedidoDoDono('a'.repeat(5000)) + falaDoClaude([{ type: 'text', text: 'b'.repeat(5000) }]));
  const est2 = novoEstado();
  lerNovidades(f2, est2);
  assert.equal(est2.primeiroPedido.length, 4000);
  assert.equal(est2.ultimaResposta.length, 4000);

  // transcript de subagente (principal: false) não conta
  const est3 = novoEstado();
  lerNovidades(f, est3, { principal: false });
  assert.equal(est3.primeiroPedido, null);
  assert.equal(est3.ultimaResposta, null);
});

test('tarefa cai para o primeiro pedido e depois para o nome, e diz a origem', () => {
  const titulo = linha({ type: 'ai-title', aiTitle: 'Título da IA' });
  const resumo = linha({ type: 'system', subtype: 'away_summary', content: 'Resumo do trabalho' });
  const pedido = pedidoDoDono('Quero um painel com senha=abc123 e filtros');

  let s = sessaoViva(pedido + resumo + titulo);
  assert.deepEqual([s.tarefa, s.tarefaOrigem], ['Título da IA', 'titulo']);
  s = sessaoViva(pedido + resumo);
  assert.deepEqual([s.tarefa, s.tarefaOrigem], ['Resumo do trabalho', 'resumo']);
  s = sessaoViva(resposta({}) + pedido);
  assert.equal(s.tarefaOrigem, 'pedido');
  assert.equal(s.tarefa, 'Quero um painel com [oculto] e filtros'); // sai mascarado
  s = sessaoViva(pedidoDoDono('pedido '.repeat(50)));
  assert.equal(s.tarefa.length, 140);
  s = sessaoViva(resposta({}));
  assert.deepEqual([s.tarefa, s.tarefaOrigem], ['minha-sessao', 'nome']);
  s = sessaoViva(resposta({}), { name: null });
  assert.deepEqual([s.tarefa, s.tarefaOrigem], [null, null]);
});

test('última resposta sai mascarada e cortada em 1200', () => {
  const agora = Date.now() - 5000;
  const fala = 'Pronto, use a chave sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA e depois ' + 'palavra '.repeat(400);
  let s = sessaoViva(falaDoClaude([{ type: 'text', text: fala }], { ts: agoraIso(agora) }));
  assert.equal(s.ultimaResposta.length, 1200);
  assert.ok(s.ultimaResposta.endsWith('…'));
  assert.ok(!s.ultimaResposta.includes('sk-ant'));
  assert.equal(s.ultimaRespostaEm, agora);
  assert.equal(s.gerenciada, false);
  assert.deepEqual(s.permissoes, []);
  s = sessaoViva(pedidoDoDono('oi'));
  assert.equal(s.ultimaResposta, null);
  assert.equal(s.ultimaRespostaEm, null);
});

test('cwdDe devolve a pasta da sessão viva e da encerrada', () => {
  const raiz = tmp();
  const viva = montarConta(raiz, '.claude', { sessionId: 'vvvv', pid: process.pid, procStart: inicioDoProcesso(process.pid), linhas: resposta({}) });
  // o registro vivo manda: ele difere do cwd do transcript
  const regArq = path.join(viva, 'sessions', `${process.pid}.json`);
  fs.writeFileSync(regArq, JSON.stringify({ ...JSON.parse(fs.readFileSync(regArq, 'utf8')), cwd: '/home/x/outra-pasta' }));
  const encerrada = montarConta(raiz, '.claude-conta2', { sessionId: 'eeee', linhas: resposta({}) }); // sem registro
  const morta = montarConta(raiz, '.claude-conta3', { sessionId: 'oooo', pid: 999999, procStart: '1', linhas: resposta({}) });
  const regMorto = path.join(morta, 'sessions', '999999.json');
  fs.writeFileSync(regMorto, JSON.stringify({ ...JSON.parse(fs.readFileSync(regMorto, 'utf8')), cwd: '/home/x/pasta-do-morto' }));
  const relativa = montarConta(raiz, '.claude-conta4', { sessionId: 'rrrr', linhas: linha({ type: 'user', timestamp: agoraIso(), cwd: 'pasta/relativa', message: { content: 'oi' } }) });

  const c = new Coletor({ dirs: [viva, encerrada, morta, relativa] });
  assert.equal(c.cwdDe('principal:vvvv'), '/home/x/outra-pasta');
  assert.equal(c.cwdDe('conta2:eeee'), '/home/x/Documentos/projeto-a'); // do transcript
  assert.equal(c.cwdDe('conta3:oooo'), '/home/x/Documentos/projeto-a'); // registro morto não vale
  assert.equal(c.cwdDe('conta4:rrrr'), null); // caminho relativo não serve
  assert.equal(c.cwdDe('principal:zzzz'), null);
  assert.equal(c.cwdDe('conta9:vvvv'), null);
  assert.equal(c.cwdDe('semdoispontos'), null);
  assert.equal(c.cwdDe(null), null);
});

test('redigirBloco preserva quebras de linha e marca alterado quando mascara, escapa ou corta', () => {
  // texto limpo: nada muda, nem espaços repetidos, tabulações e quebras de linha
  const limpo = 'git status\n\tum    recuo\nfim';
  assert.deepEqual(redigirBloco(limpo), { texto: limpo, alterado: false });
  assert.deepEqual(redigirBloco(null), { texto: '', alterado: false });
  // mascara e mantém as quebras de linha
  assert.deepEqual(redigirBloco('a\nsenha=abc123\nb'), { texto: 'a\n[oculto]\nb', alterado: true });
  assert.equal(redigirBloco('mail a.b@x.com\n4111 1111 1111 1111').texto, 'mail [oculto]\n[oculto]');
  // escapa controle, direção de texto e largura zero; \n e \t ficam
  const r = redigirBloco('a\u202Eb\u200Bc\u0007d\re\u2066f\uFEFFg\u007Fh\n\ti');
  assert.equal(r.texto, 'a\\u{202E}b\\u{200B}c\\u{0007}d\\u{000D}e\\u{2066}f\\u{FEFF}g\\u{007F}h\n\ti');
  assert.equal(r.alterado, true);
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00, 0x1b]) {
    const x = redigirBloco(`x${String.fromCodePoint(cp)}y`);
    assert.ok(!x.texto.includes(String.fromCodePoint(cp)), `U+${cp.toString(16)} não foi escapado`);
    assert.equal(x.texto, `x\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}y`);
    assert.equal(x.alterado, true);
  }
  // corta em max (reticências incluídas); no limite exato não corta
  const c = redigirBloco('palavra '.repeat(10), 20);
  assert.equal(c.texto.length, 20);
  assert.ok(c.texto.endsWith('…'));
  assert.equal(c.alterado, true);
  assert.deepEqual(redigirBloco('palavra palavra abcd', 20), { texto: 'palavra palavra abcd', alterado: false });
  assert.equal(redigirBloco('palavra '.repeat(1500)).texto.length, 4000); // padrão 4.000
  // texto enorme não trava e conta como alterado
  const t0 = Date.now();
  const enorme = redigirBloco('secret'.repeat(20_000));
  assert.equal(enorme.alterado, true);
  assert.ok(Date.now() - t0 < 1000, `levou ${Date.now() - t0} ms`);
});

test('redigirBloco não mascara caminho longo de arquivo', () => {
  const caminho = 'cat /home/usuario/Documentos/projetos/um-projeto-qualquer/src/componentes/arquivo';
  assert.ok(caminho.length > 60);
  assert.deepEqual(redigirBloco(caminho), { texto: caminho, alterado: false });
  const comando = `Edit ${'/a/b'.repeat(30)}/index.js\nrm -rf /tmp/${'pasta/'.repeat(12)}x`;
  assert.deepEqual(redigirBloco(comando), { texto: comando, alterado: false });
  // o redigir comum continua mascarando (só o bloco muda)
  assert.ok(redigir(caminho, 500).includes('[oculto]'));
});

test('redigirBloco mascara base64 longo sem barra, com preenchimento e com sinal de mais', () => {
  const b = (n, c = 'xY7') => c.repeat(Math.ceil(n / c.length)).slice(0, n);
  // 40 ou mais de [A-Za-z0-9+_-], sem barra
  assert.equal(redigirBloco(`chave ${b(45)} fim`).texto, 'chave [oculto] fim');
  assert.equal(redigirBloco(`chave ${b(45, 'xY-_7')} fim`).texto, 'chave [oculto] fim');
  assert.equal(redigirBloco(`chave ${b(39)} fim`).texto, `chave ${b(39)} fim`); // abaixo do mínimo
  // com barra e preenchimento (= ou ==)
  const comBarra = `${b(20)}/${b(30)}`;
  assert.equal(redigirBloco(`x ${comBarra}= y`).texto, 'x [oculto] y');
  assert.equal(redigirBloco(`x ${comBarra}== y`).texto, 'x [oculto] y');
  assert.equal(redigirBloco(`x ${comBarra} y`).texto, `x ${comBarra} y`); // sem = nem +: é caminho
  // com barra e ao menos um sinal de mais
  const comMais = `${b(20)}/${b(10)}+${b(20)}`;
  assert.equal(redigirBloco(`x ${comMais} y`).texto, 'x [oculto] y');
  assert.equal(redigirBloco(`x ${comMais}`).alterado, true);
});

test('redigirBloco escapa espaço não separável, U+2028, U+061C, seletor de variação e caractere de etiqueta fora do plano básico', () => {
  const c = (cp) => String.fromCodePoint(cp);
  const esc = (cp) => `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
  for (const cp of [0xa0, 0x2028, 0x2029, 0x061c, 0xfe0f, 0xe0100, 0xe0041, 0x3000, 0x115f, 0x1160, 0x3164, 0xffa0, 0x00ad, 0xe000, 0x2007]) {
    const r = redigirBloco(`a${c(cp)}b`);
    assert.equal(r.texto, `a${esc(cp)}b`, `U+${cp.toString(16)}`);
    assert.equal(r.alterado, true);
  }
  // fora do plano básico: um escape só, com o ponto de código inteiro
  assert.equal(redigirBloco(c(0xe0041)).texto, '\\u{E0041}');
  // o espaço comum, \n e \t ficam; letras acentuadas e emoji comum também
  assert.deepEqual(redigirBloco('a b\n\tç ✓'), { texto: 'a b\n\tç ✓', alterado: false });
});

test('redigir mascara cartão válido e CEP e não mascara número que falha no Luhn', () => {
  assert.equal(redigir('cartão 4111 1111 1111 1111 fim'), 'cartão [oculto] fim');
  assert.equal(redigir('cartão 4111-1111-1111-1111.'), 'cartão [oculto].');
  assert.equal(redigir('5500000000000004'), '[oculto]'); // sem separador
  assert.equal(redigir('amex 378282246310005'), 'amex [oculto]'); // 15 dígitos
  assert.equal(redigir('4111 1111 1111 1112'), '4111 1111 1111 1112'); // falha no Luhn
  assert.equal(redigir('pedido 1234 5678 9012 3456'), 'pedido 1234 5678 9012 3456'); // falha no Luhn
  assert.equal(redigir('CEP 37200-000, Lavras'), 'CEP [oculto], Lavras');
  assert.equal(redigir('versão 12345 e porta 3800'), 'versão 12345 e porta 3800');
  assert.equal(redigir('linha 12345-67 sem cep'), 'linha 12345-67 sem cep');
});

test('MOISES_SUBIR_TEXTO=0 não sobe resposta nem pedido', (t) => {
  const anterior = process.env.MOISES_SUBIR_TEXTO;
  t.after(() => {
    if (anterior === undefined) delete process.env.MOISES_SUBIR_TEXTO;
    else process.env.MOISES_SUBIR_TEXTO = anterior;
  });
  const linhas = pedidoDoDono('Pedido secreto do dono') + falaDoClaude([{ type: 'text', text: 'Resposta secreta do Claude' }]);
  delete process.env.MOISES_SUBIR_TEXTO;
  let s = sessaoViva(linhas);
  assert.equal(s.tarefa, 'Pedido secreto do dono');
  assert.equal(s.ultimaResposta, 'Resposta secreta do Claude');

  process.env.MOISES_SUBIR_TEXTO = '0';
  s = sessaoViva(linhas);
  assert.equal(s.ultimaResposta, null);
  assert.equal(s.ultimaRespostaEm, null);
  assert.deepEqual([s.tarefa, s.tarefaOrigem], ['minha-sessao', 'nome']);
  assert.ok(!JSON.stringify(s).includes('secret'));
  // o título da IA continua valendo: não é texto do pedido
  s = sessaoViva(linhas + linha({ type: 'ai-title', aiTitle: 'Título da IA' }));
  assert.deepEqual([s.tarefa, s.tarefaOrigem], ['Título da IA', 'titulo']);
});

test('log de encerramento não leva tarefa vinda do pedido', async (t) => {
  const base = { projeto: 'projeto-a', conta: 'principal', resumo: null, iniciadaEm: 1000, modelo: 'm', esforco: 'high', porModelo: {}, tokens: {}, custo: 1 };
  const doPedido = logDeEncerramento({ ...base, tarefa: 'Texto do pedido do dono', tarefaOrigem: 'pedido', nome: 'minha-sessao' }, null, 5000);
  assert.equal(doPedido.tarefa, null);
  assert.ok(!JSON.stringify(doPedido).includes('Texto do pedido'), 'o nome padrão também não pode levar o pedido');
  assert.equal(doPedido.nome, `${diaLocal(5000)} projeto-a – minha-sessao`);
  assert.equal(doPedido.duracaoMs, 4000);
  const doTitulo = logDeEncerramento({ ...base, tarefa: 'Título da IA', tarefaOrigem: 'titulo', nome: null }, null, 5000);
  assert.equal(doTitulo.tarefa, 'Título da IA');
  assert.match(doTitulo.nome, /projeto-a – Título da IA$/);
  assert.equal(logDeEncerramento({ ...base, tarefa: 'x', tarefaOrigem: 'pedido', nome: null }, 'Nome do dono', 5000).nome, 'Nome do dono');

  // pelo caminho completo de executarEncerrar
  const raiz = tmp();
  const bin = path.join(raiz, 'claude');
  fs.symlinkSync(process.execPath, bin);
  const filho = spawn(bin, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200));
  const dir = montarConta(raiz, '.claude', { sessionId: 'pppp', pid: filho.pid, procStart: inicioDoProcesso(filho.pid), linhas: pedidoDoDono('Pedido que não vai ao Histórico') + resposta({}) });
  const r = await executarEncerrar(new Coletor({ dirs: [dir] }), { id: 'pedido-1', chave: 'principal:pppp', idadeMs: 0 });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.log.tarefa, null);
  assert.ok(!JSON.stringify(r.log).includes('Pedido que não'));
  assert.match(r.log.nome, /projeto-a – minha-sessao$/);
});
