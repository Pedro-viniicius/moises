// Preços em US$ por milhão de tokens (API da Anthropic, tabela de 2026-11-03).
// Conferidos contra o `cost-state` que o próprio Claude Code grava nos transcripts.
// read = leitura de cache; w5m / w1h = escrita de cache de 5 min / 1 h.
const P = (input, output, read, w5m = input * 1.25, w1h = input * 2) => ({ input, output, read, w5m, w1h });

export const PRECOS = {
  'claude-fable-5-2': P(8, 40, 0.2),
  'claude-mythos-5-2': P(8, 40, 0.2),
  'claude-fable-5-1': P(10, 50, 1),
  'claude-mythos-5-1': P(10, 50, 1),
  'claude-fable-5': P(10, 50, 1),
  'claude-opus-5-5': P(4, 20, 0.2),
  'claude-opus-5': P(5, 25, 0.5),
  'claude-opus-4-8': P(5, 25, 0.5),
  'claude-opus-4-7': P(5, 25, 0.5),
  'claude-opus-4-6': P(5, 25, 0.5),
  'claude-opus-4-5': P(5, 25, 0.5),
  'claude-sonnet-5-5': P(2, 10, 0.1),
  'claude-sonnet-5': P(2, 10, 0.2),
  'claude-sonnet-4-6': P(3, 15, 0.3),
  'claude-sonnet-4-5': P(3, 15, 0.3),
  'claude-haiku-5-5': P(0.1, 0.5, 0.01),
  'claude-haiku-4-5': P(1, 5, 0.1),
};

// Haiku 5.5: acima de 100 mil tokens de entrada na requisição, vale a faixa cara.
const HAIKU_55_LONGO = P(0.5, 2.5, 0.05);

export function precoDoModelo(model) {
  if (!model) return null;
  const base = model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  return PRECOS[base] || null;
}

export function tokensDe(usage = {}) {
  const cc = usage.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  let w5m = cc.ephemeral_5m_input_tokens ?? 0;
  const totalW = usage.cache_creation_input_tokens ?? 0;
  if (!w1h && !w5m && totalW) w5m = totalW;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
    w5m,
    w1h,
  };
}

// Custo em US$ de uma resposta. Retorna null se o modelo não estiver na tabela.
export function custo(model, usage = {}) {
  let p = precoDoModelo(model);
  if (!p) return null;
  const t = tokensDe(usage);
  if (model.startsWith('claude-haiku-5-5') && t.input + t.read + t.w5m + t.w1h > 100_000) p = HAIKU_55_LONGO;
  const mult = usage.speed === 'fast' ? 2 : 1;
  const usd = (t.input * p.input + t.output * p.output + t.read * p.read + t.w5m * p.w5m + t.w1h * p.w1h) / 1e6;
  return usd * mult;
}
