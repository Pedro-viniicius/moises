// QA, rodada 2 (verificação final): conferência do painel (S27), chaves de desligar (S28) e script de
// pareamento (SE-M3, SE-M4, A1-resto). Complementa test/laco.test.js e test/corr2a-*.test.js com o que a
// mutação deixou sem prova e com a prova de ponta a ponta entre o coletor de verdade e o script.
// Tudo em pastas temporárias e com o claude falso; nada lê ~/.config/moises nem .env*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conferirPainelPublicado, configuracao, rodar } from '../collector/index.js';
import { aparelho as novoAparelho } from './fixtures/aparelho.js';

delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_SUBIR_TEXTO;

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const CONFIGURAR = path.join(RAIZ, 'scripts/configurar-comandos.js');
const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
// Sem mkdtemp: o sufixo aleatório poderia conter uma palavra que o orquestrador recusa em argsExtra (mcp…).
const BASE = path.join(os.tmpdir(), `moises-qa3-conf-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

let casos = 0;
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
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

// ---------------------------------------------------------------- S27: nomes de arquivo na conferência

// Servidor que serve os arquivos de `pasta` pelo caminho decodificado, como a Vercel; `/` é o index.html.
async function servir(t, pasta) {
  const gets = [];
  const servidor = http.createServer((req, res) => {
    const nome = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1));
    gets.push(nome);
    const arq = path.join(pasta, nome);
    if (!arq.startsWith(pasta + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) return res.writeHead(404).end();
    res.writeHead(200).end(fs.readFileSync(arq));
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  return { url: `http://127.0.0.1:${servidor.address().port}`, gets };
}
const conferir = (url, pastaPublica) => conferirPainelPublicado({ url, pastaPublica, sinal: AbortSignal.timeout(10_000) });

test('S27: arquivo com espaço, # ou acento no nome (e em subpasta) é pedido pelo caminho certo e confere', async (t) => {
  const pasta = novaPasta();
  fs.writeFileSync(path.join(pasta, 'index.html'), '<p>raiz</p>');
  fs.writeFileSync(path.join(pasta, 'a b#c.js'), 'export {}');
  fs.mkdirSync(path.join(pasta, 'fontes e ícones'));
  fs.writeFileSync(path.join(pasta, 'fontes e ícones', 'ação?.css'), 'a{}');
  const servidor = await servir(t, pasta);
  assert.deepEqual(await conferir(servidor.url, pasta), { ok: true });
  assert.deepEqual(servidor.gets.sort(), ['a b#c.js', 'fontes e ícones/ação?.css', 'index.html', 'index.html'].sort());
  // Arquivo que o servidor não tem: aponta o caminho relativo.
  const outra = novaPasta();
  fs.cpSync(pasta, outra, { recursive: true });
  fs.writeFileSync(path.join(outra, 'fontes e ícones', 'ação?.css'), 'b{}');
  assert.deepEqual(await conferir(servidor.url, outra), { ok: false, arquivo: 'fontes e ícones/ação?.css', causa: 'diferente' });
});

test('S27: pasta pública vazia ou só com subpastas vazias: sem index.html local, `/` não confere e desliga', async (t) => {
  const pasta = novaPasta();
  fs.mkdirSync(path.join(pasta, 'vazia'));
  const servidor = await servir(t, pasta);
  assert.deepEqual(await conferir(servidor.url, pasta), { ok: false, arquivo: '/', causa: 'local' });
});

// ---------------------------------------------------------------- S28: fim de linha do coletor.env

function lerComFimDeLinha(fim, linhas, env = {}) {
  const d = novaPasta();
  const arq = path.join(d, 'coletor.env');
  fs.writeFileSync(arq, linhas.join(fim) + fim, { mode: 0o600 });
  const avisos = [];
  const amb = { MOISES_CONF: arq, ...env };
  const conf = configuracao({ env: amb, home: path.join(d, 'home'), avisar: (m) => avisos.push(m) });
  return { conf, env: amb, avisos };
}

test('S28: coletor.env com fim de linha CRLF vale como com LF: MOISES_COMANDOS=0 desliga e URL e token chegam limpos', () => {
  const linhas = ['MOISES_URL=https://painel.example', 'MOISES_TOKEN=abc-def', 'MOISES_COMANDOS=0', 'MOISES_SUBIR_TEXTO=off  # sem texto', 'MOISES_ENCERRAR=0'];
  const lf = lerComFimDeLinha('\n', linhas);
  const crlf = lerComFimDeLinha('\r\n', linhas);
  assert.equal(lf.env.MOISES_COMANDOS, '0', 'a referência com LF');
  assert.deepEqual(crlf.avisos, [], `CRLF não pode gerar "linha não entendida": ${crlf.avisos.join(' | ')}`);
  for (const chave of ['MOISES_COMANDOS', 'MOISES_SUBIR_TEXTO', 'MOISES_ENCERRAR']) assert.equal(crlf.env[chave], '0', chave);
  assert.deepEqual([crlf.conf.url, crlf.conf.token], ['https://painel.example', 'abc-def']);
});

// ---------------------------------------------------------------- script: --autorizar e painel-conferencia.json

function computador({ linhasConf = [] } = {}) {
  const d = novaPasta();
  const conf = path.join(d, 'conf');
  const home = path.join(d, 'home');
  const estado = path.join(d, 'estado');
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(home);
  fs.mkdirSync(estado, { mode: 0o700 });
  fs.writeFileSync(path.join(conf, 'coletor.env'), ['MOISES_URL=https://falso.example', 'MOISES_TOKEN=token-falso', ...linhasConf].join('\n') + '\n', { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: home, MOISES_PASTA_CONF: conf, MOISES_ESTADO: estado };
  const script = (...args) => spawnSync(process.execPath, [CONFIGURAR, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const pedido = (ap) => fs.writeFileSync(path.join(estado, 'aparelhos-pedidos.json'), JSON.stringify([{ kid: ap.kid, publica: ap.publica, rotulo: ap.rotulo, criadoEm: Date.now() }]), { mode: 0o600 });
  return { d, conf, estado, script, pedido, chavesArq: path.join(conf, 'chaves-comandos.json'), arqConferencia: path.join(estado, 'painel-conferencia.json') };
}

test('A1-resto: painel-conferencia.json em formato errado ou com tipos trocados recusa o --autorizar e nada é gravado', () => {
  const c = computador();
  const ap = novoAparelho(null, 'celular');
  c.pedido(ap);
  const agora = Date.now();
  for (const ruim of [
    { ok: 'true', em: agora }, // texto no lugar de booleano: não pode passar por verdadeiro
    { ok: 1, em: agora },
    { ok: true }, // sem hora
    { ok: true, em: 'agora' },
    { ok: true, em: null },
    [],
    null,
    'ok',
    42,
  ]) {
    fs.writeFileSync(c.arqConferencia, JSON.stringify(ruim));
    const r = c.script('--autorizar', ap.kid, ap.impressao);
    assert.equal(r.status, 1, `${JSON.stringify(ruim)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /fora do formato|Nada foi gravado/);
    assert.equal(fs.existsSync(c.chavesArq), false, JSON.stringify(ruim));
  }
  // Arquivo vazio e arquivo que é uma pasta (ilegível): recusa, com o código e sem o conteúdo.
  fs.writeFileSync(c.arqConferencia, '');
  assert.equal(c.script('--autorizar', ap.kid, ap.impressao).status, 1);
  fs.rmSync(c.arqConferencia);
  fs.mkdirSync(c.arqConferencia);
  const dir = c.script('--autorizar', ap.kid, ap.impressao);
  assert.equal(dir.status, 1);
  assert.match(dir.stdout + dir.stderr, /EISDIR/);
  assert.equal(fs.existsSync(c.chavesArq), false);
  // O formato certo autoriza.
  fs.rmSync(c.arqConferencia, { recursive: true });
  fs.writeFileSync(c.arqConferencia, JSON.stringify({ ok: true, em: agora }));
  assert.equal(c.script('--autorizar', ap.kid, ap.impressao).status, 0);
});

test('A1-resto: conferência com data no futuro (relógio errado) e ok avisa e segue; divergente no futuro continua recusando', () => {
  const c = computador();
  const [a, b] = [novoAparelho(null, 'a'), novoAparelho(null, 'b')];
  c.pedido(a);
  fs.writeFileSync(c.arqConferencia, JSON.stringify({ ok: false, em: Date.now() + 24 * 3_600_000, arquivo: 'app.js', causa: 'diferente' }));
  assert.equal(c.script('--autorizar', a.kid, a.impressao).status, 1);
  fs.writeFileSync(c.arqConferencia, JSON.stringify({ ok: true, em: Date.now() + 24 * 3_600_000 }));
  const r = c.script('--autorizar', a.kid, a.impressao);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /data no futuro/);
  c.pedido(b);
});

test('SE-M4: com MOISES_PROJETOS no coletor.env, o script cria o projetos.json vazio nesse caminho e não na pasta de configuração', () => {
  const pre = novaPasta();
  const projetos = path.join(pre, 'meus-projetos.json');
  const c = computador({ linhasConf: [`MOISES_PROJETOS=${projetos}`] });
  const ap = novoAparelho(null, 'celular');
  c.pedido(ap);
  fs.writeFileSync(c.arqConferencia, JSON.stringify({ ok: true, em: Date.now() }));
  const r = c.script('--autorizar', ap.kid, ap.impressao);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(projetos), true, 'o arquivo de projetos que o coletor lê');
  assert.equal(fs.existsSync(path.join(c.conf, 'projetos.json')), false, 'nada no padrão');
  assert.equal(fs.statSync(projetos).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------- ponta a ponta: coletor de verdade e script

test('A1-resto: o coletor de verdade grava a conferência e o script lê o mesmo arquivo: divergiu recusa, voltou a bater autoriza', async (t) => {
  const d = novaPasta();
  const publica = path.join(d, 'public');
  fs.cpSync(path.join(RAIZ, 'public'), publica, { recursive: true });
  const estado = path.join(d, 'estado');
  const conf = path.join(d, 'conf');
  fs.mkdirSync(conf, { mode: 0o700 });
  const token = crypto.randomBytes(32).toString('base64url');
  const dirClaude = path.join(d, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(dirClaude, s), { recursive: true });
  const projetosArq = path.join(conf, 'projetos.json');
  fs.writeFileSync(projetosArq, '{}');
  const trocados = new Map();
  const servidor = http.createServer((req, res) => {
    if (req.method === 'GET') {
      const nome = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1));
      if (trocados.has(nome)) return res.writeHead(200).end(trocados.get(nome));
      const arq = path.join(publica, nome);
      if (!fs.existsSync(arq) || !fs.statSync(arq).isFile()) return res.writeHead(404).end();
      return res.writeHead(200).end(fs.readFileSync(arq));
    }
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ comandos: [], painelVistoEm: Date.now() })));
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  const chavesArq = path.join(conf, 'chaves-comandos.json');
  const coletor = await rodar({
    url: `http://127.0.0.1:${servidor.address().port}`, token, pastaEstado: estado, chavesArq, projetosArq, dirs: [dirClaude], intervaloMs: 200,
    intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0, pastaPublica: publica, conferirPainelMs: 300, log: () => {},
  });
  t.after(() => coletor.parar());
  const arq = path.join(estado, 'painel-conferencia.json');
  await ate(() => fs.existsSync(arq) && JSON.parse(fs.readFileSync(arq, 'utf8')).ok === true, 'conferência ok gravada');

  fs.writeFileSync(path.join(conf, 'coletor.env'), `MOISES_URL=http://127.0.0.1:1\nMOISES_TOKEN=${token}\nMOISES_CHAVES_ARQ=${chavesArq}\nMOISES_PROJETOS=${projetosArq}\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: path.join(d, 'home'), MOISES_PASTA_CONF: conf, MOISES_ESTADO: estado };
  const script = (...args) => spawnSync(process.execPath, [CONFIGURAR, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const ap = novoAparelho(null, 'celular');
  fs.writeFileSync(path.join(estado, 'aparelhos-pedidos.json'), JSON.stringify([{ kid: ap.kid, publica: ap.publica, rotulo: ap.rotulo, criadoEm: Date.now() }]), { mode: 0o600 });

  // `/` servido diferente de index.html (S27): o coletor grava a divergência e o script recusa.
  trocados.set('index.html', '<p>outra página</p>');
  await ate(() => JSON.parse(fs.readFileSync(arq, 'utf8')).ok === false, 'divergência gravada');
  const recusa = script('--autorizar', ap.kid, ap.impressao);
  assert.equal(recusa.status, 1, recusa.stdout + recusa.stderr);
  assert.match(recusa.stdout + recusa.stderr, /o painel publicado não confere com este computador/);
  assert.equal(fs.existsSync(chavesArq), false);
  // Volta a bater na conferência seguinte: o script autoriza.
  trocados.clear();
  await ate(() => JSON.parse(fs.readFileSync(arq, 'utf8')).ok === true, 'conferência ok de novo');
  const ok = script('--autorizar', ap.kid, ap.impressao);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(chavesArq, 'utf8'))), [ap.kid]);
  // Sem a conferência divergente guardada, nada do conteúdo servido foi parar no arquivo.
  assert.ok(!fs.readFileSync(arq, 'utf8').includes('outra página'));
});
