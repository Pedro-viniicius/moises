// Leitura incremental de um transcript .jsonl do Claude Code.
// Cada arquivo guarda a posição já lida; só as linhas novas são processadas.
import fs from 'node:fs';
import { custo, tokensDe } from './precos.js';

export const FUSO = process.env.MOISES_FUSO || 'America/Sao_Paulo';
const fmtDia = new Intl.DateTimeFormat('sv-SE', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
export const diaLocal = (ms) => fmtDia.format(new Date(ms));

export function novoEstado() {
  return {
    offset: 0,
    resto: '',
    respostas: new Map(), // message.id+requestId → { model, dia, ts, custo, tokens }
    modelo: null,
    esforco: null,
    tituloIA: null,
    tituloManual: null,
    resumo: null,
    primeiraAtividade: null,
    ultimaAtividade: null,
    cwd: null,
    modelosDesconhecidos: new Set(),
    linhasRuins: 0,
    custoOficial: null, // último cost-state: { total, inicio }
  };
}

function processarLinha(est, linha, { principal }) {
  let e;
  try {
    e = JSON.parse(linha);
  } catch {
    est.linhasRuins++;
    return;
  }
  if (!e || typeof e !== 'object') return;
  const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
  if ((e.type === 'user' || e.type === 'assistant') && Number.isFinite(ts)) {
    if (est.primeiraAtividade == null || ts < est.primeiraAtividade) est.primeiraAtividade = ts;
    if (est.ultimaAtividade == null || ts > est.ultimaAtividade) est.ultimaAtividade = ts;
    if (e.cwd) est.cwd = e.cwd;
  }
  switch (e.type) {
    case 'assistant': {
      const m = e.message;
      if (!m || typeof m !== 'object') return;
      const model = m.model;
      if (principal && !e.isSidechain && model && model !== '<synthetic>') {
        est.modelo = model;
        if (e.effort) est.esforco = e.effort;
      }
      if (!m.usage || !model || model === '<synthetic>') return;
      // A mesma resposta aparece uma vez por bloco de conteúdo: a última leitura vale.
      const chave = `${m.id || ''}|${e.requestId || e.uuid || ''}`;
      const c = custo(model, m.usage);
      if (c == null) est.modelosDesconhecidos.add(model);
      est.respostas.set(chave, {
        model,
        ts,
        dia: Number.isFinite(ts) ? diaLocal(ts) : null,
        custo: c ?? 0,
        tokens: tokensDe(m.usage),
      });
      return;
    }
    case 'cost-state':
      if (principal && typeof e.totalCostUSD === 'number') est.custoOficial = { total: e.totalCostUSD, inicio: e.startTime ?? null };
      return;
    case 'ai-title':
      if (principal && e.aiTitle) est.tituloIA = e.aiTitle;
      return;
    case 'custom-title':
      if (principal && e.customTitle) est.tituloManual = e.customTitle;
      return;
    case 'system':
      if (principal && e.subtype === 'away_summary' && typeof e.content === 'string') est.resumo = e.content;
      return;
    default:
  }
}

// Lê o que foi acrescentado ao arquivo desde a última vez.
export function lerNovidades(caminho, est, opts = { principal: true }) {
  let fd;
  try {
    const st = fs.statSync(caminho);
    if (st.size < est.offset) Object.assign(est, novoEstado()); // arquivo truncado/recriado
    if (st.size === est.offset) return false;
    fd = fs.openSync(caminho, 'r');
    const tamanho = st.size - est.offset;
    const buf = Buffer.alloc(tamanho);
    fs.readSync(fd, buf, 0, tamanho, est.offset);
    est.offset = st.size;
    const texto = est.resto + buf.toString('utf8');
    const linhas = texto.split('\n');
    est.resto = linhas.pop(); // linha incompleta fica para a próxima leitura
    for (const l of linhas) if (l.trim()) processarLinha(est, l, opts);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') est.linhasRuins++;
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// Soma custos e tokens das respostas, opcionalmente filtrando por dia.
export function somar(estados, dia = null) {
  const total = { custo: 0, tokens: { input: 0, output: 0, read: 0, w5m: 0, w1h: 0 }, porModelo: {} };
  for (const est of estados) {
    for (const r of est.respostas.values()) {
      if (dia && r.dia !== dia) continue;
      total.custo += r.custo;
      const pm = (total.porModelo[r.model] ||= { custo: 0, tokens: 0 });
      pm.custo += r.custo;
      for (const k of Object.keys(total.tokens)) {
        total.tokens[k] += r.tokens[k];
        pm.tokens += r.tokens[k];
      }
    }
  }
  return total;
}
