// QA do orquestrador: concorrência dos tetos e das respostas de permissão, pedido velho depois de
// interromper ou de expirar, sessão trocada, reinício do coletor com retomada, leitura de saída em
// bytes e dados lixo. Só o claude falso do projeto (test/fixtures/claude-falso.js e qa-claude-falso.js) e
// pastas temporárias: nada aqui chama o Claude Code de verdade nem toca em ~/.claude*, ~/.config/moises
// ou ~/.local/state/moises.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orquestrador } from '../collector/orquestrador.js';
import { Coletor, inicioDoProcesso } from '../collector/sessoes.js';
import { hashVisto } from '../collector/assinatura.js';
import { diaLocal } from '../collector/transcript.js';

delete process.env.MOISES_SUBIR_TEXTO;

const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
const FALSO_UTF8 = fileURLToPath(new URL('./fixtures/qa-claude-falso.js', import.meta.url));
// Só dígitos no nome: o caminho do registro vai em argsExtra, que o construtor filtra por palavras.
const BASE = path.join(os.tmpdir(), `moises-qa-orq-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

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
const processosCom = (trecho) => spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(trecho) && !l.includes('ps -eo'));

// Duas contas, dois projetos e um orquestrador com o claude falso. Cada caso tem a própria pasta.
function preparar(t, opcoes = {}, { bin = FALSO, nomeRegistro = 'registro.json' } = {}) {
  const raiz = path.join(BASE, `caso-${++casos}`);
  const principal = path.join(raiz, '.claude');
  const conta2 = path.join(raiz, '.claude-conta2');
  for (const d of [principal, conta2]) for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(d, s), { recursive: true });
  const proj = path.join(raiz, 'projeto-a');
  const projB = path.join(raiz, 'projeto-b');
  fs.mkdirSync(proj);
  fs.mkdirSync(projB);
  const registro = path.join(raiz, nomeRegistro);
  const pastaEstado = path.join(raiz, 'estado');
  const coletor = new Coletor({ dirs: [principal, conta2] });
  const listaProjetos = { 'projeto-a': proj, 'projeto-b': projB };
  const criar = (extra = {}) =>
    new Orquestrador({
      coletor,
      projetos: () => listaProjetos,
      pastaEstado,
      claudeBin: bin,
      argsExtra: [`--system-prompt=registro:${registro}`],
      esperaAberturaMs: 5000,
      esperaRetomarMs: 200,
      ...opcoes,
      ...extra,
    });
  const orq = criar();
  t.after(() => orq.fechar());
  const entrada = () => {
    try {
      return fs.readFileSync(`${registro}.entrada`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const publicada = (chave, o = orq) => o.aplicar(coletor.retrato()).sessoes.find((s) => s.chave === chave);
  return { raiz, principal, conta2, proj, projB, registro, pastaEstado, coletor, orq, criar, entrada, publicada, listaProjetos };
}

async function abrir(ctx, extra = {}, orq = ctx.orq) {
  const r = await orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'Olá, comece', ...extra });
  assert.equal(r.ok, true, r.erro);
  await ate(() => ctx.publicada(r.chaveNova, orq)?.estado === 'esperando_mensagem', 'sessão aberta esperar mensagem');
  return r.chaveNova;
}
const vistoDe = (ctx, chave, orq = ctx.orq) => {
  const s = ctx.publicada(chave, orq);
  return { projeto: s.projeto, nome: s.nome ?? null };
};
const mensagem = (ctx, chave, texto, orq = ctx.orq) => orq.executar(cmd('mensagem', chave), { texto, visto: vistoDe(ctx, chave, orq) });
const pedidoPendente = (ctx, chave, n = 1, orq = ctx.orq) =>
  ate(() => {
    const s = ctx.publicada(chave, orq);
    return s?.estado === 'esperando_permissao' && s.permissoes.length >= n && s.permissoes;
  }, 'pedido de permissão aparecer');
const responder = (ctx, chave, p, decisao, orq = ctx.orq, visto = vistoDe(ctx, chave, orq)) =>
  orq.executar(cmd('permissao', chave), { pedido: p.pedido, decisao, ...(decisao === 'aprovar' ? { vistoHash: hashVisto(p.ferramenta, p.entrada) } : {}), visto });
const respostas = (ctx) => ctx.entrada().filter((l) => l.type === 'control_response');

// Sessão que o coletor conhece pelo transcript: o dono pode fixar o id e o nome.
function transcrito(ctx, dir, { id = crypto.randomUUID(), cwd, nome = null }) {
  const pasta = path.join(dir, 'projects', '-sessao-de-teste');
  fs.mkdirSync(pasta, { recursive: true });
  const linhas = [{ type: 'user', timestamp: new Date().toISOString(), cwd, message: { role: 'user', content: 'Primeiro pedido' } }];
  if (nome) linhas.push({ type: 'custom-title', customTitle: nome });
  fs.writeFileSync(path.join(pasta, `${id}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  ctx.coletor.reindexar();
  return id;
}

// ---------------------------------------------------------------- tetos sob concorrência

test('CA6: três abrir ao mesmo tempo com teto de 1 sessão abrem só uma, e só um filho nasce', async (t) => {
  const ctx = preparar(t, { maxSessoes: 1 });
  const rs = await Promise.all([1, 2, 3].map(() => ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' })));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  for (const r of rs.filter((x) => !x.ok)) assert.match(r.erro, /Já há 1 sessões comandadas abertas/);
  assert.equal(ctx.orq.abertas(), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.pastaEstado, 'abrir.json'), 'utf8')).n, 1, 'só a abertura que passou foi contada');
});

test('CA6: três abrir ao mesmo tempo com teto diário de 2 abrem só duas, e o teto vale também depois de reiniciar o orquestrador', async (t) => {
  const ctx = preparar(t, { maxAbrirPorDia: 2 });
  const rs = await Promise.all([1, 2, 3].map(() => ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' })));
  assert.equal(rs.filter((r) => r.ok).length, 2, JSON.stringify(rs));
  assert.match(rs.find((r) => !r.ok).erro, /Limite de 2 aberturas e retomadas pelo painel hoje/);
  const reiniciado = ctx.criar();
  t.after(() => reiniciado.fechar());
  const de_novo = await reiniciado.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' });
  assert.equal(de_novo.ok, false, 'o contador do dia está no disco');
  assert.match(de_novo.erro, /Limite de 2/);
});

test('CA6: contador de aberturas do dia anterior não vale hoje, e arquivo corrompido conta do zero sem lançar', async (t) => {
  const agora = Date.parse('2026-11-11T12:00:00');
  const relogio = { agora };
  const ctx = preparar(t, { maxAbrirPorDia: 1, agora: () => relogio.agora });
  const cmdAbrir = () => ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' });
  assert.equal((await cmdAbrir()).ok, true);
  assert.equal((await cmdAbrir()).ok, false);
  relogio.agora = Date.parse('2026-11-12T08:00:00'); // outro dia local
  assert.notEqual(diaLocal(relogio.agora), diaLocal(agora));
  const outroDia = await cmdAbrir();
  assert.equal(outroDia.ok, true, outroDia.erro);
  // Arquivo corrompido conta do zero (mesmo comportamento da primeira abertura), sem lançar.
  fs.writeFileSync(path.join(ctx.pastaEstado, 'abrir.json'), '{lixo');
  const ctx2 = ctx.orq.lerContagem();
  assert.equal(ctx2.n, 0);
});

// ---------------------------------------------------------------- foco 2: pedido de permissão

test('foco 2: aprovar e negar ao mesmo tempo o mesmo pedido respondem uma vez só ao filho', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx);
  await mensagem(ctx, chave, 'permissao:echo oi');
  const [p] = await pedidoPendente(ctx, chave);
  const [a, b, c] = await Promise.all([responder(ctx, chave, p, 'aprovar'), responder(ctx, chave, p, 'negar'), responder(ctx, chave, p, 'aprovar')]);
  assert.deepEqual([a.ok, b.ok, c.ok].filter(Boolean).length, 1, JSON.stringify([a, b, c]));
  for (const r of [a, b, c].filter((x) => !x.ok)) assert.equal(r.erro, 'Este pedido de permissão não está mais pendente.');
  await ate(() => ctx.publicada(chave).estado === 'esperando_mensagem', 'turno terminar');
  assert.equal(respostas(ctx).filter((l) => l.response.request_id === p.pedido).length, 1);
});

test('foco 2: depois de interromper, o pedido antigo não pode mais ser aprovado e nada é escrito no filho', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx);
  await mensagem(ctx, chave, 'permissao:rm -rf /tmp/algo');
  const [p] = await pedidoPendente(ctx, chave);
  const i = await ctx.orq.executar(cmd('interromper', chave), { visto: vistoDe(ctx, chave) });
  assert.equal(i.ok, true);
  // Na hora, antes de o filho confirmar o fim do turno: o pedido já não vale.
  assert.deepEqual(ctx.publicada(chave).permissoes, []);
  const aprovar = await responder(ctx, chave, p, 'aprovar');
  assert.equal(aprovar.ok, false);
  assert.equal(aprovar.erro, 'Este pedido de permissão não está mais pendente.');
  await ate(() => ctx.publicada(chave).estado === 'esperando_mensagem', 'sessão voltar a esperar mensagem');
  // Correção final (CR2): o pedido interrompido recebe só a negativa do coletor, nunca uma aprovação.
  assert.deepEqual(
    respostas(ctx).map((l) => l.response),
    [{ subtype: 'success', request_id: p.pedido, response: { behavior: 'deny', message: 'Interrompido pelo painel.' } }],
    'só a negativa da interrupção chegou ao filho',
  );
});

test('foco 2: aprovar depois do prazo, mesmo antes do temporizador disparar, nega o pedido e não aprova', async (t) => {
  const relogio = { agora: Date.now() };
  const ctx = preparar(t, { permissaoExpiraMs: 60_000, agora: () => relogio.agora });
  const chave = await abrir(ctx);
  await mensagem(ctx, chave, 'permissao:echo oi');
  const [p] = await pedidoPendente(ctx, chave);
  relogio.agora += 60_001;
  const r = await responder(ctx, chave, p, 'aprovar');
  assert.equal(r.ok, false);
  assert.equal(r.erro, 'Este pedido de permissão não está mais pendente.');
  const [resposta] = await ate(() => {
    const x = respostas(ctx);
    return x.length && x;
  }, 'negação automática chegar ao filho');
  assert.equal(resposta.response.response.behavior, 'deny');
  assert.equal(resposta.response.response.message, 'Sem resposta do painel a tempo.');
  assert.equal(respostas(ctx).length, 1);
});

test('foco 2: o pedido de uma sessão não pode ser respondido pela chave de outra', async (t) => {
  const ctx = preparar(t);
  const a = await abrir(ctx, { nome: 'sessao-a' });
  const b = await abrir(ctx, { nome: 'sessao-b' });
  await mensagem(ctx, b, 'permissao:echo da-b');
  const [pedidoDaB] = await pedidoPendente(ctx, b);
  assert.equal(pedidoDaB.pedido, 'req_1'); // o mesmo id que A usaria
  const cruzado = await responder(ctx, a, pedidoDaB, 'negar');
  assert.equal(cruzado.ok, false);
  assert.equal(cruzado.erro, 'Este pedido de permissão não está mais pendente.');
  // O visto de A não serve para agir em B.
  const visto = await ctx.orq.executar(cmd('permissao', b), { pedido: pedidoDaB.pedido, decisao: 'negar', visto: vistoDe(ctx, a) });
  assert.equal(visto.erro, 'A sessão mudou desde que você abriu o painel; atualize e tente de novo.');
  assert.equal(ctx.publicada(b).permissoes.length, 1, 'o pedido de B continua pendente');
  assert.equal((await responder(ctx, b, pedidoDaB, 'negar')).ok, true);
});

test('foco 2: dois pedidos no mesmo turno são independentes; responder o segundo não mexe no primeiro', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx);
  await mensagem(ctx, chave, 'permissoes:echo primeiro;;echo segundo');
  const pedidos = await pedidoPendente(ctx, chave, 2);
  const [um, dois] = pedidos;
  assert.deepEqual([um.entrada, dois.entrada], ['echo primeiro', 'echo segundo']);
  assert.equal((await responder(ctx, chave, dois, 'aprovar')).ok, true);
  const restante = ctx.publicada(chave);
  assert.equal(restante.estado, 'esperando_permissao');
  assert.deepEqual(restante.permissoes.map((x) => x.pedido), [um.pedido]);
  assert.equal((await responder(ctx, chave, um, 'negar')).ok, true);
  await ate(() => ctx.publicada(chave).estado === 'esperando_mensagem', 'turno terminar');
  assert.deepEqual(respostas(ctx).map((l) => [l.response.request_id, l.response.response.behavior]), [[dois.pedido, 'allow'], [um.pedido, 'deny']]);
});

// ---------------------------------------------------------------- foco 3: reinício com sessões abertas

test('foco 3: com o coletor reiniciado, o filho morre, a sessão aparece encerrada e retomável, e Retomar abre com --resume e o mesmo id', async (t) => {
  const ctx = preparar(t);
  const chave = await abrir(ctx, { nome: 'qa-reinicio' });
  const id = chave.split(':')[1];
  assert.equal(processosCom(`--session-id=${id}`).length, 1);
  // O Claude Code grava o transcript da sessão no primeiro turno; aqui, à mão.
  transcrito(ctx, ctx.principal, { id, cwd: ctx.proj, nome: 'qa-reinicio' });

  await ctx.orq.fechar(); // o serviço parou
  await ate(() => processosCom(`--session-id=${id}`).length === 0, 'filho morrer junto com o coletor');
  const depois = ctx.criar(); // o serviço voltou
  t.after(() => depois.fechar());
  assert.equal(depois.abertas(), 0);
  const s = ctx.publicada(chave, depois);
  assert.equal(s.estado, 'encerrada');
  assert.equal(s.gerenciada, false);
  assert.equal(s.retomavel, true);
  assert.equal(s.nome, 'qa-reinicio');
  // Sem retomar de verdade, nada de mensagem para sessão que não é comandada agora.
  const semRetomar = await depois.executar(cmd('mensagem', chave), { texto: 'oi', visto: { projeto: s.projeto, nome: s.nome } });
  assert.match(semRetomar.erro, /não foi aberta pelo Moisés/);

  const r = await depois.executar(cmd('retomar', chave), { visto: { projeto: s.projeto, nome: s.nome } });
  assert.equal(r.ok, true, r.erro);
  assert.equal(processosCom(`--resume=${id}`).length, 1);
  assert.equal(ctx.publicada(chave, depois).gerenciada, true);
  assert.equal((await mensagem(ctx, chave, 'estou de volta', depois)).ok, true);
  await ate(() => ctx.publicada(chave, depois).estado === 'esperando_mensagem', 'resposta depois de retomar');
  assert.ok(ctx.entrada().some((l) => l.type === 'user' && JSON.stringify(l).includes('estou de volta')));
  await depois.fechar();
  assert.deepEqual(processosCom(`--resume=${id}`), []);
});

test('depois de fechar(), nada novo abre e nenhum filho nasce', async (t) => {
  const ctx = preparar(t);
  await abrir(ctx);
  await ctx.orq.fechar();
  const r = await ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /encerrando/);
  assert.equal(ctx.orq.abertas(), 0);
});

test('CA7: Retomar só vale para a pasta da lista ou worktree dela; vizinho com o mesmo prefixo, ".." e atalho para fora não passam', async (t) => {
  const ctx = preparar(t);
  const vizinho = `${ctx.proj}-vizinho`;
  const fora = path.join(ctx.raiz, 'fora');
  const worktrees = path.join(ctx.proj, '.claude', 'worktrees');
  fs.mkdirSync(vizinho);
  fs.mkdirSync(fora);
  fs.mkdirSync(path.join(worktrees, 'bom'), { recursive: true });
  fs.symlinkSync(fora, path.join(worktrees, 'atalho'));
  const tentativas = {
    projeto: [ctx.proj, true],
    worktree: [path.join(worktrees, 'bom'), true],
    vizinho: [vizinho, false],
    acima: [path.join(worktrees, '..', '..', '..'), false],
    atalho: [path.join(worktrees, 'atalho'), false],
    barra: [`${ctx.proj}/../projeto-b/../fora`, false],
    relativo: ['projeto-a', false],
  };
  for (const [nome, [cwd, deve]] of Object.entries(tentativas)) {
    const id = transcrito(ctx, ctx.principal, { cwd, nome: `qa-${nome}` });
    const s = ctx.publicada(`principal:${id}`);
    assert.equal(s.estado, 'encerrada', nome);
    assert.equal(s.retomavel, deve, `${nome}: retomavel`);
    const r = await ctx.orq.executar(cmd('retomar', `principal:${id}`), { visto: { projeto: s.projeto, nome: s.nome } });
    assert.equal(r.ok, deve, `${nome}: ${r.erro}`);
    if (!deve) assert.match(r.erro, /A pasta da sessão não está na lista de projetos/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.pastaEstado, 'abrir.json'), 'utf8')).n, 2, 'só as duas retomadas permitidas foram contadas');
});

// ---------------------------------------------------------------- foco 4: saída do filho

// Rodada 2: comando Bash com caractere fora de ASCII passou a ser sensível (achado S26) e só se nega pelo painel.
test('foco 4: linha de saída com emoji partida no meio dos bytes é remontada e o pedido aparece inteiro (e sensível, só negar)', async (t) => {
  const ctx = preparar(t, {}, { bin: FALSO_UTF8, nomeRegistro: 'registro-utf8.json' });
  const r = await ctx.orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'olá' });
  assert.equal(r.ok, true, r.erro);
  const [p] = await pedidoPendente(ctx, r.chaveNova);
  assert.equal(p.entrada, 'echo 😀😀😀 ação ✓ 日本語');
  assert.equal(p.completo, true);
  assert.equal(p.sensivel, true);
  assert.ok(!p.entrada.includes('�'));
  const aprovado = await responder(ctx, r.chaveNova, p, 'aprovar');
  assert.equal(aprovado.ok, false);
  const negado = await responder(ctx, r.chaveNova, p, 'negar');
  assert.equal(negado.ok, true, negado.erro);
  await ate(() => respostas(ctx).length === 1, 'resposta chegar ao filho');
  assert.equal(respostas(ctx)[0].response.response.behavior, 'deny');
});

test('executar nunca lança nem abre processo com dados lixo, em nenhum verbo', async (t) => {
  const ctx = preparar(t);
  const chaves = [null, 'principal:0123abcd-4567-89ab-cdef-0123456789ab', 'conta-inexistente:0123abcd-4567-89ab-cdef-0123456789ab', '../../etc/passwd', 7, {}];
  const dadosLixo = [
    null, undefined, 0, '', 'texto', [], [1, 2], () => 1, {},
    { visto: 5 }, { visto: { projeto: {}, nome: [] } }, { texto: 5, visto: { projeto: 'projeto-a', nome: null } },
    { projeto: ['projeto-a'], pedido: { toString: () => 'x' } }, { projeto: 'projeto-a', pedido: 'a'.repeat(6001) },
    { projeto: 'projeto-a', pedido: 'ok', modelo: 'opus; rm -rf /' }, { projeto: 'projeto-a', pedido: 'ok', modoPermissao: 'bypassPermissions' },
    { projeto: 'projeto-a', pedido: 'ok', nome: '--dangerously-skip-permissions' }, { projeto: 'projeto-a', pedido: 'ok', nome: 'x\ny' },
    { projeto: 'projeto-a', pedido: 'ok', conta: '../x' }, { projeto: 'projeto-a', pedido: 'ok', worktree: 'sim' },
    { pedido: 'x', decisao: 'aprovar' }, { pedido: 'req_1\n', decisao: 'negar', visto: { projeto: 'p', nome: null } },
  ];
  let chamadas = 0;
  for (const tipo of ['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar', 'apagar', undefined]) {
    for (const chave of chaves) {
      for (const dados of dadosLixo) {
        chamadas++;
        const r = await ctx.orq.executar({ ...cmd('x'), tipo, chave }, dados);
        assert.equal(r.ok, false, `${tipo} ${String(chave)} ${JSON.stringify(dados)}`);
        assert.equal(typeof r.erro, 'string');
      }
    }
  }
  assert.ok(chamadas > 1000);
  assert.equal(ctx.orq.abertas(), 0);
  assert.equal(fs.existsSync(ctx.registro), false, 'nenhum filho chegou a ser iniciado');
});

// ---------------------------------------------------------------- CA5: estado ao vivo

test('CA5: estadoDe nas fronteiras: 15 min parado, status desconhecido, waitingFor de permissão, processo morto', async () => {
  const { estadoDe, OCIOSA_APOS_MS } = await import('../collector/sessoes.js');
  const agora = 1_794_387_000_000;
  const reg = (extra) => ({ status: 'idle', statusUpdatedAt: agora, ...extra });
  assert.equal(OCIOSA_APOS_MS, 15 * 60_000);
  assert.equal(estadoDe(reg({ statusUpdatedAt: agora - OCIOSA_APOS_MS }), true, agora), 'esperando_mensagem', 'exatamente 15 min ainda não é parada');
  assert.equal(estadoDe(reg({ statusUpdatedAt: agora - OCIOSA_APOS_MS - 1 }), true, agora), 'parada');
  assert.equal(estadoDe(reg({ status: undefined, statusUpdatedAt: undefined, updatedAt: agora - OCIOSA_APOS_MS - 1 }), true, agora), 'parada');
  assert.equal(estadoDe({}, true, agora), 'parada', 'registro sem horário nenhum conta como parado');
  for (const status of ['busy', 'shell', 'running', 'BUSY']) assert.equal(estadoDe(reg({ status }), true, agora), 'trabalhando', status);
  for (const waitingFor of ['permission', 'sandbox request', 'worker', 'PERMISSION prompt']) assert.equal(estadoDe(reg({ status: 'waiting', waitingFor }), true, agora), 'esperando_permissao', waitingFor);
  for (const waitingFor of ['input', 'user', undefined, null]) assert.equal(estadoDe(reg({ status: 'waiting', waitingFor }), true, agora), 'esperando_mensagem', String(waitingFor));
  // Processo morto vence qualquer status, inclusive busy e waiting de permissão.
  for (const status of ['busy', 'waiting', 'idle']) assert.equal(estadoDe(reg({ status, waitingFor: 'permission' }), false, agora), 'encerrada', status);
});
