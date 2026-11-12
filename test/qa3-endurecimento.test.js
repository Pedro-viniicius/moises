// QA, rodada 2 (verificação final): o que a mutação mostrou sem prova nos caminhos protegidos (SE-M5b) e nos
// contadores que falham fechados (SE-B2). Complementa test/corr2b-endurecimento.test.js.
// Tudo em pastas temporárias e com o claude falso: nada lê ~/.config/moises, ~/.local/state/moises nem .env*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orquestrador } from '../collector/orquestrador.js';
import { Coletor } from '../collector/sessoes.js';
import { executarEncerrar, reiniciarLimites } from '../collector/encerrar.js';

const BASE = path.join(os.tmpdir(), `moises-qa3-endurecimento-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
delete process.env.MOISES_ENCERRAR;
after(() => {
  reiniciarLimites();
  fs.rmSync(BASE, { recursive: true, force: true });
});

let casos = 0;
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function solto(extra = {}) {
  return new Orquestrador({ coletor: new Coletor({ dirs: [] }), projetos: () => ({}), pastaEstado: path.join(BASE, 'solto'), ...extra });
}
function pedidoDe(orq, ferramenta, input) {
  const rec = { pendentes: new Map(), initConferido: true, vivo: true, morto: false, filho: { stdin: null } };
  orq.pedidoDeControle(rec, { type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool', tool_name: ferramenta, input } });
  const p = rec.pendentes.get('req_1');
  assert.ok(p, 'o pedido ficou pendente');
  orq.tirarPendente(rec, 'req_1');
  return p;
}
const denyDe = (orq) => JSON.parse(orq.configFixa).permissions.deny;

test('SE-M5b: pasta protegida que é um atalho (symlink) entra nas regras e no sensível pelo caminho do atalho e pelo real', () => {
  const real = path.join(novaPasta(), 'configuracao-real');
  fs.mkdirSync(real);
  const atalho = path.join(novaPasta(), 'atalho');
  fs.symlinkSync(real, atalho);
  const orq = solto({ protegidos: [atalho] });
  const deny = denyDe(orq);
  for (const p of [atalho, fs.realpathSync(real)]) {
    for (const f of ['Read', 'Edit', 'Write']) assert.ok(deny.includes(`${f}(/${p}/**)`), `${f} de ${p}: ${JSON.stringify(deny)}`);
  }
  // A sessão que usa o caminho real, sem passar pelo atalho, também é pega.
  assert.equal(pedidoDe(orq, 'Bash', { command: `cat ${real}/segredo` }).sensivel, true);
  assert.equal(pedidoDe(orq, 'Bash', { command: `cat ${atalho}/segredo` }).sensivel, true);
  assert.equal(pedidoDe(orq, 'Edit', { file_path: `${real}/segredo`, old_string: 'a', new_string: 'b' }).sensivel, true);
  assert.equal(pedidoDe(orq, 'Bash', { command: `cat ${real}-outra/segredo` }).sensivel, false, 'nome que só começa igual');
});

test('SE-M5b: protegidos repetidos ou com barra no fim não duplicam regra', () => {
  const p = path.join(novaPasta(), 'prot');
  const deny = denyDe(solto({ protegidos: [p, `${p}/`, p] }));
  assert.equal(deny.filter((r) => r === `Read(/${p}/**)`).length, 1);
  assert.equal(new Set(deny).size, deny.length, 'nenhuma regra repetida');
});

// ---------------------------------------------------------------- SE-B2: limites do encerrar corrompidos de outras formas

const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
function limites(t, conteudo) {
  const arq = path.join(novaPasta(), 'limites.json');
  if (conteudo !== undefined) fs.writeFileSync(arq, conteudo);
  const anterior = process.env.MOISES_LIMITES_ARQ;
  process.env.MOISES_LIMITES_ARQ = arq;
  reiniciarLimites();
  t.after(() => {
    process.env.MOISES_LIMITES_ARQ = anterior;
    reiniciarLimites();
  });
  return arq;
}

test('SE-B2: limites do encerrar com JSON válido mas de forma errada contam como teto atingido, e o arquivo não é regravado', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const ruim of ['[]', 'null', '42', '"texto"', '{"executados":"x"}', '{"executados":[1,2]}', '{"recentes":["a"]}', '{"recentes":{}}']) {
    const arq = limites(t, ruim);
    const r = await executarEncerrar({}, { id: 'e-forma', chave: SESSAO, idadeMs: 0 });
    assert.match(r.erro ?? '', /Limite de \d+ encerramentos por hora atingido/, ruim);
    assert.equal(fs.readFileSync(arq, 'utf8'), ruim, 'não regravou o arquivo estragado');
  }
});

test('SE-B2: limites do encerrar bem formados e sem os dois campos contam zero, e o pedido segue até o resultado do pedido', async (t) => {
  t.mock.method(console, 'error', () => {});
  const arq = limites(t, '{}');
  const r = await executarEncerrar({}, { id: 'e-vazio', chave: null, idadeMs: 0 });
  assert.equal(r.erro, 'Pedido sem sessão válida.', 'passou do contador e só não tinha sessão');
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')).executados, ['e-vazio']);
});
