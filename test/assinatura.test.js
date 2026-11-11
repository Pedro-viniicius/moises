// Assinatura dos comandos do painel: a mesma regra no navegador (public/assinatura.js, WebCrypto)
// e no coletor (collector/assinatura.js, node:crypto). Os códigos são sorteados em tempo de execução.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as nav from '../public/assinatura.js';
import * as col from '../collector/assinatura.js';

const FORMATO_CODIGO = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}(-[abcdefghjkmnpqrstuvwxyz23456789]{4}){4}$/;
const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';

// A derivação custa 210.000 iterações: um código e as duas chaves dele servem a todos os testes.
const codigo = col.gerarCodigo();
const chaveNav = await nav.derivarChave(codigo);
const chaveCol = col.derivarChave(codigo);

const assinar = (opcoes, agora) => nav.assinarComando(chaveNav, opcoes, agora);

// Troca um caractere de uma string por outro do mesmo alfabeto, sem mudar o tamanho.
function trocarUm(s, i = s.length - 1) {
  const c = s[i];
  const novo = c === 'a' ? 'b' : c === '0' ? '1' : c === '"' ? "'" : 'a';
  return s.slice(0, i) + novo + s.slice(i + 1);
}

test('(a) gerarCodigo segue o formato do contrato e dois sorteios diferem', () => {
  assert.equal(col.ALFABETO, 'abcdefghjkmnpqrstuvwxyz23456789');
  const a = col.gerarCodigo();
  const b = col.gerarCodigo();
  assert.match(a, FORMATO_CODIGO);
  assert.match(b, FORMATO_CODIGO);
  assert.notEqual(a, b);
  assert.equal(col.normalizarCodigo(a).length, 22);
});

test('(b) normalizarCodigo aceita maiúsculas, espaços e hífens a mais e recusa tamanho errado', () => {
  const normal = codigo.replaceAll('-', '');
  const baguncado = `  ${codigo.toUpperCase().replaceAll('-', ' - -')}  `;
  for (const mod of [nav, col]) {
    assert.equal(mod.normalizarCodigo(codigo), normal);
    assert.equal(mod.normalizarCodigo(baguncado), normal);
    assert.equal(mod.normalizarCodigo(normal.slice(0, 21)), null);
    assert.equal(mod.normalizarCodigo(`${normal}a`), null);
    assert.equal(mod.normalizarCodigo(''), null);
    for (const ruim of [undefined, null, 42, {}, ['x']]) assert.equal(mod.normalizarCodigo(ruim), null);
  }
});

test('(c) comando assinado no navegador confere no coletor com a chave do mesmo código', async () => {
  const dados = { texto: 'olá, mundo', visto: { projeto: 'moises', nome: null } };
  const agora = 1794387000000;
  const cmd = await assinar({ tipo: 'mensagem', chave: SESSAO, dados }, agora);

  assert.deepEqual(Object.keys(cmd).sort(), ['assinatura', 'chave', 'criadoEm', 'dados', 'id', 'kid', 'tipo', 'v']);
  assert.equal(cmd.v, 1);
  assert.equal(cmd.kid, codigo.slice(0, 6));
  assert.equal(chaveNav.kid, cmd.kid);
  assert.equal(chaveCol.kid, cmd.kid);
  assert.match(cmd.id, /^c_[0-9a-f]{16}$/);
  assert.equal(cmd.tipo, 'mensagem');
  assert.equal(cmd.chave, SESSAO);
  assert.equal(cmd.criadoEm, agora);
  assert.equal(cmd.dados, JSON.stringify(dados));
  assert.match(cmd.assinatura, /^[A-Za-z0-9_-]{43}$/);

  assert.ok(Buffer.isBuffer(chaveCol.chave));
  assert.equal(chaveCol.chave.length, 32);
  assert.equal(col.assinaturaConfere(chaveCol.chave, cmd), true);

  // A regra também bate com uma conta independente feita com os parâmetros do contrato.
  const bruta = crypto.pbkdf2Sync(codigo.replaceAll('-', ''), 'moises-comandos-v1', 210_000, 32, 'sha256');
  assert.deepEqual(chaveCol.chave, bruta);
  const texto = JSON.stringify(['moises-cmd-v1', cmd.kid, cmd.id, 'mensagem', SESSAO, agora, cmd.dados]);
  assert.equal(nav.textoDoComando(cmd), texto);
  assert.equal(col.textoDoComando(cmd), texto);
  assert.equal(crypto.createHmac('sha256', bruta).update(texto).digest('base64url'), cmd.assinatura);

  // Ids sorteados: dois comandos iguais não repetem id nem assinatura; o padrão de `agora` é Date.now().
  const antes = Date.now();
  const outro = await assinar({ tipo: 'mensagem', chave: SESSAO, dados });
  assert.notEqual(outro.id, cmd.id);
  assert.notEqual(outro.assinatura, cmd.assinatura);
  assert.ok(outro.criadoEm >= antes && outro.criadoEm <= Date.now());
  assert.equal(col.assinaturaConfere(chaveCol.chave, outro), true);

  // Chave de outro código não confere.
  const alheia = col.derivarChave(col.gerarCodigo());
  assert.equal(col.assinaturaConfere(alheia.chave, cmd), false);
});

test('(d) alterar kid, id, tipo, chave, criadoEm ou dados faz a conferência falhar', async () => {
  const cmd = await assinar(
    { tipo: 'permissao', chave: SESSAO, dados: { pedido: 'p1', decisao: 'negar', visto: { projeto: 'x', nome: 'y' } } },
    1794387000000,
  );
  assert.equal(col.assinaturaConfere(chaveCol.chave, cmd), true);
  const alterados = {
    kid: { ...cmd, kid: trocarUm(cmd.kid) },
    id: { ...cmd, id: trocarUm(cmd.id) },
    tipo: { ...cmd, tipo: trocarUm(cmd.tipo) },
    chave: { ...cmd, chave: trocarUm(cmd.chave) },
    chaveNula: { ...cmd, chave: null },
    criadoEm: { ...cmd, criadoEm: cmd.criadoEm + 1 },
    dados: { ...cmd, dados: trocarUm(cmd.dados, 10) },
    dadosObjeto: { ...cmd, dados: JSON.parse(cmd.dados) },
    assinatura: { ...cmd, assinatura: trocarUm(cmd.assinatura, 0) },
  };
  for (const [campo, alterado] of Object.entries(alterados)) {
    assert.equal(col.assinaturaConfere(chaveCol.chave, alterado), false, `alterar ${campo} deveria falhar`);
  }
});

test('(e) assinaturaConfere devolve false, sem lançar, para qualquer formato inválido', async () => {
  const cmd = await assinar({ tipo: 'interromper', chave: SESSAO, dados: { visto: { projeto: 'x', nome: null } } });
  const { assinatura, ...semAssinatura } = cmd;
  const assinaturas = [undefined, null, '', 'abc', `${assinatura}A`, assinatura.slice(0, 42), `${assinatura.slice(0, 42)}=`,
    `${assinatura.slice(0, 42)}+`, 42, {}, [assinatura], Buffer.from(assinatura)];
  assert.equal(col.assinaturaConfere(chaveCol.chave, semAssinatura), false);
  for (const a of assinaturas) {
    assert.equal(col.assinaturaConfere(chaveCol.chave, { ...cmd, assinatura: a }), false, `assinatura ${String(a)}`);
  }
  // O último caractere carrega 2 bits de enchimento: a variante não canônica decodifica para os
  // mesmos 32 bytes, mas não é a assinatura emitida e é recusada.
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const naoCanonica = assinatura.slice(0, 42) + B64URL[B64URL.indexOf(assinatura[42]) ^ 1];
  assert.deepEqual(Buffer.from(naoCanonica, 'base64url'), Buffer.from(assinatura, 'base64url'));
  assert.equal(col.assinaturaConfere(chaveCol.chave, { ...cmd, assinatura: naoCanonica }), false);
  // Comando, campos ou chave em formato inválido também dão false, nunca exceção.
  const circular = {};
  circular.eu = circular;
  const casos = [
    [chaveCol.chave, undefined],
    [chaveCol.chave, null],
    [chaveCol.chave, 'texto'],
    [chaveCol.chave, { ...cmd, criadoEm: 10n }],
    [chaveCol.chave, { ...cmd, criadoEm: '1794387000000' }],
    [chaveCol.chave, { ...cmd, criadoEm: 1.5 }],
    [chaveCol.chave, { ...cmd, dados: circular }],
    [chaveCol.chave, { ...cmd, kid: 7 }],
    [chaveCol.chave, { ...cmd, chave: 7 }],
    [chaveCol.chave, Object.defineProperty({ ...cmd }, 'dados', { get() { throw new Error('armadilha'); } })],
    [undefined, cmd],
    [null, cmd],
    ['texto', cmd],
    [Buffer.alloc(0), cmd],
    [chaveCol.chave.subarray(0, 31), cmd],
  ];
  for (const [chave, c] of casos) assert.equal(col.assinaturaConfere(chave, c), false);
});

test('(f) a chave do navegador não é extraível e só serve para assinar', async () => {
  const { chave } = chaveNav;
  assert.equal(chave.extractable, false);
  assert.deepEqual(chave.usages, ['sign']);
  assert.equal(chave.algorithm.name, 'HMAC');
  assert.equal(chave.algorithm.hash.name, 'SHA-256');
  assert.equal(chave.algorithm.length, 256);
  await assert.rejects(crypto.subtle.exportKey('raw', chave));
  await assert.rejects(crypto.subtle.exportKey('jwk', chave));
});

test('(g) hashVisto dá o mesmo valor nos dois módulos e muda quando a entrada muda', async () => {
  const entrada = '{"command":"rm -rf build/","description":"limpa"} çã 😀';
  const h = await nav.hashVisto('Bash', entrada);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(col.hashVisto('Bash', entrada), h);
  assert.equal(h, crypto.createHash('sha256').update(`Bash\n${entrada}`).digest('hex'));
  assert.notEqual(await nav.hashVisto('Bash', `${entrada} `), h);
  assert.notEqual(col.hashVisto('Bash', `${entrada} `), h);
  assert.notEqual(col.hashVisto('Edit', entrada), h);
});

test('(h) chave null assina como string vazia', async () => {
  const cmd = await assinar({ tipo: 'abrir', dados: { projeto: 'moises', pedido: 'oi' } }, 1794387000000);
  assert.equal(cmd.chave, null);
  for (const mod of [nav, col]) {
    const texto = mod.textoDoComando(cmd);
    assert.equal(JSON.parse(texto)[4], '');
    assert.equal(texto, mod.textoDoComando({ ...cmd, chave: '' }));
  }
  assert.equal(col.assinaturaConfere(chaveCol.chave, cmd), true);
  assert.equal(col.assinaturaConfere(chaveCol.chave, { ...cmd, chave: '' }), true);
  // Sem `dados`, o padrão é um objeto vazio.
  const semDados = await assinar({ tipo: 'abrir' });
  assert.equal(semDados.dados, '{}');
  assert.equal(col.assinaturaConfere(chaveCol.chave, semDados), true);
});

test('(i) derivarChave com código inválido lança nos dois módulos, sem citar o código', async () => {
  assert.throws(() => col.derivarChave('curto'), { message: 'Código inválido.' });
  await assert.rejects(nav.derivarChave('curto'), { message: 'Código inválido.' });
  assert.throws(() => col.derivarChave(undefined), { message: 'Código inválido.' });
  await assert.rejects(nav.derivarChave(null), { message: 'Código inválido.' });
});
