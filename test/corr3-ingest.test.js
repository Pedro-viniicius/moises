// Correção final (CR6): corpo do ingest que é JSON mas não é objeto responde 400, nunca 500, e não grava nada.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import ingest from '../api/ingest.js';
import { K } from '../api/_lib.js';
import { instalarRedisFalso } from '../scripts/redis-memoria.js';

const redisFalso = instalarRedisFalso();
process.env.MOISES_TOKEN = 'y'.repeat(43);
const coletor = { authorization: `Bearer ${'y'.repeat(43)}` };
beforeEach(() => redisFalso.limpar());

async function chamar(texto) {
  const req = Readable.from([Buffer.from(texto)]);
  Object.assign(req, { method: 'POST', url: '/', headers: { 'content-type': 'application/json', ...coletor }, socket: {} });
  const res = {
    statusCode: 200,
    h: {},
    setHeader(k, v) { this.h[k.toLowerCase()] = v; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
  await ingest(req, res);
  return res;
}

for (const texto of ['null', '42', '[1,2]', '[]', '"texto"', 'true']) {
  test(`CA5: corpo ${texto} responde 400 com erro curto e não grava nada`, async () => {
    const errOriginal = console.error;
    const logs = [];
    console.error = (...a) => logs.push(a.join(' '));
    let r;
    try {
      r = await chamar(texto);
    } finally {
      console.error = errOriginal;
    }
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body, { erro: 'Corpo inválido.' });
    assert.equal(redisFalso.db.has(K.recebidoEm), false, 'nada gravado no Redis');
    assert.deepEqual(logs, [], 'nada no log (não passou pelo 500)');
  });
}

test('CA5: corpo objeto continua valendo (200)', async () => {
  const r = await chamar('{"protocolo":2}');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.comandos, []);
});
