// Rodada de correção 2 (dev A): configuração do coletor que falha para o lado seguro (S28, SE-M2, SE-M7),
// mesma regra de caminhos no coletor e no script (SE-M4), pareamento sem a impressão digital na tela do
// computador (SE-M3), --autorizar que recusa com o painel divergente (A1-resto) e a CSP com worker-src (S27).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuracao, caminhosDoColetor } from '../collector/index.js';
import { FERRAMENTAS_PADRAO } from '../collector/orquestrador.js';
import { aparelho as novoAparelho } from './fixtures/aparelho.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const CONFIGURAR = path.join(RAIZ, 'scripts/configurar-comandos.js');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-corr2a-conf-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));
const DIVERGENTE = 'o painel publicado não confere com este computador; não autorize aparelhos até resolver (veja o log do coletor)';

let casos = 0;
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

// Lê a configuração de um coletor.env escrito com `linhas`, num ambiente falso (nunca o process.env real).
function ler(linhas, env = {}) {
  const d = novaPasta();
  const arq = path.join(d, 'coletor.env');
  fs.writeFileSync(arq, `${linhas.join('\n')}\n`, { mode: 0o600 });
  const avisos = [];
  const amb = { MOISES_CONF: arq, ...env };
  const conf = configuracao({ env: amb, home: path.join(d, 'home'), avisar: (m) => avisos.push(m) });
  return { conf, env: amb, avisos, texto: avisos.join('\n'), d };
}

// ---------------------------------------------------------------- S28: chaves de desligar

test('S28: comentário, export e aspas no coletor.env desligam como deveriam', () => {
  const { conf, env, avisos } = ler([
    'MOISES_COMANDOS=0   # já',
    'export MOISES_SUBIR_TEXTO=desligado',
    'MOISES_ENCERRAR="0"',
    "  MOISES_CONFERIR_PAINEL = 'off'  # só no teste",
  ]);
  assert.equal(env.MOISES_COMANDOS, '0');
  assert.equal(env.MOISES_SUBIR_TEXTO, '0');
  assert.equal(env.MOISES_ENCERRAR, '0');
  assert.equal(env.MOISES_CONFERIR_PAINEL, '0');
  assert.equal(conf.conferirPainel, false);
  assert.deepEqual(avisos, [], 'valores reconhecidos não geram aviso');
});

test('S28: todos os valores reconhecidos, em maiúsculas ou minúsculas, viram 0 ou 1', () => {
  for (const v of ['0', 'false', 'off', 'nao', 'não', 'desligado', 'NÃO', 'Off', ' FALSE ']) {
    const { env, avisos } = ler([`MOISES_COMANDOS=${v}`]);
    assert.equal(env.MOISES_COMANDOS, '0', v);
    assert.deepEqual(avisos, [], v);
  }
  for (const v of ['1', 'true', 'on', 'sim', 'ligado', 'SIM', 'Ligado']) {
    const { env, avisos } = ler([`MOISES_COMANDOS=${v}`]);
    assert.equal(env.MOISES_COMANDOS, '1', v);
    assert.deepEqual(avisos, [], v);
  }
});

test('S28: valor estranho desliga, com aviso que cita a chave e não o valor', () => {
  for (const v of ['talvez', 'desligar', '00', 'no', '"0', '0 0']) {
    const { env, texto, conf } = ler([`MOISES_COMANDOS=${v}`, `MOISES_SUBIR_TEXTO=${v}`, `MOISES_CONFERIR_PAINEL=${v}`]);
    assert.equal(env.MOISES_COMANDOS, '0', v);
    assert.equal(env.MOISES_SUBIR_TEXTO, '0', v);
    assert.equal(conf.conferirPainel, false, v);
    assert.match(texto, /MOISES_COMANDOS/);
    assert.match(texto, /MOISES_SUBIR_TEXTO/);
    if (v.length > 2) assert.ok(!texto.includes(v), `o aviso não repete o valor: ${v}`);
  }
  // No ambiente do processo também.
  const r = ler([], { MOISES_ENCERRAR: 'quase' });
  assert.equal(r.env.MOISES_ENCERRAR, '0');
  assert.match(r.texto, /MOISES_ENCERRAR/);
  assert.ok(!r.texto.includes('quase'));
});

test('S28: basta uma fonte dizer desligado; o ambiente não religa o arquivo, nem o arquivo o ambiente', () => {
  assert.equal(ler(['MOISES_COMANDOS=0'], { MOISES_COMANDOS: '1' }).env.MOISES_COMANDOS, '0', 'ambiente 1, arquivo 0');
  assert.equal(ler(['MOISES_SUBIR_TEXTO=sim'], { MOISES_SUBIR_TEXTO: '0' }).env.MOISES_SUBIR_TEXTO, '0', 'ambiente 0, arquivo sim');
  assert.equal(ler(['MOISES_ENCERRAR=ligado'], { MOISES_ENCERRAR: 'on' }).env.MOISES_ENCERRAR, '1');
  assert.equal(ler([], { MOISES_COMANDOS: 'ligado' }).env.MOISES_COMANDOS, '1', 'forma canônica');
  const nenhum = ler([]);
  assert.equal(nenhum.env.MOISES_COMANDOS, undefined, 'sem nenhuma fonte, vale o padrão (ligado)');
  assert.equal(nenhum.conf.conferirPainel, true);
  // Valor vazio é o mesmo que ausente.
  assert.equal(ler(['MOISES_COMANDOS='], { MOISES_SUBIR_TEXTO: '' }).env.MOISES_COMANDOS, undefined);
});

test('S28: chave MOISES_* desconhecida ou linha que não se entende no coletor.env geram aviso com o nome, sem o valor', () => {
  const { texto, env } = ler([
    '# comentário de linha inteira',
    '',
    'MOISES_COMANDO=0', // erro de digitação
    'moises_comandos=0',
    'MOISES_SUBIR_TEXTO: 0',
    'OUTRA_COISA=valor-qualquer',
  ]);
  assert.match(texto, /MOISES_COMANDO\b/);
  assert.match(texto, /moises_comandos/);
  assert.match(texto, /linha 5/);
  assert.ok(!texto.includes('OUTRA_COISA'), 'chave que não é do Moisés não é da conta do coletor');
  assert.ok(!texto.includes('valor-qualquer'));
  assert.equal(env.MOISES_COMANDOS, undefined);
});

test('S28: aspas e comentário valem também para URL e token', () => {
  const { conf, avisos } = ler(['MOISES_URL="https://painel.example"  # o painel', "export MOISES_TOKEN='abc-def'", 'MOISES_SO_PREFIXO=teste-#1']);
  assert.equal(conf.url, 'https://painel.example');
  assert.equal(conf.token, 'abc-def');
  assert.equal(conf.soPrefixo, 'teste-#1', '# sem espaço antes não é comentário');
  assert.deepEqual(avisos, []);
});

// ---------------------------------------------------------------- SE-M2: MOISES_FERRAMENTAS só reduz

test('SE-M2: MOISES_FERRAMENTAS só reduz a lista padrão', () => {
  const r = ler(['MOISES_FERRAMENTAS=Bash,WebFetch,Task']);
  assert.deepEqual(r.conf.ferramentas, ['Bash']);
  assert.match(r.texto, /MOISES_FERRAMENTAS/);
  assert.match(r.texto, /WebFetch/);
  assert.match(r.texto, /Task/);
  // Ordem e repetição não importam; espaços são aparados.
  assert.deepEqual(ler(['MOISES_FERRAMENTAS= Grep , Read,Grep']).conf.ferramentas, ['Read', 'Grep']);
  // Lista que fica vazia volta à padrão, com aviso.
  const vazia = ler(['MOISES_FERRAMENTAS=WebFetch,Task,mcp__x']);
  assert.deepEqual(vazia.conf.ferramentas, FERRAMENTAS_PADRAO);
  assert.match(vazia.texto, /padrão/);
  // Sem a variável: a padrão, sem aviso.
  const sem = ler([]);
  assert.deepEqual(sem.conf.ferramentas, FERRAMENTAS_PADRAO);
  assert.deepEqual(sem.avisos, []);
});

// ---------------------------------------------------------------- SE-M7: números

test('SE-M7: vírgula decimal vale; teto inválido vale o limite mais restritivo; intervalo inválido volta ao padrão', () => {
  assert.equal(ler(['MOISES_TETO_SESSAO_USD=0,50']).conf.tetoSessaoUsd, 0.5);
  assert.equal(ler(['MOISES_TETO_SESSAO_USD=2.5']).conf.tetoSessaoUsd, 2.5);
  const casos = [
    ['MOISES_TETO_SESSAO_USD', 'muito', 'tetoSessaoUsd', 0.01],
    ['MOISES_TETO_SESSAO_USD', '500', 'tetoSessaoUsd', 0.01],
    ['MOISES_MAX_SESSOES', '99', 'maxSessoes', 0],
    ['MOISES_MAX_SESSOES', '2,5', 'maxSessoes', 0],
    ['MOISES_MAX_ABRIR_DIA', '-1', 'maxAbrirPorDia', 0],
    ['MOISES_PERMISSAO_EXPIRA_MIN', 'abc', 'permissaoExpiraMs', 60_000],
  ];
  for (const [chave, valor, campo, esperado] of casos) {
    const r = ler([`${chave}=${valor}`]);
    assert.equal(r.conf[campo], esperado, `${chave}=${valor}`);
    assert.match(r.texto, new RegExp(`${chave}.*mais restritivo`), chave);
    assert.ok(!r.texto.includes(valor === '2,5' ? '2,5' : valor), `o aviso não repete o valor de ${chave}`);
  }
  // Encerrar por hora é teto e vai para process.env (encerrar.js o lê de lá a cada uso).
  const enc = ler(['MOISES_ENCERRAR_POR_HORA=muitos']);
  assert.equal(enc.env.MOISES_ENCERRAR_POR_HORA, '0');
  assert.match(enc.texto, /MOISES_ENCERRAR_POR_HORA/);
  assert.equal(ler(['MOISES_ENCERRAR_POR_HORA=3']).env.MOISES_ENCERRAR_POR_HORA, '3');
  assert.equal(ler([]).env.MOISES_ENCERRAR_POR_HORA, undefined, 'sem a variável, vale o padrão de encerrar.js');
  // Zero sessões é aceito: o painel não abre nem retoma.
  const zero = ler(['MOISES_MAX_SESSOES=0']);
  assert.equal(zero.conf.maxSessoes, 0);
  assert.deepEqual(zero.avisos, []);
  // Intervalos continuam voltando ao padrão.
  const intervalo = ler(['MOISES_INTERVALO_MS=abc', 'MOISES_INTERVALO_RAPIDO_MS=1,5']);
  assert.equal(intervalo.conf.intervaloMs, 20_000);
  assert.equal(intervalo.conf.intervaloRapidoMs, 3_000);
  assert.match(intervalo.texto, /MOISES_INTERVALO_MS.*padrão/);
  // Valores válidos, inclusive com espaço em volta.
  const ok = ler(['MOISES_MAX_SESSOES= 2 ', 'MOISES_MAX_ABRIR_DIA=10', 'MOISES_PERMISSAO_EXPIRA_MIN=5', 'MOISES_INTERVALO_MS=1000']);
  assert.deepEqual([ok.conf.maxSessoes, ok.conf.maxAbrirPorDia, ok.conf.permissaoExpiraMs, ok.conf.intervaloMs], [2, 10, 300_000, 1000]);
  assert.deepEqual(ok.avisos, []);
});

// ---------------------------------------------------------------- SE-M4: mesma regra de caminhos

test('SE-M4: caminhosDoColetor e configuracao usam a mesma regra, inclusive MOISES_CHAVES_ARQ e MOISES_ESTADO do coletor.env', () => {
  const d = novaPasta();
  const home = path.join(d, 'home');
  const pastaConf = path.join(d, 'conf');
  fs.mkdirSync(pastaConf, { recursive: true });
  // Padrões: tudo na pasta de configuração (MOISES_PASTA_CONF) e o estado em ~/.local/state/moises.
  const padrao = caminhosDoColetor({ env: { MOISES_PASTA_CONF: pastaConf }, home, avisar: () => {} });
  assert.deepEqual(
    [padrao.arquivoConf, padrao.chavesArq, padrao.projetosArq, padrao.pastaEstado],
    [path.join(pastaConf, 'coletor.env'), path.join(pastaConf, 'chaves-comandos.json'), path.join(pastaConf, 'projetos.json'), path.join(home, '.local/state/moises')],
  );
  const semNada = caminhosDoColetor({ env: {}, home, avisar: () => {} });
  assert.equal(semNada.chavesArq, path.join(home, '.config/moises/chaves-comandos.json'));
  // Do coletor.env, com ~/ expandido.
  fs.writeFileSync(path.join(pastaConf, 'coletor.env'), [
    `MOISES_CHAVES_ARQ="${path.join(d, 'outra', 'chaves.json')}"`,
    'MOISES_ESTADO=~/estado-do-coletor',
    'MOISES_PROJETOS=relativo/projetos.json',
  ].join('\n'));
  const avisos = [];
  const env = { MOISES_PASTA_CONF: pastaConf };
  const c = caminhosDoColetor({ env, home, avisar: (m) => avisos.push(m) });
  assert.equal(c.chavesArq, path.join(d, 'outra', 'chaves.json'));
  assert.equal(c.pastaEstado, path.join(home, 'estado-do-coletor'));
  // Caminho relativo dependeria da pasta de onde se roda: vale o padrão, com aviso.
  assert.equal(c.projetosArq, path.join(pastaConf, 'projetos.json'));
  assert.match(avisos.join('\n'), /MOISES_PROJETOS/);
  // configuracao() chega aos mesmos caminhos.
  const conf = configuracao({ env: { ...env }, home, avisar: () => {} });
  assert.deepEqual([conf.chavesArq, conf.projetosArq, conf.pastaEstado], [c.chavesArq, c.projetosArq, c.pastaEstado]);
  // O ambiente vale por cima do arquivo; MOISES_CONF escolhe outro coletor.env.
  const doAmbiente = caminhosDoColetor({ env: { ...env, MOISES_ESTADO: path.join(d, 'e2') }, home, avisar: () => {} });
  assert.equal(doAmbiente.pastaEstado, path.join(d, 'e2'));
  const outroConf = path.join(d, 'outro.env');
  fs.writeFileSync(outroConf, `MOISES_CHAVES_ARQ=${path.join(d, 'c3.json')}\n`);
  assert.equal(caminhosDoColetor({ env: { ...env, MOISES_CONF: outroConf }, home, avisar: () => {} }).chavesArq, path.join(d, 'c3.json'));
});

// ---------------------------------------------------------------- script: pastas do caso

// Pasta de configuração com coletor.env, pasta de estado e o script rodando só nelas.
function computador({ linhasConf = [], extraEnv = {} } = {}) {
  const d = novaPasta();
  const conf = path.join(d, 'conf');
  const home = path.join(d, 'home');
  const estado = path.join(d, 'estado');
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(home);
  fs.mkdirSync(estado, { mode: 0o700 });
  fs.writeFileSync(path.join(conf, 'coletor.env'), ['MOISES_URL=https://falso.example', 'MOISES_TOKEN=token-falso', ...linhasConf].join('\n') + '\n', { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: home, MOISES_PASTA_CONF: conf, MOISES_ESTADO: estado, ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const script = (...args) => spawnSync(process.execPath, [CONFIGURAR, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const pedidos = (pasta, lista) => fs.writeFileSync(path.join(pasta, 'aparelhos-pedidos.json'), JSON.stringify(lista), { mode: 0o600 });
  const conferencia = (pasta, json) => fs.writeFileSync(path.join(pasta, 'painel-conferencia.json'), JSON.stringify(json), { mode: 0o600 });
  return { d, conf, home, estado, script, pedidos, conferencia, chavesArq: path.join(conf, 'chaves-comandos.json') };
}
const pedidoDe = (ap, criadoEm = Date.now()) => ({ kid: ap.kid, publica: ap.publica, rotulo: ap.rotulo, criadoEm });

// ---------------------------------------------------------------- SE-M3: --pedidos sem a impressão

test('SE-M3: --pedidos mostra kid, rótulo e horário, nunca a impressão digital, e avisa de rótulo repetido', () => {
  const c = computador();
  const a = novoAparelho(null, 'celular');
  const b = novoAparelho(null, 'tablet');
  c.pedidos(c.estado, [pedidoDe(a), pedidoDe(b)]);
  const r = c.script('--pedidos');
  assert.equal(r.status, 0, r.stderr);
  const saida = r.stdout + r.stderr;
  for (const ap of [a, b]) {
    const linha = r.stdout.split('\n').find((l) => l.includes(ap.kid));
    assert.ok(linha, ap.rotulo);
    assert.ok(linha.includes(ap.rotulo));
    assert.match(linha, /\d{2}:\d{2}/);
    assert.ok(!saida.includes(ap.impressao), 'nada da impressão digital, com hífens');
    assert.ok(!saida.includes(ap.impressao.replaceAll('-', '')), 'nem sem hífens');
    assert.ok(!saida.includes(ap.publica));
  }
  assert.ok(r.stdout.includes('Para autorizar, digite a impressão digital que aparece no aparelho: --autorizar <kid> <impressão>'), r.stdout);
  assert.ok(!/mesmo rótulo/.test(saida), 'rótulos diferentes: sem aviso');
  // Dois pedidos com o mesmo rótulo: aviso, citando os kids.
  const gemeo = novoAparelho(null, 'celular');
  c.pedidos(c.estado, [pedidoDe(a), pedidoDe(gemeo), pedidoDe(b)]);
  const dois = c.script('--pedidos');
  assert.equal(dois.status, 0, dois.stderr);
  assert.match(dois.stdout + dois.stderr, new RegExp(`mesmo rótulo[\\s\\S]*(${a.kid}[\\s\\S]*${gemeo.kid}|${gemeo.kid}[\\s\\S]*${a.kid})`));
  // --autorizar continua exigindo e conferindo a impressão digital.
  assert.equal(c.script('--autorizar', a.kid).status, 1);
  assert.equal(c.script('--autorizar', a.kid, gemeo.impressao).status, 1);
  assert.equal(fs.existsSync(c.chavesArq), false);
  assert.equal(c.script('--autorizar', a.kid, a.impressao).status, 0);
});

// ---------------------------------------------------------------- SE-M4: o script usa os caminhos do coletor

test('SE-M4: o script segue MOISES_CHAVES_ARQ e MOISES_ESTADO do coletor.env e imprime o caminho do arquivo de chaves', () => {
  const pre = novaPasta();
  const chavesArq = path.join(pre, 'outra-pasta', 'chaves.json');
  const estado = path.join(pre, 'estado-do-coletor');
  fs.mkdirSync(estado, { mode: 0o700 });
  // O MOISES_ESTADO do ambiente do script não existe mais: vale o do coletor.env, como no coletor.
  const c = computador({ linhasConf: [`MOISES_CHAVES_ARQ=${chavesArq}`, `MOISES_ESTADO=${estado}`], extraEnv: { MOISES_ESTADO: undefined } });
  const ap = novoAparelho(null, 'celular');
  c.pedidos(estado, [pedidoDe(ap)]);
  const lista = c.script('--pedidos');
  assert.equal(lista.status, 0, lista.stderr);
  assert.ok(lista.stdout.includes(ap.kid), 'achou o pedido na pasta de estado do coletor.env');
  assert.ok(lista.stdout.includes(chavesArq), 'imprime o caminho absoluto do arquivo de chaves');
  const ok = c.script('--autorizar', ap.kid, ap.impressao);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes(chavesArq));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(chavesArq, 'utf8'))), [ap.kid]);
  assert.equal(fs.statSync(chavesArq).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(c.chavesArq), false, 'nada no arquivo de chaves padrão');
  for (const args of [['--listar'], ['--revogar', ap.kid]]) {
    const r = c.script(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(chavesArq), args[0]);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(chavesArq, 'utf8')), {}, 'revogou no arquivo que o coletor lê');
  // Nada do coletor.env (token) aparece na saída.
  assert.ok(!(lista.stdout + lista.stderr + ok.stdout + ok.stderr).includes('token-falso'));
});

// ---------------------------------------------------------------- A1-resto: --autorizar e a conferência do painel

test('A1-resto: --autorizar recusa com a última conferência do painel divergente; sem ela ou antiga, avisa e segue', () => {
  const c = computador();
  const [a, b, d, e] = [novoAparelho(null, 'a'), novoAparelho(null, 'b'), novoAparelho(null, 'd'), novoAparelho(null, 'e')];
  c.pedidos(c.estado, [a, b, d, e].map((ap) => pedidoDe(ap)));
  // Divergiu: recusa e não grava nada.
  c.conferencia(c.estado, { ok: false, em: Date.now(), arquivo: 'app.js', causa: 'diferente' });
  const recusa = c.script('--autorizar', a.kid, a.impressao);
  assert.equal(recusa.status, 1);
  assert.ok((recusa.stdout + recusa.stderr).includes(DIVERGENTE), recusa.stderr);
  assert.equal(fs.existsSync(c.chavesArq), false);
  // Divergência antiga continua recusando: a última conferência conhecida não bate.
  c.conferencia(c.estado, { ok: false, em: Date.now() - 2 * 3_600_000, arquivo: 'app.js', causa: 'diferente' });
  assert.equal(c.script('--autorizar', a.kid, a.impressao).status, 1);
  // Arquivo ilegível: recusa (na dúvida, não autoriza).
  fs.writeFileSync(path.join(c.estado, 'painel-conferencia.json'), '{quebrado');
  assert.equal(c.script('--autorizar', a.kid, a.impressao).status, 1);
  assert.equal(fs.existsSync(c.chavesArq), false);
  // Recente e conferida: autoriza sem aviso.
  c.conferencia(c.estado, { ok: true, em: Date.now() - 60_000 });
  const ok = c.script('--autorizar', a.kid, a.impressao);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!/conferência do painel/.test(ok.stdout + ok.stderr), ok.stdout + ok.stderr);
  // Conferida há mais de 1 hora: avisa e segue.
  c.conferencia(c.estado, { ok: true, em: Date.now() - 3_600_000 - 60_000 });
  const antiga = c.script('--autorizar', b.kid, b.impressao);
  assert.equal(antiga.status, 0, antiga.stderr);
  assert.match(antiga.stdout + antiga.stderr, /conferência do painel.*mais de 1 hora/);
  // Sem o arquivo: avisa e segue.
  fs.rmSync(path.join(c.estado, 'painel-conferencia.json'));
  const sem = c.script('--autorizar', d.kid, d.impressao);
  assert.equal(sem.status, 0, sem.stderr);
  assert.match(sem.stdout + sem.stderr, /conferência do painel/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(c.chavesArq, 'utf8'))).sort(), [a.kid, b.kid, d.kid].sort());
});

test('A1-resto: com MOISES_CONFERIR_PAINEL=0 no coletor.env, --autorizar não bloqueia', () => {
  const c = computador({ linhasConf: ['MOISES_CONFERIR_PAINEL=0  # desenvolvimento'] });
  const ap = novoAparelho(null, 'celular');
  c.pedidos(c.estado, [pedidoDe(ap)]);
  c.conferencia(c.estado, { ok: false, em: Date.now(), arquivo: 'app.js', causa: 'diferente' });
  const r = c.script('--autorizar', ap.kid, ap.impressao);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(c.chavesArq, 'utf8'))), [ap.kid]);
});

// ---------------------------------------------------------------- S27: CSP

test('S27: a CSP publicada tem worker-src none', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
  const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value.split(';').map((s) => s.trim());
  assert.ok(csp.includes("worker-src 'none'"), csp.join('; '));
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("require-trusted-types-for 'script'"));
});
