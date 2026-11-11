// Assinatura dos comandos do painel, do lado do coletor (node:crypto, síncrono). O aparelho assina com
// a chave privada ECDSA P-256 que gerou e que não sai dele (public/assinatura.js); aqui só existe a
// chave pública, autorizada pelo dono no terminal (scripts/configurar-comandos.js, achado A1). O contrato
// está no PLANO ("Contrato comum" e tarefa 15). Formato dos campos, aparelho, validade e repetição ficam
// no porteiro (collector/comandos.js).
import crypto from 'node:crypto';

const PREFIXO = 'moises-cmd-v1';
const TAMANHO_KID = 6;
const TAMANHO_IMPRESSAO = 16;
const TAMANHO_PUBLICA = 65; // 0x04 || x (32) || y (32)
const TAMANHO_ASSINATURA = 64; // IEEE P1363: r (32) || s (32)
export const RE_PUBLICA = /^[A-Za-z0-9_-]{87}$/;
// Formato da assinatura (64 bytes em base64url sem '='). O porteiro (collector/comandos.js) usa esta.
export const RE_ASSINATURA = /^[A-Za-z0-9_-]{86}$/;
// O kid: 6 hexadecimais minúsculos (o começo do SHA-256 da pública). A única regex de kid do coletor:
// o porteiro e o chaveiro (collector/comandos.js) usam esta (SE-B3).
export const RE_KID = /^[0-9a-f]{6}$/;
const MAX_ROTULO = 40;
// Controle, formatação (inclusive direção de texto) e separadores de linha: nada disso num rótulo.
const INVISIVEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// Base64url canônico (sem '=' e com os bits de enchimento zerados) com o tamanho esperado; senão null.
function decodificar(texto, re, tamanho) {
  if (typeof texto !== 'string' || !re.test(texto)) return null;
  const bytes = Buffer.from(texto, 'base64url');
  if (bytes.length !== tamanho || bytes.toString('base64url') !== texto) return null;
  return bytes;
}

// Bytes da chave pública `raw` (ponto não comprimido) ou null. Não confere se o ponto está na curva.
function bytesDaPublica(publica) {
  const bytes = decodificar(publica, RE_PUBLICA, TAMANHO_PUBLICA);
  return bytes && bytes[0] === 4 ? bytes : null;
}

// `kid` = 6 primeiros hexadecimais do SHA-256 da pública `raw`; impressão digital = 16 primeiros, em
// 4 grupos de 4 (a1b2-c3d4-e5f6-0718). null se a pública estiver fora do formato.
export function impressaoDaPublica(publica) {
  const bytes = bytesDaPublica(publica);
  if (!bytes) return null;
  const h = crypto.createHash('sha256').update(bytes).digest('hex');
  return { kid: h.slice(0, TAMANHO_KID), impressao: h.slice(0, TAMANHO_IMPRESSAO).match(/.{4}/g).join('-') };
}

// KeyObject da chave pública P-256, ou null se o texto estiver fora do formato ou o ponto fora da curva
// (o OpenSSL recusa ao montar a chave).
export function chavePublica(publica) {
  const bytes = bytesDaPublica(publica);
  if (!bytes) return null;
  try {
    const jwk = { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') };
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return null;
  }
}

const ehPublicaP256 = (k) =>
  k instanceof crypto.KeyObject && k.type === 'public' && k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1';

// Texto assinado: JSON de lista com prefixo de versão, sem ambiguidade entre campos (achado S7).
export function textoDoComando({ kid, id, tipo, chave, criadoEm, dados }) {
  return JSON.stringify([PREFIXO, kid, id, tipo, chave ?? '', criadoEm, dados]);
}

// true só se a assinatura ECDSA SHA-256 (IEEE P1363, base64url canônico de 86 caracteres) confere com a
// chave pública. Para qualquer chave, comando ou campo em formato inválido devolve false, sem lançar.
// Cada campo é lido uma única vez (um getter não troca o valor entre a checagem e a conta).
export function assinaturaConfere(chave, cmd) {
  try {
    if (!ehPublicaP256(chave)) return false;
    if (cmd === null || typeof cmd !== 'object') return false;
    const { kid, id, tipo, chave: sessao, criadoEm, dados, assinatura } = cmd;
    const bytes = decodificar(assinatura, RE_ASSINATURA, TAMANHO_ASSINATURA);
    if (!bytes) return false;
    if (typeof kid !== 'string' || typeof id !== 'string' || typeof tipo !== 'string') return false;
    if (sessao != null && typeof sessao !== 'string') return false;
    if (!Number.isSafeInteger(criadoEm) || typeof dados !== 'string') return false;
    const texto = Buffer.from(textoDoComando({ kid, id, tipo, chave: sessao, criadoEm, dados }), 'utf8');
    return crypto.verify('sha256', texto, { key: chave, dsaEncoding: 'ieee-p1363' }, bytes);
  } catch {
    return false;
  }
}

// Rótulo de aparelho: de 1 a 40 caracteres, sem controle nem caractere invisível, não só de espaços.
export function rotuloValido(rotulo) {
  if (typeof rotulo !== 'string' || !rotulo.trim() || INVISIVEL.test(rotulo)) return false;
  const n = Array.from(rotulo).length;
  return n >= 1 && n <= MAX_ROTULO;
}

// Pedido de pareamento vindo do servidor (que não é confiável): devolve um objeto novo só com
// { kid, publica, rotulo, criadoEm } se tudo for coerente (o kid é o da própria chave pública e o ponto
// está na curva), ou null.
export function pedidoDeAparelho(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const { kid, publica, rotulo, criadoEm } = p;
  if (typeof kid !== 'string' || !RE_KID.test(kid)) return null;
  const id = impressaoDaPublica(publica);
  if (!id || id.kid !== kid || !chavePublica(publica)) return null;
  if (!rotuloValido(rotulo) || !Number.isSafeInteger(criadoEm)) return null;
  return { kid, publica, rotulo, criadoEm };
}

// Impressão digital do pedido de permissão: SHA-256 de ferramenta + '\n' + entrada, em hexadecimal.
export function hashVisto(ferramenta, entrada) {
  return crypto.createHash('sha256').update(`${ferramenta}\n${entrada}`, 'utf8').digest('hex');
}
