// Nada que pareça segredo sai da máquina. Aplicado a todo texto livre enviado ao site.
const PADROES = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:[^\s@]+@\S*/gi, // URL com usuário:senha
  /[\w-]{0,40}(secret|token|senha|password|passwd|pwd|api[_-]?key)\w{0,20}\s{0,5}[:=]\s{0,5}\S+/gi, // chave=valor (inclui client_secret=, access_token=)
  /\bsenha\s+(é|eh|era|:)\s*\S+/gi, // "a senha é X"
  /\bBearer\s+\S+/gi,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b[sprk]k_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, // CNPJ
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, // CPF
  /sk-[A-Za-z0-9_-]{16,}/g, // chaves de API (Anthropic, OpenAI…)
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g, // tokens do GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // hex longo (hashes, tokens)
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // base64 longo
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // e-mails
  /\b\d{5}-\d{3}\b/g, // CEP
  /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, // telefones
];

// Número de cartão: 13 a 19 dígitos, com espaços ou hífens entre eles. Só vale se passar no algoritmo de Luhn,
// para um número qualquer (id, data em ms) não ser mascarado à toa. Roda antes dos demais padrões,
// que mascarariam só um pedaço do número.
const CARTAO = /\b\d(?:[ -]?\d){12,18}\b/g;

function passaNoLuhn(digitos) {
  let soma = 0;
  for (let i = 0; i < digitos.length; i++) {
    let d = digitos.charCodeAt(digitos.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    soma += d;
  }
  return soma % 10 === 0;
}

function mascarar(s) {
  s = s.replace(CARTAO, (m) => {
    const digitos = m.replace(/\D/g, '');
    return digitos.length >= 13 && digitos.length <= 19 && passaNoLuhn(digitos) ? '[oculto]' : m;
  });
  for (const re of PADROES) s = s.replace(re, '[oculto]');
  return s;
}

export function redigir(texto, max = 200) {
  if (texto == null) return null;
  // Corta antes das regex: texto enorme não pode travar o coletor.
  let s = mascarar(String(texto).slice(0, Math.max(4 * max, 1000)).replace(/\s+/g, ' ').trim());
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s || null;
}

// Controle (menos \n e \t), direção de texto e largura zero: o painel mostra o escape no lugar do caractere,
// para o dono ver o que um texto escondia.
const INVISIVEIS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u200B-\u200D\u2060\uFEFF]/g;
const escapar = (c) => `\\u{${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;

// Redação de um bloco de texto (pedido de permissão): mantém quebras de linha, tabulações e espaços,
// mascara os mesmos padrões de `redigir`, escapa os caracteres invisíveis e corta em `max`.
// `alterado` diz se qualquer uma dessas coisas mudou o texto: o chamador não pode tratar como inteiro o que mudou.
export function redigirBloco(texto, max = 4000) {
  if (texto == null) return { texto: '', alterado: false };
  const original = String(texto);
  // Corta antes das regex: texto enorme não pode travar o coletor.
  let s = original.slice(0, Math.max(4 * max, 1000));
  s = mascarar(s).replace(INVISIVEIS, escapar);
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return { texto: s, alterado: s !== original };
}
