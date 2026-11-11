// Assinatura dos comandos do painel, do lado do coletor (node:crypto, síncrono). A mesma regra
// do navegador (public/assinatura.js); o contrato está no PLANO ("Contrato comum").
// Aqui só se confere a assinatura: formato dos campos, aparelho, validade e repetição ficam no porteiro.
import crypto from 'node:crypto';

export const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const SAL = 'moises-comandos-v1';
const ITERACOES = 210_000;
const PREFIXO = 'moises-cmd-v1';
const TAMANHO_CODIGO = 22;
const TAMANHO_KID = 6;
const TAMANHO_CHAVE = 32;
const RE_ASSINATURA = /^[A-Za-z0-9_-]{43}$/;

const sortear = (n) => Array.from({ length: n }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('');

// Código do aparelho: `kid` de 6 caracteres e quatro grupos de 4, todos do ALFABETO.
export function gerarCodigo() {
  return [sortear(TAMANHO_KID), sortear(4), sortear(4), sortear(4), sortear(4)].join('-');
}

// Minúsculas e só [a-z0-9]; o resultado tem de ter 22 caracteres. Qualquer outra coisa: null.
export function normalizarCodigo(codigo) {
  if (typeof codigo !== 'string') return null;
  const normal = codigo.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normal.length === TAMANHO_CODIGO ? normal : null;
}

// PBKDF2-SHA256 do código normalizado: 32 bytes usados como chave HMAC-SHA256.
// A mensagem de erro nunca cita o código.
export function derivarChave(codigo) {
  const normal = normalizarCodigo(codigo);
  if (!normal) throw new Error('Código inválido.');
  const chave = crypto.pbkdf2Sync(normal, SAL, ITERACOES, TAMANHO_CHAVE, 'sha256');
  return { kid: normal.slice(0, TAMANHO_KID), chave };
}

// Texto assinado: JSON de lista com prefixo de versão, sem ambiguidade entre campos (achado S7).
export function textoDoComando({ kid, id, tipo, chave, criadoEm, dados }) {
  return JSON.stringify([PREFIXO, kid, id, tipo, chave ?? '', criadoEm, dados]);
}

// true só se a assinatura confere com a chave. Para qualquer chave, comando ou campo em formato
// inválido devolve false, sem lançar. Cada campo é lido uma única vez (um getter não troca o valor
// entre a checagem e a conta) e a comparação é em tempo constante, sobre o texto base64url canônico.
export function assinaturaConfere(chave, cmd) {
  try {
    if (!(chave instanceof Uint8Array) || chave.length !== TAMANHO_CHAVE) return false;
    if (cmd === null || typeof cmd !== 'object') return false;
    const { kid, id, tipo, chave: sessao, criadoEm, dados, assinatura } = cmd;
    if (typeof assinatura !== 'string' || !RE_ASSINATURA.test(assinatura)) return false;
    if (typeof kid !== 'string' || typeof id !== 'string' || typeof tipo !== 'string') return false;
    if (sessao != null && typeof sessao !== 'string') return false;
    if (!Number.isSafeInteger(criadoEm) || typeof dados !== 'string') return false;
    const esperada = crypto
      .createHmac('sha256', chave)
      .update(textoDoComando({ kid, id, tipo, chave: sessao, criadoEm, dados }), 'utf8')
      .digest('base64url');
    const a = Buffer.from(assinatura, 'utf8');
    const b = Buffer.from(esperada, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Impressão digital do pedido de permissão: SHA-256 de ferramenta + '\n' + entrada, em hexadecimal.
export function hashVisto(ferramenta, entrada) {
  return crypto.createHash('sha256').update(`${ferramenta}\n${entrada}`, 'utf8').digest('hex');
}
