// Correção final (CR7/CR8): cada constante do contrato tem uma só fonte. O porteiro (collector/comandos.js)
// importa listas e regex de collector/contrato.js (limpeza do /simplify), e a rota de aparelho importa o kid
// de api/_lib.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELOS, ESFORCOS, MODOS, RE_CHAVE } from '../collector/orquestrador.js';
import { RE_ASSINATURA, RE_KID } from '../collector/assinatura.js';

const fonte = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('CA6: collector/comandos.js não redefine listas nem regex que já são exportadas', () => {
  const src = fonte('collector/comandos.js');
  for (const nome of ['MODELOS', 'ESFORCOS', 'MODOS', 'RE_SESSAO', 'RE_ASSINATURA', 'RE_KID']) {
    assert.doesNotMatch(src, new RegExp(`^const ${nome}\\s*=`, 'm'), nome);
  }
  assert.match(src, /import \{[^}]*\bMODELOS\b[^}]*\} from '\.\/contrato\.js'/);
  assert.match(src, /import \{[^}]*\bRE_ASSINATURA\b[^}]*\} from '\.\/contrato\.js'/);
});

test('CA6: api/aparelho.js usa o RE_KID de api/_lib.js', () => {
  const src = fonte('api/aparelho.js');
  assert.doesNotMatch(src, /^const RE_KID\s*=/m);
  assert.match(src, /\bRE_KID\b[\s\S]*from '\.\/_lib\.js'/);
});

test('CA6: as fontes exportadas são as que o porteiro usava', () => {
  assert.deepEqual(MODELOS, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual(ESFORCOS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(MODOS, ['manual', 'acceptEdits', 'plan']);
  assert.equal(RE_ASSINATURA.source, '^[A-Za-z0-9_-]{86}$');
  assert.equal(RE_KID.source, '^[0-9a-f]{6}$');
  const uuid = '4e00abb1-1234-4abc-8def-0123456789ab';
  assert.equal(RE_CHAVE.test(`principal:${uuid}`), true);
  assert.equal(RE_CHAVE.test(`Principal:${uuid}`), false);
  assert.equal(RE_CHAVE.test(`principal:${uuid}x`), false);
  assert.equal(RE_CHAVE.flags, '', 'sem g nem y: test() não guarda estado entre chamadas');
});
