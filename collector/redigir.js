// Nada que pareça segredo sai da máquina. Aplicado a todo texto livre enviado ao site.
const PADROES = [
  /sk-[A-Za-z0-9_-]{16,}/g, // chaves de API (Anthropic, OpenAI…)
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g, // tokens do GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // hex longo (hashes, tokens)
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // base64 longo
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // e-mails
  /\b(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, // telefones
  /\b(senha|password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
];

export function redigir(texto, max = 200) {
  if (texto == null) return null;
  let s = String(texto).replace(/\s+/g, ' ').trim();
  for (const re of PADROES) s = s.replace(re, '[oculto]');
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s || null;
}
