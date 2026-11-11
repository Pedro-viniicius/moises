// Assinatura dos comandos do painel, do lado do navegador. Módulo ES que usa só globalThis.crypto
// (WebCrypto): nada de DOM, IndexedDB ou rede, e por isso também roda no Node >= 22 nos testes.
// O aparelho gera um par ECDSA P-256 com a chave privada NÃO extraível: o código do painel consegue
// assinar com ela, mas não copiá-la para fora do navegador. Só a chave pública sai daqui, para o dono
// autorizar no computador conferindo a impressão digital (achado A1). Nada secreto é digitado na página.
// A conferência, com node:crypto, está em collector/assinatura.js; o contrato está no PLANO
// ("Contrato comum" e tarefa 15).

const PREFIXO = 'moises-cmd-v1';
const ALGORITMO = { name: 'ECDSA', namedCurve: 'P-256' };
const ASSINATURA = { name: 'ECDSA', hash: 'SHA-256' }; // WebCrypto devolve r || s (IEEE P1363, 64 bytes)
const RE_PUBLICA = /^[A-Za-z0-9_-]{87}$/;
const TAMANHO_PUBLICA = 65;

const utf8 = (texto) => new TextEncoder().encode(texto);

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64url(texto) {
  const bin = atob(texto.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// `kid` = 6 primeiros hexadecimais do SHA-256 da pública `raw`; impressão digital = 16 primeiros, em
// 4 grupos de 4. A pública tem de ser base64url canônico de 65 bytes começando por 0x04; senão rejeita.
export async function impressaoDaPublica(publica) {
  if (typeof publica !== 'string' || !RE_PUBLICA.test(publica)) throw new Error('Chave pública inválida.');
  const bytes = deBase64url(publica);
  if (bytes.length !== TAMANHO_PUBLICA || bytes[0] !== 4 || base64url(bytes) !== publica) throw new Error('Chave pública inválida.');
  const h = hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  return { kid: h.slice(0, 6), impressao: h.slice(0, 16).match(/.{4}/g).join('-') };
}

// Gera o par deste aparelho: { kid, chave: CryptoKey privada não extraível (só 'sign'), publica: base64url
// da pública `raw`, impressao }. A chave pública é sempre exportável; a privada nunca.
export async function gerarAparelho() {
  const sutil = globalThis.crypto.subtle;
  const par = await sutil.generateKey(ALGORITMO, false, ['sign']);
  const publica = base64url(new Uint8Array(await sutil.exportKey('raw', par.publicKey)));
  const { kid, impressao } = await impressaoDaPublica(publica);
  return { kid, chave: par.privateKey, publica, impressao };
}

// Texto assinado: JSON de lista com prefixo de versão, sem ambiguidade entre campos (achado S7).
export function textoDoComando({ kid, id, tipo, chave, criadoEm, dados }) {
  return JSON.stringify([PREFIXO, kid, id, tipo, chave ?? '', criadoEm, dados]);
}

function novoId() {
  return `c_${hex(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`;
}

// Monta e assina um comando. `dados` vira string aqui, uma vez: o coletor confere a assinatura
// sobre essa mesma string e só depois faz o JSON.parse.
export async function assinarComando({ kid, chave }, { tipo, chave: sessao = null, dados = {} }, agora = Date.now()) {
  const cmd = { v: 1, kid, id: novoId(), tipo, chave: sessao, criadoEm: agora, dados: JSON.stringify(dados) };
  const assinatura = await globalThis.crypto.subtle.sign(ASSINATURA, chave, utf8(textoDoComando(cmd)));
  return { ...cmd, assinatura: base64url(new Uint8Array(assinatura)) };
}

// Impressão digital do pedido de permissão que apareceu na tela: SHA-256 de ferramenta + '\n' + entrada.
export async function hashVisto(ferramenta, entrada) {
  const resumo = await globalThis.crypto.subtle.digest('SHA-256', utf8(`${ferramenta}\n${entrada}`));
  return hex(new Uint8Array(resumo));
}
