import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const criadas = [];
after(() => {
  for (const d of criadas) fs.rmSync(d, { recursive: true, force: true });
});

// Monta uma raiz de projeto mínima numa pasta temporária; `arquivos` sobrescreve ou acrescenta.
function projeto(arquivos = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-scripts-'));
  criadas.push(dir);
  const base = {
    'package.json': '{"type":"module"}',
    'vercel.json': '{"outputDirectory":"public"}',
    'public/index.html': '<link rel="stylesheet" href="/style.css"><script src="/app.js"></script>',
    'public/login.html': '<script src="/app.js"></script>',
    'public/style.css': 'body{}',
    'public/app.js': "'use strict';\nconst x = 1;\n",
    'api/rota.js': 'export default function rota() {}\n',
    'api/_lib.js': 'throw new Error("não deve ser importado");\n',
  };
  for (const [nome, conteudo] of Object.entries({ ...base, ...arquivos })) {
    if (conteudo === null) continue;
    const alvo = path.join(dir, nome);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
  }
  return dir;
}
const rodar = (script, dir) => spawnSync(process.execPath, [path.join(raiz, 'scripts', script), dir], { encoding: 'utf8' });

test('lint do projeto termina com código 0 e a linha de resumo', () => {
  const saida = execFileSync(process.execPath, [path.join(raiz, 'scripts/lint.js')], { encoding: 'utf8' });
  assert.match(saida.trim().split('\n').pop(), /^lint: \d+ arquivos, 0 erros$/);
});

test('build do projeto termina com código 0 e a linha de resumo', () => {
  const saida = execFileSync(process.execPath, [path.join(raiz, 'scripts/build.js')], { encoding: 'utf8' });
  assert.match(saida.trim().split('\n').pop(), /^build: ok \(\d+ rotas, \d+ arquivos estáticos\)$/);
});

test('lint aceita script clássico e módulo ES em public/, e ignora pastas de fora', () => {
  const dir = projeto({
    'public/assinatura.js': "import fs from 'node:fs';\nexport const a = fs;\n",
    'test/node_modules/x/quebrado.js': 'const = ;\n',
    'scripts/.claude/quebrado.js': 'const = ;\n',
  });
  const r = rodar('lint.js', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lint: 4 arquivos, 0 erros/);
});

test('lint falha com erro de sintaxe e diz qual arquivo', () => {
  const r = rodar('lint.js', projeto({ 'collector/quebrado.js': 'const = ;\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /collector\/quebrado\.js/);
  assert.match(r.stdout, /1 erros/);
});

test('build falha com script, vercel.json ou rota inválidos', () => {
  const ok = rodar('build.js', projeto());
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /build: ok \(1 rotas, 4 arquivos estáticos\)/);

  const semScript = rodar('build.js', projeto({ 'public/app.js': null }));
  assert.equal(semScript.status, 1);
  assert.match(semScript.stderr, /"\/app\.js" aponta para arquivo que não existe/);

  assert.equal(rodar('build.js', projeto({ 'vercel.json': '{quebrado' })).status, 1);
  assert.equal(rodar('build.js', projeto({ 'vercel.json': '{"outputDirectory":"dist"}' })).status, 1);
  assert.equal(rodar('build.js', projeto({ 'api/rota.js': 'export const x = 1;\n' })).status, 1);
});
