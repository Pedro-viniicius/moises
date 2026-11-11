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

// No bloco (pedido de permissão), o "base64 longo" não pode pegar caminho de arquivo: um pedido
// quase sempre tem caminho, e pedido mascarado não pode ser aprovado. Vira três padrões mais estreitos.
const BASE64_LONGO = PADROES.findIndex((re) => re.source.includes('{40,}'));
const PADROES_BLOCO = [
  ...PADROES.slice(0, BASE64_LONGO),
  /\b[A-Za-z0-9+_-]{40,}/g, // sem barra
  /\b[A-Za-z0-9+/]{40,}={1,2}/g, // com preenchimento
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*\+)[A-Za-z0-9+/]{40,}/g, // com ao menos um "+"
  ...PADROES.slice(BASE64_LONGO + 1),
];

function mascarar(s, padroes = PADROES) {
  s = s.replace(CARTAO, (m) => {
    const digitos = m.replace(/\D/g, '');
    return digitos.length >= 13 && digitos.length <= 19 && passaNoLuhn(digitos) ? '[oculto]' : m;
  });
  for (const re of padroes) s = s.replace(re, '[oculto]');
  return s;
}

export function redigir(texto, max = 200) {
  if (texto == null) return null;
  // Corta antes das regex: texto enorme não pode travar o coletor.
  let s = mascarar(String(texto).slice(0, Math.max(4 * max, 1000)).replace(/\s+/g, ' ').trim());
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s || null;
}

// Tudo o que não se vê ou engana: controle (menos \n e \t), formato (direção de texto, largura zero, etiquetas),
// uso privado, substitutos soltos, separadores de linha e de parágrafo, espaços que não são o comum,
// seletores de variação e preenchedores. O painel mostra o escape no lugar do caractere,
// para o dono ver o que um texto escondia.
const INVISIVEIS = /(?![\n\t ])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;
const escapar = (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;

// Formas de esconder parte de um pedido na tela do celular (S14/A2): muitas linhas, linhas em branco
// em fila (3 quebras com só espaço ou tabulação entre elas), espaço ou tabulação em fila, ou no fim de linha.
const MAX_LINHAS_INTEIRO = 30;
const ESCONDE = [/\n[ \t]*\n[ \t]*\n/, /[ \t]{16,}/, /[ \t](\n|$)/];

// Verdadeiro se o texto publicado pode estar escondendo conteúdo: um pedido assim não conta como inteiro.
// O que não for texto também não conta como inteiro.
export function escondeConteudo(texto) {
  if (typeof texto !== 'string') return true;
  if (texto.split('\n').length > MAX_LINHAS_INTEIRO) return true;
  return ESCONDE.some((re) => re.test(texto));
}

// Redação de um bloco de texto (pedido de permissão): mantém quebras de linha, tabulações e espaços,
// mascara os mesmos padrões de `redigir`, escapa os caracteres invisíveis e corta em `max`.
// `alterado` diz se qualquer uma dessas coisas mudou o texto: o chamador não pode tratar como inteiro o que mudou.
export function redigirBloco(texto, max = 4000) {
  if (texto == null) return { texto: '', alterado: false };
  const original = String(texto);
  // Corta antes das regex: texto enorme não pode travar o coletor.
  let s = original.slice(0, Math.max(4 * max, 1000));
  s = mascarar(s, PADROES_BLOCO).replace(INVISIVEIS, escapar);
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return { texto: s, alterado: s !== original };
}
