// pastaSoDoDono fecha em 700 a pasta onde o coletor grava, mas nunca a pasta pessoal nem a raiz: um
// MOISES_LIMITES_ARQ ou MOISES_CHAVES_ARQ apontado direto para ~ não pode mudar a permissão da casa inteira.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pastaSoDoDono } from '../collector/auditoria.js';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-pasta-pessoal-'));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test('pastaSoDoDono não muda a permissão da pasta pessoal', (t) => {
  const casa = path.join(BASE, 'casa');
  fs.mkdirSync(casa, { mode: 0o755 });
  fs.chmodSync(casa, 0o755);
  t.mock.method(os, 'homedir', () => casa);
  pastaSoDoDono(casa);
  assert.equal(fs.statSync(casa).mode & 0o777, 0o755);
});

test('pastaSoDoDono continua fechando uma pasta comum aberta demais', () => {
  const p = path.join(BASE, 'estado');
  fs.mkdirSync(p, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  pastaSoDoDono(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o700);
});
