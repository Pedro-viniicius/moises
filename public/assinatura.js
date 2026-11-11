// Assinatura dos comandos do painel, do lado do navegador. Módulo ES que usa só globalThis.crypto
// (WebCrypto): nada de DOM, IndexedDB ou rede, e por isso também roda no Node >= 22 nos testes.
// A mesma regra, com node:crypto, está em collector/assinatura.js; o contrato está no PLANO
// ("Contrato comum"). A chave é derivada do código do aparelho e fica num CryptoKey NÃO extraível:
// o código do painel consegue assinar com ela, mas não copiá-la para fora do navegador.

const SAL = 'moises-comandos-v1';
const ITERACOES = 210_000;
const PREFIXO = 'moises-cmd-v1';
const TAMANHO_CODIGO = 22;
const TAMANHO_KID = 6;

const utf8 = (texto) => new TextEncoder().encode(texto);

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Minúsculas e só [a-z0-9]; o resultado tem de ter 22 caracteres. Qualquer outra coisa: null.
export function normalizarCodigo(codigo) {
  if (typeof codigo !== 'string') return null;
  const normal = codigo.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normal.length === TAMANHO_CODIGO ? normal : null;
}

// PBKDF2-SHA256 (sal fixo, 210.000 iterações) direto para uma chave HMAC-SHA256 de 32 bytes,
// não extraível e só com o uso 'sign'. A mensagem de erro nunca cita o código.
export async function derivarChave(codigo) {
  const normal = normalizarCodigo(codigo);
  if (!normal) throw new Error('Código inválido.');
  const sutil = globalThis.crypto.subtle;
  const base = await sutil.importKey('raw', utf8(normal), 'PBKDF2', false, ['deriveKey']);
  const chave = await sutil.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8(SAL), iterations: ITERACOES },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return { kid: normal.slice(0, TAMANHO_KID), chave };
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
  const assinatura = await globalThis.crypto.subtle.sign('HMAC', chave, utf8(textoDoComando(cmd)));
  return { ...cmd, assinatura: base64url(new Uint8Array(assinatura)) };
}

// Impressão digital do pedido de permissão que apareceu na tela: SHA-256 de ferramenta + '\n' + entrada.
export async function hashVisto(ferramenta, entrada) {
  const resumo = await globalThis.crypto.subtle.digest('SHA-256', utf8(`${ferramenta}\n${entrada}`));
  return hex(new Uint8Array(resumo));
}
