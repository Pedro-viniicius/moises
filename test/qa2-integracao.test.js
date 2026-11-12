// QA, rodada 2: o canal de comandos de ponta a ponta SEM painel falso. Sobe o servidor local de verdade
// (scripts/dev.js: public/ estático + api/*.js com Redis em memória), roda o coletor de verdade contra ele
// (conferência do painel publicado incluída), usa o módulo do navegador (public/assinatura.js, WebCrypto) para
// gerar a chave e assinar, e o script de autorização (scripts/configurar-comandos.js) para o pareamento.
// O claude é o falso de test/fixtures. Nada lê ~/.config/moises nem ~/.local/state/moises: tudo em pasta
// temporária, com segredos sorteados aqui.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gerarHashSenha } from '../api/_lib.js';
import { rodar } from '../collector/index.js';
import { Coletor } from '../collector/sessoes.js';
import * as nav from '../public/assinatura.js';
import { gravarChaves } from './fixtures/aparelho.js';

delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_SUBIR_TEXTO;

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const DEV = path.join(RAIZ, 'scripts/dev.js');
const CONFIGURAR = path.join(RAIZ, 'scripts/configurar-comandos.js');
const FALSO = path.join(RAIZ, 'test/fixtures/claude-falso.js');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-qa2-'));
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const SENHA = 'qa2-senha-so-deste-teste';
let casos = 0;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, descricao, ms = 15_000) {
  const limite = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`esperou demais: ${descricao}`);
    await espera(25);
  }
}
const lerLinhas = (arq) => (fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const processosCom = (trecho) => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(trecho) && !l.includes('ps -eo'));

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Servidor local de verdade, já com o dono logado. `api()` devolve { status, body }.
async function subirPainel(t) {
  const porta = await portaLivre();
  const token = crypto.randomBytes(32).toString('base64url');
  const filho = spawn(process.execPath, [DEV], {
    env: {
      PATH: process.env.PATH,
      HOME: BASE,
      PORT: String(porta),
      PANEL_PASSWORD_HASH: gerarHashSenha(SENHA),
      SESSION_SECRET: crypto.randomBytes(36).toString('base64url'),
      MOISES_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => filho.kill('SIGKILL'));
  let saida = '';
  filho.stdout.on('data', (d) => (saida += d));
  filho.stderr.on('data', (d) => (saida += d));
  await ate(() => saida.includes('painel local em'), `servidor local subir (${saida})`);
  const url = `http://127.0.0.1:${porta}`;
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ senha: SENHA }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(rota, { method = 'GET', body } = {}) {
    const r = await fetch(`${url}${rota}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  return { url, token, api, estado: async () => (await api('/api/estado')).body };
}

// Pastas do computador do dono: o que o script e o coletor usam.
function computador() {
  const d = path.join(BASE, `caso-${++casos}`);
  const dirClaude = path.join(d, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(dirClaude, s), { recursive: true });
  const proj = path.join(d, 'projeto-x');
  fs.mkdirSync(proj);
  const conf = path.join(d, 'conf');
  fs.mkdirSync(conf);
  const estado = path.join(d, 'estado');
  const projetosArq = path.join(conf, 'projetos.json');
  fs.writeFileSync(projetosArq, JSON.stringify({ 'projeto-x': proj }));
  const chavesArq = path.join(conf, 'chaves-comandos.json');
  const env = { PATH: process.env.PATH, HOME: d, MOISES_PASTA_CONF: conf, MOISES_ESTADO: estado };
  const script = (...args) => spawnSync(process.execPath, [CONFIGURAR, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  return { d, dirClaude, proj, conf, estado, projetosArq, chavesArq, script };
}

async function iniciarColetor(t, pc, painel, extra = {}) {
  const logs = [];
  const coletor = await rodar({
    url: painel.url, token: painel.token, pastaEstado: pc.estado, chavesArq: pc.chavesArq, projetosArq: pc.projetosArq,
    dirs: [pc.dirClaude], intervaloMs: 150, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0,
    log: (...a) => logs.push(a.map(String).join(' ')),
    ...extra,
  });
  let parado = false;
  t.after(async () => {
    if (!parado) {
      parado = true;
      await coletor.parar();
    }
  });
  return { logs, parar: async () => { parado = true; await coletor.parar(); } };
}

// Comando assinado pelo módulo do navegador e enviado como o painel faz.
async function mandar(painel, ap, { tipo, chave = null, dados = {} }) {
  const cmd = await nav.assinarComando(ap, { tipo, chave, dados });
  const r = await painel.api('/api/comando', { method: 'POST', body: cmd });
  return { ...r, id: cmd.id };
}
const comandoNoPainel = async (painel, id) => (await painel.estado()).comandos.find((c) => c.id === id);
const desfecho = (painel, id, descricao) =>
  ate(async () => {
    const c = await comandoNoPainel(painel, id);
    return c && !['pendente', 'recebido'].includes(c.estado) ? c : null;
  }, `desfecho de ${descricao}`);
const sessaoNoRetrato = async (painel, chave) => (await painel.estado()).retrato?.sessoes.find((s) => s.chave === chave);

// Aparelho autorizado direto no arquivo de chaves, como o script grava (para os testes que não são do pareamento).
async function aparelhoAutorizado(pc, rotulo = 'celular do QA') {
  const ap = await nav.gerarAparelho();
  gravarChaves(pc.chavesArq, [{ kid: ap.kid, rotulo, publica: ap.publica }]);
  return ap;
}

// ---------------------------------------------------------------- CA3: pareamento por par de chaves

test('CA3: pareamento de ponta a ponta com o servidor, o coletor, o script e o módulo do navegador de verdade', async (t) => {
  const pc = computador();
  const painel = await subirPainel(t);
  const { logs } = await iniciarColetor(t, pc, painel);
  await ate(async () => (await painel.estado()).retrato, 'primeiro retrato do coletor');
  assert.deepEqual((await painel.estado()).retrato.orquestracao.aparelhos, []);

  // O aparelho gera o par de chaves; a privada não é extraível (nada para copiar do navegador).
  const ap = await nav.gerarAparelho();
  assert.equal(ap.chave.extractable, false);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey('pkcs8', ap.chave));

  // Antes de autorizado, o servidor recusa o aparelho que o coletor não anunciou (A4) e nada chega ao coletor.
  const antes = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'oi' } });
  assert.equal(antes.status, 403);
  assert.deepEqual((await painel.estado()).comandos, []);

  // Pedido de autorização: só a pública, o kid e o rótulo viajam. A chave privada não existe fora do navegador.
  const pedido = await painel.api('/api/aparelho', { method: 'POST', body: { kid: ap.kid, publica: ap.publica, rotulo: 'celular do QA' } });
  assert.equal(pedido.status, 200, JSON.stringify(pedido.body));
  const arqPedidos = path.join(pc.estado, 'aparelhos-pedidos.json');
  const gravado = await ate(() => fs.existsSync(arqPedidos) && JSON.parse(fs.readFileSync(arqPedidos, 'utf8')).find((p) => p.kid === ap.kid), 'pedido de pareamento no computador');
  assert.deepEqual(Object.keys(gravado).sort(), ['criadoEm', 'kid', 'publica', 'rotulo']);
  assert.equal(fs.statSync(arqPedidos).mode & 0o777, 0o600);
  assert.equal(fs.statSync(pc.estado).mode & 0o777, 0o700, 'pasta de estado só do dono (Q2)');

  // O script lista o pedido sem a impressão digital nem a chave pública. Rodada de correção 2 (SE-M3): a
  // impressão vem do aparelho (aqui, o módulo do navegador: ap.impressao), como o dono a lê na tela e digita.
  const lista = pc.script('--pedidos');
  assert.equal(lista.status, 0, lista.stderr);
  assert.ok(lista.stdout.includes(ap.kid) && lista.stdout.includes('celular do QA'), lista.stdout);
  assert.ok(!(lista.stdout + lista.stderr).includes(ap.impressao), 'a impressão digital não sai do terminal');
  assert.ok(!(lista.stdout + lista.stderr).includes(ap.publica));

  // Sem a impressão digital, ou com a de outro aparelho, nada é gravado.
  assert.equal(pc.script('--autorizar', ap.kid).status, 1);
  const outro = await nav.gerarAparelho();
  assert.equal(pc.script('--autorizar', ap.kid, outro.impressao).status, 1);
  assert.equal(fs.existsSync(pc.chavesArq), false, 'nada gravado sem a impressão digital certa');

  const ok = pc.script('--autorizar', ap.kid, ap.impressao);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!(ok.stdout + ok.stderr).includes(ap.publica));
  assert.equal(fs.statSync(pc.chavesArq).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(pc.chavesArq, 'utf8'))[ap.kid].publica, ap.publica);

  // O coletor passa a anunciar o aparelho; só então o servidor aceita o comando dele.
  await ate(async () => (await painel.estado()).retrato.orquestracao.aparelhos.some((a) => a.kid === ap.kid), 'aparelho anunciado');
  const abrir = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'oi', nome: 'qa2 pareamento' } });
  assert.equal(abrir.status, 200, JSON.stringify(abrir.body));
  const fim = await desfecho(painel, abrir.id, 'abrir');
  assert.equal(fim.estado, 'feito', JSON.stringify(fim));
  const sessao = await ate(async () => (await painel.estado()).retrato.sessoes.find((s) => s.gerenciada === true && s.nome === 'qa2 pareamento'), 'sessão comandada no retrato');
  assert.equal(sessao.projeto, 'projeto-x');

  // Auditoria local: quem é o aparelho, aceito e feito (com a sessão criada).
  const aud = lerLinhas(path.join(pc.estado, 'auditoria.jsonl')).filter((l) => l.id === abrir.id);
  assert.deepEqual(aud.map((l) => l.decisao), ['aceito', 'feito']);
  assert.equal(aud[0].quem, `${ap.kid} (celular do QA)`);
  assert.equal(aud[1].sessao, sessao.chave);

  // A assinatura vale só para o aparelho: um comando do outro par de chaves, com o kid do autorizado, é recusado.
  const falsificado = await nav.assinarComando({ kid: ap.kid, chave: outro.chave }, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'invasor' } });
  const rf = await painel.api('/api/comando', { method: 'POST', body: falsificado });
  assert.equal(rf.status, 200, 'o servidor não confere assinatura; quem decide é o coletor');
  const fimF = await desfecho(painel, falsificado.id, 'falsificado');
  assert.deepEqual([fimF.estado, fimF.motivo], ['recusado', 'assinatura']);
  assert.equal((await painel.estado()).retrato.sessoes.filter((s) => s.gerenciada === true).length, 1, 'nenhuma sessão nova');

  // Revogar no computador: o aparelho some do anúncio e o servidor volta a recusar.
  assert.equal(pc.script('--revogar', ap.kid).status, 0);
  await ate(async () => (await painel.estado()).retrato.orquestracao.aparelhos.length === 0, 'aparelho revogado deixa de ser anunciado');
  const depois = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'depois' } });
  assert.equal(depois.status, 403);

  // Nada de dado pessoal nos logs do coletor.
  const tudo = logs.join('\n');
  assert.ok(!tudo.includes(ap.publica) && !tudo.includes('celular do QA'), tudo);
});

// ---------------------------------------------------------------- CA2 e CA5: pedido de permissão pelo painel

test('CA2/CA5: pedido inteiro aprova uma vez com a impressão digital da tela; sensível e "cauda escondida" só se negam', async (t) => {
  const pc = computador();
  const painel = await subirPainel(t);
  const ap = await aparelhoAutorizado(pc);
  await iniciarColetor(t, pc, painel);
  await ate(async () => (await painel.estado()).retrato?.orquestracao.aparelhos.some((a) => a.kid === ap.kid), 'aparelho anunciado');

  const abrir = async (pedido, nome) => {
    const r = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido, nome } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await desfecho(painel, r.id, `abrir ${nome}`)).estado, 'feito');
    return ate(async () => (await painel.estado()).retrato.sessoes.find((s) => s.gerenciada === true && s.nome === nome && s.permissoes?.length), `pedido de permissão de ${nome}`);
  };
  const responder = async (sessao, p, decisao, hash) => {
    const dados = { pedido: p.pedido, decisao, visto: { projeto: sessao.projeto, nome: sessao.nome }, ...(hash ? { vistoHash: hash } : {}) };
    const r = await mandar(painel, ap, { tipo: 'permissao', chave: sessao.chave, dados });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return desfecho(painel, r.id, `${decisao} ${p.pedido}`);
  };

  // 1. Pedido inteiro: aprovar com o hash do que está na tela funciona, e o hash errado não.
  const s1 = await abrir('permissao:echo oi', 'qa2 inteiro');
  const p1 = s1.permissoes[0];
  assert.deepEqual([p1.ferramenta, p1.completo, p1.sensivel], ['Bash', true, false]);
  const errado = await responder(s1, p1, 'aprovar', await nav.hashVisto(p1.ferramenta, `${p1.entrada} `));
  assert.equal(errado.estado, 'falhou');
  assert.match(errado.erro, /O pedido mudou/);
  const certo = await responder(s1, p1, 'aprovar', await nav.hashVisto(p1.ferramenta, p1.entrada));
  assert.equal(certo.estado, 'feito', JSON.stringify(certo));
  // Vale uma vez: o mesmo pedido já não está pendente.
  const repetido = await responder(s1, p1, 'aprovar', await nav.hashVisto(p1.ferramenta, p1.entrada));
  assert.equal(repetido.estado, 'falhou');
  assert.match(repetido.erro, /não está mais pendente/);

  // 2. Pedido sensível (toca ~/.ssh): aprovar é recusado mesmo com a impressão digital certa; negar vale.
  const s2 = await abrir('permissao:cat ~/.ssh/id_ed25519', 'qa2 sensivel');
  const p2 = s2.permissoes[0];
  assert.equal(p2.sensivel, true);
  const aprovarSensivel = await responder(s2, p2, 'aprovar', await nav.hashVisto(p2.ferramenta, p2.entrada));
  assert.equal(aprovarSensivel.estado, 'falhou');
  assert.match(aprovarSensivel.erro, /aprove só no computador, ou negue/);
  assert.equal((await sessaoNoRetrato(painel, s2.chave)).permissoes.length, 1, 'o pedido continua pendente depois da aprovação recusada');
  assert.equal((await responder(s2, p2, 'negar')).estado, 'feito');

  // 3. Letra não ASCII num comando Bash (homóglifo) também marca o pedido como sensível (S26).
  const s3 = await abrir('permissao:echo ｌｓ', 'qa2 homoglifo');
  assert.equal(s3.permissoes[0].sensivel, true);
  assert.equal((await responder(s3, s3.permissoes[0], 'aprovar', await nav.hashVisto('Bash', s3.permissoes[0].entrada))).estado, 'falhou');
  assert.equal((await responder(s3, s3.permissoes[0], 'negar')).estado, 'feito');

  // 4. "Cauda escondida" (3 linhas em branco seguidas): o pedido não é inteiro e só se nega (S14/A2).
  const s4 = await abrir('permissao:echo a\n\n\n\necho b', 'qa2 cauda');
  const p4 = s4.permissoes[0];
  assert.equal(p4.completo, false);
  const aprovarIncompleto = await responder(s4, p4, 'aprovar', await nav.hashVisto(p4.ferramenta, p4.entrada));
  assert.equal(aprovarIncompleto.estado, 'falhou');
  assert.match(aprovarIncompleto.erro, /não coube inteiro/);
  assert.equal((await responder(s4, p4, 'negar')).estado, 'feito');

  // O texto do pedido nunca aparece na auditoria nem nos acks que o servidor guarda.
  const aud = JSON.stringify([...lerLinhas(path.join(pc.estado, 'auditoria.jsonl')), ...lerLinhas(path.join(pc.estado, 'auditoria-recusas.jsonl'))]);
  assert.ok(!aud.includes('id_ed25519') && !aud.includes('echo oi'), 'nada do pedido na auditoria');
  const cmds = (await painel.estado()).comandos;
  assert.ok(cmds.every((c) => !('dados' in c) && !('assinatura' in c)));
});

// ---------------------------------------------------------------- CA2: conferência do painel publicado (S15)

test('CA2: com o painel publicado diferente de public/, os comandos são recusados e o retrato diz por quê; ao bater, voltam', async (t) => {
  const pc = computador();
  const painel = await subirPainel(t);
  const ap = await aparelhoAutorizado(pc);
  // Cópia de public/ com o app.js trocado: é o que o coletor acha que o painel deveria servir.
  const publica = path.join(pc.d, 'public');
  fs.cpSync(path.join(RAIZ, 'public'), publica, { recursive: true });
  const original = fs.readFileSync(path.join(publica, 'app.js'), 'utf8');
  fs.writeFileSync(path.join(publica, 'app.js'), `${original}\n// adulterado\n`);
  const { logs } = await iniciarColetor(t, pc, painel, { pastaPublica: publica, conferirPainelMs: 400 });

  const desligado = await ate(async () => {
    const r = (await painel.estado()).retrato;
    return r && r.orquestracao.ativa === false ? r : null;
  }, 'comandos desligados no retrato');
  assert.equal(desligado.orquestracao.motivo, 'painel_alterado');
  assert.ok(logs.some((l) => /app\.js é diferente de public\//.test(l)), logs.join('\n'));
  const r1 = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'oi', nome: 'qa2 painel' } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const recusado = await desfecho(painel, r1.id, 'abrir com painel alterado');
  assert.deepEqual([recusado.estado, recusado.motivo], ['recusado', 'painel_alterado']);
  assert.deepEqual((await painel.estado()).retrato.sessoes.filter((s) => s.gerenciada === true), []);
  const recusas = lerLinhas(path.join(pc.estado, 'auditoria-recusas.jsonl'));
  assert.ok(recusas.some((l) => l.id === r1.id && l.motivo === 'painel_alterado'));

  // O código local volta a bater com o publicado: os comandos voltam sem reiniciar o coletor.
  fs.writeFileSync(path.join(publica, 'app.js'), fs.readFileSync(path.join(RAIZ, 'public/app.js')));
  await ate(async () => (await painel.estado()).retrato.orquestracao.ativa === true, 'comandos religados');
  const r2 = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'oi', nome: 'qa2 painel' } });
  assert.equal((await desfecho(painel, r2.id, 'abrir com painel igual')).estado, 'feito');
  assert.ok(logs.some((l) => /comandos religados/.test(l)));
});

// ---------------------------------------------------------------- CA2: texto só de sessão comandada (S16) e CA5 (sessões isoladas)

test('CA2: o retrato que chega ao servidor só leva última resposta de sessão comandada pelo painel; sessão aberta à mão vai sem texto', async (t) => {
  const pc = computador();
  const painel = await subirPainel(t);
  const ap = await aparelhoAutorizado(pc);
  // Uma sessão aberta à mão, com transcrição que tem pedido e resposta.
  const id = '33333333-3333-4333-8333-333333333333';
  const pastaProj = path.join(pc.dirClaude, 'projects', '-tmp-projeto-x');
  fs.mkdirSync(pastaProj, { recursive: true });
  const agora = new Date().toISOString();
  const linhas = [
    { type: 'user', timestamp: agora, cwd: pc.proj, sessionId: id, message: { role: 'user', content: 'PEDIDO-SECRETO-DA-MAO faça algo' } },
    { type: 'assistant', timestamp: agora, cwd: pc.proj, sessionId: id, requestId: 'req_1', message: { id: 'msg_1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'RESPOSTA-SECRETA-DA-MAO pronto' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'custom-title', customTitle: 'sessao-manual', sessionId: id },
  ];
  fs.writeFileSync(path.join(pastaProj, `${id}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // Pré-condição: lido sozinho, o Coletor extrai o texto dessa sessão (senão o teste abaixo seria vácuo).
  const puro = new Coletor({ dirs: [pc.dirClaude] }).retrato().sessoes.find((s) => s.nome === 'sessao-manual');
  assert.ok(puro, 'a sessão aberta à mão aparece no retrato do Coletor');
  assert.ok(JSON.stringify(puro).includes('RESPOSTA-SECRETA-DA-MAO'), 'o Coletor puro leva a última resposta');
  await iniciarColetor(t, pc, painel);
  await ate(async () => (await painel.estado()).retrato?.orquestracao.aparelhos.some((a) => a.kid === ap.kid), 'aparelho anunciado');

  // Uma sessão comandada pelo painel ao lado dela, para o filtro ter de distinguir as duas.
  const a = await mandar(painel, ap, { tipo: 'abrir', dados: { projeto: 'projeto-x', pedido: 'PEDIDO-SECRETO-DO-PAINEL', nome: 'qa2 texto' } });
  assert.equal((await desfecho(painel, a.id, 'abrir')).estado, 'feito');
  const comandada = await ate(async () => (await painel.estado()).retrato.sessoes.find((s) => s.gerenciada === true && s.nome === 'qa2 texto'), 'sessão comandada no retrato');
  const manualNoServidor = await ate(async () => (await painel.estado()).retrato.sessoes.find((s) => s.nome === 'sessao-manual'), 'sessão aberta à mão no retrato do servidor');
  assert.notEqual(manualNoServidor.gerenciada, true);
  assert.equal(manualNoServidor.ultimaResposta ?? null, null);
  assert.equal(manualNoServidor.ultimaRespostaEm ?? null, null);
  assert.notEqual(manualNoServidor.tarefaOrigem, 'pedido');

  const bruto = JSON.stringify((await painel.estado()).retrato);
  assert.ok(!bruto.includes('RESPOSTA-SECRETA-DA-MAO'), 'resposta da sessão aberta à mão não sobe');
  assert.ok(!bruto.includes('PEDIDO-SECRETO-DA-MAO'), 'primeiro pedido da sessão aberta à mão não sobe');
  assert.ok(processosCom(comandada.chave.split(':')[1]).length >= 1, 'a sessão comandada tem o claude falso vivo');
});

// ---------------------------------------------------------------- S17: MOISES_ENCERRAR escrito no coletor.env

// Coletor como processo de verdade, lendo MOISES_CONF (coletor.env), contra o servidor local de verdade.
function coletorComoProcesso(t, pc, painel, linhasExtras) {
  const conf = path.join(pc.d, 'coletor.env');
  const linhas = [
    `MOISES_URL=${painel.url}`, `MOISES_TOKEN=${painel.token}`, `MOISES_CHAVES_ARQ=${pc.chavesArq}`, `MOISES_PROJETOS=${pc.projetosArq}`,
    'MOISES_INTERVALO_MS=300', 'MOISES_INTERVALO_RAPIDO_MS=100', 'MOISES_CONFERIR_PAINEL=0', ...linhasExtras,
  ];
  fs.writeFileSync(conf, `${linhas.join('\n')}\n`, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: pc.d, MOISES_CONF: conf, MOISES_ESTADO: pc.estado, MOISES_CONFIG_DIRS: pc.dirClaude,
    MOISES_LIMITES_ARQ: path.join(pc.d, 'limites.json'), MOISES_IDEIAS_TETO_DIA: '0',
  };
  const filho = spawn(process.execPath, [path.join(RAIZ, 'collector/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => filho.kill('SIGKILL'));
  return filho;
}

// Sessão aberta à mão: só a transcrição (sem registro de processo vivo), que o encerrar antigo recusa de formas
// diferentes conforme MOISES_ENCERRAR esteja ligado ou não.
function sessaoManual(pc, id) {
  const pastaProj = path.join(pc.dirClaude, 'projects', '-tmp-projeto-x');
  fs.mkdirSync(pastaProj, { recursive: true });
  const agora = new Date().toISOString();
  const linhas = [
    { type: 'user', timestamp: agora, cwd: pc.proj, sessionId: id, message: { role: 'user', content: 'oi' } },
    { type: 'assistant', timestamp: agora, cwd: pc.proj, sessionId: id, requestId: 'req_1', message: { id: 'msg_1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'custom-title', customTitle: 'sessao-manual', sessionId: id },
  ];
  fs.writeFileSync(path.join(pastaProj, `${id}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

for (const [rotulo, extras, esperado] of [
  ['sem a chave, o encerrar antigo segue e acusa a sessão fora do registro', [], /não está registrada como aberta/],
  ['MOISES_ENCERRAR=0 no coletor.env desliga o encerrar pelo painel', ['MOISES_ENCERRAR=0'], /Encerrar pelo painel está desligado/],
  ['MOISES_ENCERRAR_POR_HORA=0 no coletor.env vale como limite', ['MOISES_ENCERRAR_POR_HORA=0'], /Limite de 0 encerramentos por hora/],
]) {
  test(`S17: ${rotulo}`, async (t) => {
    const pc = computador();
    const painel = await subirPainel(t);
    const ap = await aparelhoAutorizado(pc);
    sessaoManual(pc, '55555555-5555-4555-8555-555555555555');
    coletorComoProcesso(t, pc, painel, extras);
    const sessao = await ate(async () => (await painel.estado()).retrato?.sessoes.find((s) => s.nome === 'sessao-manual'), 'sessão manual no retrato');
    await ate(async () => (await painel.estado()).retrato.orquestracao.aparelhos.some((a) => a.kid === ap.kid), 'aparelho anunciado');
    const r = await mandar(painel, ap, { tipo: 'encerrar', chave: sessao.chave, dados: { nome: 'qa2', visto: { projeto: sessao.projeto, nome: sessao.nome } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fim = await desfecho(painel, r.id, 'encerrar');
    assert.equal(fim.estado, 'falhou', JSON.stringify(fim));
    assert.match(fim.erro, esperado);
  });
}

// ---------------------------------------------------------------- A1: o servidor só transporta chave pública P-256 `raw`

test('POST /api/aparelho recusa chave pública que não começa por 0x04, mesmo com o kid recalculado e o ponto na curva', async (t) => {
  const painel = await subirPainel(t);
  const ap = await nav.gerarAparelho();
  const bytes = Buffer.from(ap.publica, 'base64url');
  bytes[0] = 0; // x e y continuam sendo um ponto da curva; só o prefixo do formato `raw` está errado
  const publica = bytes.toString('base64url');
  const kid = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 6);
  const r = await painel.api('/api/aparelho', { method: 'POST', body: { kid, publica, rotulo: 'prefixo errado' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.erro, /publica/);
  // O mesmo corpo com o prefixo certo é aceito: a recusa acima é pelo prefixo e por nada mais.
  const certo = await painel.api('/api/aparelho', { method: 'POST', body: { kid: ap.kid, publica: ap.publica, rotulo: 'prefixo certo' } });
  assert.equal(certo.status, 200, JSON.stringify(certo.body));
});

// ---------------------------------------------------------------- S15: agenda da conferência e chave de desligar

// Painel que só conta o que o coletor pede: serve os arquivos de public/ e `/` como index.html (ou 404, se `servir`
// for falso) e responde ao ingest sem comandos. `gets` = nomes pedidos ('' é `/`), `retratos` = retratos recebidos.
async function painelContador(t, { servir = true } = {}) {
  const gets = [];
  const retratos = [];
  const servidor = http.createServer((req, res) => {
    if (req.method === 'GET') {
      gets.push(req.url.slice(1));
      // Rodada de correção 2 (S27): o coletor também confere `/`, que a Vercel serve como index.html.
      const arq = path.join(RAIZ, 'public', req.url === '/' ? 'index.html' : req.url.slice(1));
      if (!servir || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) return res.writeHead(404).end();
      return res.writeHead(200).end(fs.readFileSync(arq));
    }
    let corpo = '';
    req.on('data', (p) => (corpo += p));
    req.on('end', () => {
      const j = JSON.parse(corpo || '{}');
      if (j.retrato) retratos.push(j.retrato);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ comandos: [], painelVistoEm: null }));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  return { url: `http://127.0.0.1:${servidor.address().port}`, token: crypto.randomBytes(32).toString('base64url'), gets, retratos };
}
// Rodada de correção 2 (S27): todos os arquivos de public/ (com as subpastas) e `/` (''), não mais os cinco fixos.
const PUBLICOS = path.join(RAIZ, 'public');
const CINCO = [
  ...fs.readdirSync(PUBLICOS, { recursive: true }).map((n) => n.split(path.sep).join('/')).filter((n) => fs.statSync(path.join(PUBLICOS, n)).isFile()),
  '',
].sort();

test('S15: a conferência do painel publicado acontece no início e só de novo depois do intervalo configurado', async (t) => {
  const pc = computador();
  await aparelhoAutorizado(pc);
  const painel = await painelContador(t);
  await iniciarColetor(t, pc, painel, { conferirPainelMs: 60_000 });
  await ate(() => painel.retratos.length >= 1, 'primeiro retrato');
  assert.deepEqual([...painel.gets].sort(), CINCO, 'todos os arquivos e `/`, uma vez, antes do primeiro envio');
  // Vários ciclos depois (200 ms de piso entre ciclos), nenhuma conferência nova.
  await espera(1200);
  assert.deepEqual([...painel.gets].sort(), CINCO);
  assert.equal(painel.retratos.at(-1).orquestracao.ativa, true);

  // Com intervalo curto, ela se repete.
  const pc2 = computador();
  await aparelhoAutorizado(pc2);
  const painel2 = await painelContador(t);
  await iniciarColetor(t, pc2, painel2, { conferirPainelMs: 300 });
  await ate(() => painel2.gets.filter((g) => g === 'app.js').length >= 3, 'conferências repetidas');
});

test('S15: MOISES_CONFERIR_PAINEL=0 no coletor.env desliga a conferência; sem a chave, painel que não serve os arquivos desliga os comandos', async (t) => {
  const pcSem = computador();
  await aparelhoAutorizado(pcSem);
  const semChave = await painelContador(t, { servir: false });
  const conf = (pc, painel, extras) => {
    const linhas = [`MOISES_URL=${painel.url}`, `MOISES_TOKEN=${painel.token}`, `MOISES_CHAVES_ARQ=${pc.chavesArq}`, `MOISES_PROJETOS=${pc.projetosArq}`, 'MOISES_INTERVALO_MS=300', 'MOISES_INTERVALO_RAPIDO_MS=100', ...extras];
    const arq = path.join(pc.d, 'coletor.env');
    fs.writeFileSync(arq, `${linhas.join('\n')}\n`, { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: pc.d, MOISES_CONF: arq, MOISES_ESTADO: pc.estado, MOISES_CONFIG_DIRS: pc.dirClaude, MOISES_LIMITES_ARQ: path.join(pc.d, 'limites.json'), MOISES_IDEIAS_TETO_DIA: '0' };
    const filho = spawn(process.execPath, [path.join(RAIZ, 'collector/index.js')], { env, stdio: 'ignore' });
    t.after(() => filho.kill('SIGKILL'));
  };
  // Controle: sem a chave, o painel que responde 404 desliga os comandos.
  conf(pcSem, semChave, []);
  const r1 = await ate(() => semChave.retratos[0], 'retrato do controle');
  assert.deepEqual([r1.orquestracao.ativa, r1.orquestracao.motivo], [false, 'painel_alterado']);

  // Com MOISES_CONFERIR_PAINEL=0, nada é baixado e os comandos ficam ligados.
  const pcCom = computador();
  await aparelhoAutorizado(pcCom);
  const comChave = await painelContador(t, { servir: false });
  conf(pcCom, comChave, ['MOISES_CONFERIR_PAINEL=0']);
  const r2 = await ate(() => comChave.retratos[0], 'retrato com a conferência desligada');
  assert.deepEqual([r2.orquestracao.ativa, r2.orquestracao.motivo], [true, null]);
  await espera(600);
  assert.deepEqual(comChave.gets, []);
});

// ---------------------------------------------------------------- tarefa 13 (painel), por leitura estática
// A prova de comportamento está no relatório (Chrome headless contra o servidor local); aqui ficam as travas que
// quebram se alguém desfizer essas decisões de interface.

const lerPublico = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');

test('painel: o pedido de permissão aparece inteiro, sem caixa com rolagem, e o sensível ou incompleto só oferece Negar', () => {
  const css = lerPublico('style.css');
  const regra = css.match(/\.entrada\s*\{([^}]*)\}/);
  assert.ok(regra, 'regra .entrada');
  assert.ok(!/max-height|overflow(-y)?\s*:\s*(auto|scroll|hidden)/.test(regra[1]), `.entrada sem altura máxima nem rolagem: ${regra[1]}`);
  const js = lerPublico('app.js');
  // "N linhas" acima do texto e o aviso do sensível com o texto do plano.
  assert.match(js, /permLinhas: \(n\) => \(n === 1 \? '1 linha' : n \+ ' linhas'\)/);
  assert.match(js, /permSensivel: ' Este pedido mexe em configuração ou chaves; aprove só no computador, ou negue\.'/);
  // Aprovar só entra na tela se o pedido é inteiro e não é sensível; nesse caso nem o clique é ligado.
  assert.match(js, /const aprovar = completo \? botao\('Aprovar'/);
  assert.match(js, /if \(aprovar && !sensivel\) botoes\.append\(aprovar\);/);
  assert.match(js, /aprovar: sensivel \? null : aprovar/);
  assert.match(js, /if \(b\.aprovar\) b\.aprovar\.addEventListener/);
});

test('painel: encerrar com o nome vazio mostra o aviso e o motivo "Comandos desligados" não se repete no cartão', () => {
  const js = lerPublico('app.js');
  assert.match(js, /erroNomeTrabalho: 'Escreva um nome para o trabalho\.'/);
  assert.match(js, /if \(!nome\) \{\s*erro\.textContent = TEXTOS\.erroNomeTrabalho;\s*campo\.focus\(\);\s*return null;/);
  // Os controles do cartão apontam para o motivo que aparece uma vez, nas ações.
  assert.match(js, /setAttribute\('aria-describedby', c\.acoes\.motivo\.id\)/);
});
