// Rodada de correção 2 (dev A): o laço grava o resultado de cada conferência do painel (A1-resto), registra
// no início o arquivo de chaves que usa (SE-M4) e passa ao orquestrador os caminhos protegidos (SE-M5b).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rodar } from '../collector/index.js';
import { aparelho as novoAparelho, assinarCom, gravarChaves } from './fixtures/aparelho.js';

delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_SUBIR_TEXTO;

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PUBLICA = path.join(RAIZ, 'public');
const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
// Sem mkdtemp: o sufixo aleatório poderia conter uma palavra que o orquestrador recusa em argsExtra (mcp…).
const BASE = path.join(os.tmpdir(), `moises-corr2a-painel-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

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

// Conta principal vazia, um projeto, um aparelho autorizado e uma cópia de public/.
function ambiente() {
  const d = path.join(BASE, `caso-${++casos}`);
  const dirClaude = path.join(d, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(dirClaude, s), { recursive: true });
  const proj = path.join(d, 'projeto-x');
  fs.mkdirSync(proj);
  const conf = path.join(d, 'conf');
  fs.mkdirSync(conf);
  const projetosArq = path.join(d, 'listas', 'projetos.json');
  fs.mkdirSync(path.dirname(projetosArq));
  fs.writeFileSync(projetosArq, JSON.stringify({ 'projeto-x': proj }));
  const ap = novoAparelho(null, 'celular');
  const chavesArq = path.join(conf, 'chaves-comandos.json');
  gravarChaves(chavesArq, [ap]);
  const publica = path.join(d, 'public');
  fs.cpSync(PUBLICA, publica, { recursive: true });
  return { d, dirClaude, proj, projetosArq, ap, chavesArq, publica, pastaEstado: path.join(d, 'estado'), token: crypto.randomBytes(32).toString('base64url') };
}

// Painel falso: serve os arquivos de `publica` (e `/` como index.html), troca o que estiver em `trocados` e
// entrega a fila de comandos no ingest.
async function painelFalso(t, amb) {
  const fila = [];
  const pedidos = [];
  const trocados = new Map();
  const servidor = http.createServer((req, res) => {
    if (req.method === 'GET') {
      const nome = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.slice(1));
      const arq = path.join(amb.publica, nome);
      if (trocados.has(nome)) return res.writeHead(200).end(trocados.get(nome));
      if (!arq.startsWith(amb.publica + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) return res.writeHead(404).end();
      return res.writeHead(200).end(fs.readFileSync(arq));
    }
    let corpo = '';
    req.on('data', (p) => (corpo += p));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${amb.token}`) return res.writeHead(401).end('{}');
      pedidos.push(JSON.parse(corpo));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ comandos: fila.splice(0, 20), painelVistoEm: Date.now() }));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => {
    servidor.closeAllConnections();
    return new Promise((r) => servidor.close(r));
  });
  const acks = () => pedidos.flatMap((p) => p.acks || []);
  return { url: `http://127.0.0.1:${servidor.address().port}`, fila, pedidos, trocados, acks, retratos: () => pedidos.map((p) => p.retrato).filter(Boolean) };
}

async function iniciar(t, amb, painel, extra = {}) {
  const logs = [];
  const coletor = await rodar({
    url: painel.url, token: amb.token, pastaEstado: amb.pastaEstado, chavesArq: amb.chavesArq, projetosArq: amb.projetosArq,
    dirs: [amb.dirClaude], intervaloMs: 200, intervaloRapidoMs: 50, claudeBin: FALSO, ideiasTetoDia: 0, pastaPublica: amb.publica,
    log: (...a) => logs.push(a.map(String).join(' ')),
    ...extra,
  });
  t.after(() => coletor.parar());
  return { logs, coletor };
}

const lerJson = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8'));

test('A1-resto: cada conferência do painel vai para painel-conferencia.json (600), sem conteúdo', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb);
  const arq = path.join(amb.pastaEstado, 'painel-conferencia.json');
  const antes = Date.now();
  await iniciar(t, amb, painel, { conferirPainelMs: 300 });
  const ok = await ate(() => fs.existsSync(arq) && lerJson(arq), 'primeira conferência gravada');
  assert.deepEqual(Object.keys(ok).sort(), ['em', 'ok']);
  assert.equal(ok.ok, true);
  assert.ok(ok.em >= antes && ok.em <= Date.now());
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  // login.js servido diferente: a próxima conferência grava a divergência, com o arquivo e a causa.
  painel.trocados.set('login.js', 'CONTEUDO-TROCADO');
  const diverge = await ate(() => (lerJson(arq).ok === false ? lerJson(arq) : null), 'divergência gravada');
  assert.deepEqual({ ...diverge, em: 0 }, { ok: false, em: 0, arquivo: 'login.js', causa: 'diferente' });
  assert.ok(!fs.readFileSync(arq, 'utf8').includes('CONTEUDO-TROCADO'));
  // Volta a bater: o arquivo volta a dizer ok.
  painel.trocados.clear();
  await ate(() => lerJson(arq).ok === true, 'conferência ok de novo');
});

test('A1-resto: sem a conferência (conferirPainel: false) o arquivo não é gravado', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb);
  await iniciar(t, amb, painel, { conferirPainel: false });
  await ate(() => painel.pedidos.length >= 2, 'dois ciclos');
  assert.equal(fs.existsSync(path.join(amb.pastaEstado, 'painel-conferencia.json')), false);
});

test('SE-M4: ao iniciar, o log diz qual arquivo de chaves o coletor usa e quantas carregou, sem as chaves', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb);
  const { logs } = await iniciar(t, amb, painel, { conferirPainel: false });
  await ate(() => painel.retratos()[0], 'primeiro retrato');
  const linha = logs.find((l) => l.includes(amb.chavesArq));
  assert.ok(linha, logs.join('\n'));
  assert.match(linha, /\b1\b/);
  assert.ok(!logs.join('\n').includes(amb.ap.publica));
});

test('SE-M5b: as pastas das chaves, dos projetos e do estado vão ao orquestrador como protegidas', async (t) => {
  const amb = ambiente();
  const painel = await painelFalso(t, amb);
  const registro = path.join(amb.d, 'registro.json');
  await iniciar(t, amb, painel, { conferirPainel: false, argsExtra: [`--system-prompt=registro:${registro}`] });
  await ate(() => painel.retratos()[0], 'primeiro retrato');
  const id = `c_${crypto.randomBytes(8).toString('hex')}`;
  painel.fila.push({
    ...assinarCom(amb.ap.privada, {
      v: 1, kid: amb.ap.kid, id, tipo: 'abrir', chave: null, criadoEm: Date.now(),
      dados: JSON.stringify({ projeto: 'projeto-x', pedido: 'oi', nome: 'protegidos' }),
    }),
    idadeMs: 5,
  });
  const feito = await ate(() => painel.acks().find((a) => a.id === id && a.estado !== 'recebido'), 'resultado do abrir');
  assert.equal(feito.estado, 'feito', JSON.stringify(feito));
  const { argv } = lerJson(registro);
  const settings = argv.find((a) => a.startsWith('--settings='));
  assert.ok(settings, argv.join(' '));
  const deny = JSON.parse(settings.slice('--settings='.length)).permissions.deny.join('\n');
  for (const pasta of [path.dirname(amb.chavesArq), path.dirname(amb.projetosArq), amb.pastaEstado]) {
    assert.ok(deny.includes(pasta), `${pasta} protegida:\n${deny}`);
  }
});
