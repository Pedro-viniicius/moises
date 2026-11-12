// Assinatura dos comandos do painel: o navegador (public/assinatura.js, WebCrypto) gera um par ECDSA P-256
// com a chave privada não extraível e assina; o coletor (collector/assinatura.js, node:crypto) confere com
// a chave pública que o dono autorizou no computador (achado A1). As chaves são geradas em tempo de execução.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as nav from '../public/assinatura.js';
import * as col from '../collector/assinatura.js';
import { aparelho as aparelhoDoNode, assinarCom } from './fixtures/aparelho.js';

const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Um aparelho do navegador e a chave pública dele como o coletor a lê do arquivo de chaves.
const doNavegador = await nav.gerarAparelho();
const publicaCol = col.chavePublica(doNavegador.publica);

const assinar = (opcoes, agora) => nav.assinarComando(doNavegador, opcoes, agora);
const sha256hex = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64url')).digest('hex');

// Troca um caractere de uma string por outro do mesmo alfabeto, sem mudar o tamanho.
function trocarUm(s, i = s.length - 1) {
  const c = s[i];
  const novo = c === 'a' ? 'b' : c === '0' ? '1' : c === '"' ? "'" : 'a';
  return s.slice(0, i) + novo + s.slice(i + 1);
}

test('(a) o navegador gera um par ECDSA P-256: privada não extraível só para assinar, pública raw de 65 bytes', async () => {
  const { kid, chave, publica, impressao } = doNavegador;
  assert.equal(chave.type, 'private');
  assert.equal(chave.extractable, false);
  assert.deepEqual(chave.usages, ['sign']);
  assert.equal(chave.algorithm.name, 'ECDSA');
  assert.equal(chave.algorithm.namedCurve, 'P-256');
  for (const formato of ['pkcs8', 'jwk', 'raw']) await assert.rejects(crypto.subtle.exportKey(formato, chave), `exportKey ${formato}`);
  // A pública vai ao computador: 65 bytes, ponto não comprimido, em base64url canônico sem '='.
  assert.match(publica, /^[A-Za-z0-9_-]{87}$/);
  const bytes = Buffer.from(publica, 'base64url');
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.equal(bytes.toString('base64url'), publica);
  // kid = 6 primeiros hexadecimais do SHA-256 da pública raw; impressão = 16 primeiros, em 4 grupos.
  const h = sha256hex(publica);
  assert.equal(kid, h.slice(0, 6));
  assert.equal(impressao, `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`);
  assert.match(impressao, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  // Dois aparelhos não repetem a chave.
  const outro = await nav.gerarAparelho();
  assert.notEqual(outro.publica, publica);
  assert.notEqual(outro.impressao, impressao);
});

test('(b) kid e impressão digital dão o mesmo valor nos dois módulos; pública inválida é recusada', async () => {
  assert.deepEqual(await nav.impressaoDaPublica(doNavegador.publica), { kid: doNavegador.kid, impressao: doNavegador.impressao });
  assert.deepEqual(col.impressaoDaPublica(doNavegador.publica), { kid: doNavegador.kid, impressao: doNavegador.impressao });
  const bytes = Buffer.from(doNavegador.publica, 'base64url');
  const comprimida = Buffer.concat([Buffer.from([2 + (bytes[64] & 1)]), bytes.subarray(1, 33)]).toString('base64url');
  const foraDaCurva = Buffer.from(bytes);
  foraDaCurva[64] ^= 1;
  const prefixo3 = Buffer.from(bytes);
  prefixo3[0] = 3;
  // O último caractere de 87 carrega 2 bits de enchimento: a variante não canônica decodifica igual.
  const ultimo = doNavegador.publica.at(-1);
  const naoCanonica = doNavegador.publica.slice(0, 86) + B64URL[B64URL.indexOf(ultimo) ^ 1];
  assert.deepEqual(Buffer.from(naoCanonica, 'base64url'), bytes);
  const invalidas = [undefined, null, 42, {}, '', 'abc', comprimida, `${doNavegador.publica}A`, doNavegador.publica.slice(1),
    `${doNavegador.publica.slice(0, 86)}=`, naoCanonica, prefixo3.toString('base64url'), Buffer.alloc(65).toString('base64url'), bytes];
  for (const p of invalidas) {
    assert.equal(col.impressaoDaPublica(p), null, `coletor: ${String(p).slice(0, 20)}`);
    assert.equal(col.chavePublica(p), null, `coletor chavePublica: ${String(p).slice(0, 20)}`);
    await assert.rejects(nav.impressaoDaPublica(p), { message: 'Chave pública inválida.' });
  }
  // Ponto fora da curva tem o formato certo (dá impressão), mas não vira chave no coletor.
  assert.notEqual(col.impressaoDaPublica(foraDaCurva.toString('base64url')), null);
  assert.equal(col.chavePublica(foraDaCurva.toString('base64url')), null);
  // A chave lida é uma pública EC P-256.
  assert.equal(publicaCol.type, 'public');
  assert.equal(publicaCol.asymmetricKeyType, 'ec');
  assert.equal(publicaCol.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('(c) comando assinado no navegador confere no coletor com a chave pública do aparelho', async () => {
  const dados = { texto: 'olá, mundo', visto: { projeto: 'moises', nome: null } };
  const agora = 1794387000000;
  const cmd = await assinar({ tipo: 'mensagem', chave: SESSAO, dados }, agora);

  assert.deepEqual(Object.keys(cmd).sort(), ['assinatura', 'chave', 'criadoEm', 'dados', 'id', 'kid', 'tipo', 'v']);
  assert.equal(cmd.v, 1);
  assert.equal(cmd.kid, doNavegador.kid);
  assert.match(cmd.id, /^c_[0-9a-f]{16}$/);
  assert.equal(cmd.tipo, 'mensagem');
  assert.equal(cmd.chave, SESSAO);
  assert.equal(cmd.criadoEm, agora);
  assert.equal(cmd.dados, JSON.stringify(dados));
  // ECDSA SHA-256 em IEEE P1363 (64 bytes) e base64url sem '=': 86 caracteres.
  assert.match(cmd.assinatura, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(Buffer.from(cmd.assinatura, 'base64url').length, 64);
  assert.equal(col.assinaturaConfere(publicaCol, cmd), true);

  // O texto assinado não mudou, e a conferência independente com node:crypto bate.
  const texto = JSON.stringify(['moises-cmd-v1', cmd.kid, cmd.id, 'mensagem', SESSAO, agora, cmd.dados]);
  assert.equal(nav.textoDoComando(cmd), texto);
  assert.equal(col.textoDoComando(cmd), texto);
  assert.equal(crypto.verify('sha256', Buffer.from(texto), { key: publicaCol, dsaEncoding: 'ieee-p1363' }, Buffer.from(cmd.assinatura, 'base64url')), true);

  // Ids sorteados: dois comandos iguais não repetem id nem assinatura; o padrão de `agora` é Date.now().
  const antes = Date.now();
  const outro = await assinar({ tipo: 'mensagem', chave: SESSAO, dados });
  assert.notEqual(outro.id, cmd.id);
  assert.notEqual(outro.assinatura, cmd.assinatura);
  assert.ok(outro.criadoEm >= antes && outro.criadoEm <= Date.now());
  assert.equal(col.assinaturaConfere(publicaCol, outro), true);

  // A pública de outro aparelho não confere; e uma assinatura do Node confere com a mesma regra.
  const alheio = aparelhoDoNode();
  assert.equal(col.assinaturaConfere(col.chavePublica(alheio.publica), cmd), false);
  const doNode = assinarCom(alheio.privada, { ...cmd, kid: alheio.kid });
  assert.equal(col.assinaturaConfere(col.chavePublica(alheio.publica), doNode), true);
  assert.equal(col.assinaturaConfere(publicaCol, doNode), false);
});

test('(d) alterar kid, id, tipo, chave, criadoEm ou dados faz a conferência falhar', async () => {
  const cmd = await assinar(
    { tipo: 'permissao', chave: SESSAO, dados: { pedido: 'p1', decisao: 'negar', visto: { projeto: 'x', nome: 'y' } } },
    1794387000000,
  );
  assert.equal(col.assinaturaConfere(publicaCol, cmd), true);
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
    assert.equal(col.assinaturaConfere(publicaCol, alterado), false, `alterar ${campo} deveria falhar`);
  }
});

test('(e) assinaturaConfere devolve false, sem lançar, para qualquer formato inválido, inclusive a assinatura HMAC antiga', async () => {
  const cmd = await assinar({ tipo: 'interromper', chave: SESSAO, dados: { visto: { projeto: 'x', nome: null } } });
  const { assinatura, ...semAssinatura } = cmd;
  // HMAC-SHA256 em base64url (43 caracteres): o formato do código do aparelho, que não vale mais.
  const hmac = crypto.createHmac('sha256', crypto.randomBytes(32)).update(col.textoDoComando(cmd)).digest('base64url');
  assert.equal(hmac.length, 43);
  const assinaturas = [undefined, null, '', 'abc', hmac, `${assinatura}A`, assinatura.slice(0, 85), `${assinatura.slice(0, 85)}=`,
    `${assinatura.slice(0, 85)}+`, `${assinatura.slice(0, 84)}==`, 42, {}, [assinatura], Buffer.from(assinatura, 'base64url'), 'A'.repeat(86)];
  assert.equal(col.assinaturaConfere(publicaCol, semAssinatura), false);
  for (const a of assinaturas) {
    assert.equal(col.assinaturaConfere(publicaCol, { ...cmd, assinatura: a }), false, `assinatura ${String(a).slice(0, 20)}`);
  }
  // O último caractere de 86 carrega 4 bits de enchimento: a variante não canônica decodifica para os
  // mesmos 64 bytes, mas não é a assinatura emitida e é recusada.
  const naoCanonica = assinatura.slice(0, 85) + B64URL[B64URL.indexOf(assinatura[85]) ^ 1];
  assert.deepEqual(Buffer.from(naoCanonica, 'base64url'), Buffer.from(assinatura, 'base64url'));
  assert.equal(col.assinaturaConfere(publicaCol, { ...cmd, assinatura: naoCanonica }), false);
  // A mesma assinatura em DER também é recusada (só IEEE P1363).
  const der = crypto.sign('sha256', Buffer.from(col.textoDoComando(cmd)), aparelhoDoNode().privada).toString('base64url');
  assert.equal(col.assinaturaConfere(publicaCol, { ...cmd, assinatura: der }), false);
  // Comando, campos ou chave em formato inválido também dão false, nunca exceção.
  const circular = {};
  circular.eu = circular;
  const privadaNode = aparelhoDoNode().privada;
  const casos = [
    [publicaCol, undefined],
    [publicaCol, null],
    [publicaCol, 'texto'],
    [publicaCol, { ...cmd, criadoEm: 10n }],
    [publicaCol, { ...cmd, criadoEm: '1794387000000' }],
    [publicaCol, { ...cmd, criadoEm: 1.5 }],
    [publicaCol, { ...cmd, dados: circular }],
    [publicaCol, { ...cmd, kid: 7 }],
    [publicaCol, { ...cmd, chave: 7 }],
    [publicaCol, Object.defineProperty({ ...cmd }, 'dados', { get() { throw new Error('armadilha'); } })],
    [undefined, cmd],
    [null, cmd],
    ['texto', cmd],
    [Buffer.alloc(32), cmd],
    [doNavegador.publica, cmd], // a pública em texto, não lida como chave
    [privadaNode, cmd], // chave privada no lugar da pública
    [crypto.createSecretKey(crypto.randomBytes(32)), cmd],
    [crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey, cmd],
    [crypto.generateKeyPairSync('ed25519').publicKey, cmd],
  ];
  for (const [chave, c] of casos) assert.equal(col.assinaturaConfere(chave, c), false);
});

test('(f) hashVisto dá o mesmo valor nos dois módulos e muda quando a entrada muda', async () => {
  const entrada = '{"command":"rm -rf build/","description":"limpa"} çã 😀';
  const h = await nav.hashVisto('Bash', entrada);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(col.hashVisto('Bash', entrada), h);
  assert.equal(h, crypto.createHash('sha256').update(`Bash\n${entrada}`).digest('hex'));
  assert.notEqual(await nav.hashVisto('Bash', `${entrada} `), h);
  assert.notEqual(col.hashVisto('Bash', `${entrada} `), h);
  assert.notEqual(col.hashVisto('Edit', entrada), h);
});

test('(g) chave null assina como string vazia', async () => {
  const cmd = await assinar({ tipo: 'abrir', dados: { projeto: 'moises', pedido: 'oi' } }, 1794387000000);
  assert.equal(cmd.chave, null);
  for (const mod of [nav, col]) {
    const texto = mod.textoDoComando(cmd);
    assert.equal(JSON.parse(texto)[4], '');
    assert.equal(texto, mod.textoDoComando({ ...cmd, chave: '' }));
  }
  assert.equal(col.assinaturaConfere(publicaCol, cmd), true);
  assert.equal(col.assinaturaConfere(publicaCol, { ...cmd, chave: '' }), true);
  // Sem `dados`, o padrão é um objeto vazio.
  const semDados = await assinar({ tipo: 'abrir' });
  assert.equal(semDados.dados, '{}');
  assert.equal(col.assinaturaConfere(publicaCol, semDados), true);
});

test('(h) não existe mais código do aparelho nem chave derivada de segredo digitado', () => {
  for (const nome of ['normalizarCodigo', 'derivarChave', 'gerarCodigo', 'ALFABETO']) {
    assert.equal(nome in nav, false, `public/assinatura.js ainda exporta ${nome}`);
    assert.equal(nome in col, false, `collector/assinatura.js ainda exporta ${nome}`);
  }
});

test('(i) pedidoDeAparelho só aceita pedido coerente: kid da própria pública, chave na curva, rótulo visível de até 40', () => {
  // Um kid com ao menos uma letra, para o caso do kid maiúsculo ser outro kid de fato.
  let ap;
  do ap = aparelhoDoNode(null, 'celular do dono');
  while (!/[a-f]/.test(ap.kid));
  const bom = { kid: ap.kid, publica: ap.publica, rotulo: 'celular do dono', criadoEm: 1794387000000 };
  assert.deepEqual(col.pedidoDeAparelho(bom), bom);
  // Só os quatro campos saem, mesmo que venham outros.
  assert.deepEqual(col.pedidoDeAparelho({ ...bom, impressao: 'falsa', extra: 1 }), bom);
  const foraDaCurva = Buffer.from(ap.publica, 'base64url');
  foraDaCurva[64] ^= 1;
  const ruins = [
    null, 'texto', [],
    { ...bom, kid: 'ab2cd3' }, // kid que não é o da pública
    { ...bom, kid: ap.kid.toUpperCase() },
    { ...bom, publica: aparelhoDoNode().publica },
    { ...bom, publica: foraDaCurva.toString('base64url') },
    { ...bom, rotulo: '' },
    { ...bom, rotulo: 'a'.repeat(41) },
    { ...bom, rotulo: 'linha\nquebrada' },
    { ...bom, rotulo: `rtl${String.fromCodePoint(0x202e)}` },
    { ...bom, rotulo: 7 },
    { ...bom, criadoEm: '1794387000000' },
    { ...bom, criadoEm: 1.5 },
  ];
  for (const p of ruins) assert.equal(col.pedidoDeAparelho(p), null, JSON.stringify(p)?.slice(0, 60));
  // Rótulo com 40 letras acentuadas (40 caracteres) passa.
  assert.equal(col.pedidoDeAparelho({ ...bom, rotulo: 'ç'.repeat(40) }).rotulo, 'ç'.repeat(40));
});
