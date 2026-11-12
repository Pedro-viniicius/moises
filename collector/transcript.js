// Leitura incremental de um transcript .jsonl do Claude Code.
// Cada arquivo guarda a posição já lida; só as linhas novas são processadas.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { custo, tokensDe } from './precos.js';

const BLOCO = 4 * 1024 * 1024;
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
    primeiroPedido: null, // texto da primeira mensagem do dono (até MAX_TEXTO)
    ultimaResposta: null, // último bloco de texto do Claude (até MAX_TEXTO)
    ultimaRespostaEm: null,
  };
}

const MAX_TEXTO = 4000;

// Texto de uma mensagem: string, ou os blocos `text` (blocos `tool_result` e outros não contam).
function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return '';
  return conteudo
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// O último bloco `text` não vazio de uma resposta do Claude.
function ultimoTexto(conteudo) {
  if (typeof conteudo === 'string') return conteudo.trim() ? conteudo : null;
  if (!Array.isArray(conteudo)) return null;
  for (let i = conteudo.length - 1; i >= 0; i--) {
    const b = conteudo[i];
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
  }
  return null;
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
        const fala = ultimoTexto(m.content);
        if (fala) {
          est.ultimaResposta = fala.slice(0, MAX_TEXTO);
          est.ultimaRespostaEm = Number.isFinite(ts) ? ts : null;
        }
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
    case 'user': {
      if (!principal || est.primeiroPedido != null || e.isSidechain || e.isMeta) return;
      const texto = textoDe(e.message?.content).trim();
      // Mensagens que começam com "<" são comandos e avisos do próprio Claude Code, não pedidos.
      if (texto && !texto.startsWith('<')) est.primeiroPedido = texto.slice(0, MAX_TEXTO);
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
    if (st.size < est.offset) Object.assign(est, novoEstado(), { decoder: null }); // arquivo truncado/recriado
    if (st.size === est.offset) return false;
    fd = fs.openSync(caminho, 'r');
    // Em blocos, para um transcript de dezenas de MB não ocupar memória de uma vez.
    const buf = Buffer.alloc(BLOCO);
    const dec = (est.decoder ||= new StringDecoder('utf8'));
    while (est.offset < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(BLOCO, st.size - est.offset), est.offset);
      if (n <= 0) break;
      est.offset += n;
      const linhas = (est.resto + dec.write(buf.subarray(0, n))).split('\n');
      est.resto = linhas.pop(); // linha incompleta fica para o próximo bloco
      for (const l of linhas) if (l.trim()) processarLinha(est, l, opts);
    }
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') est.linhasRuins++;
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// Soma custos e tokens das respostas, opcionalmente filtrando por dia.
export function somar(estados, dia = null, ignorar = null) {
  const total = { custo: 0, tokens: { input: 0, output: 0, read: 0, w5m: 0, w1h: 0 }, porModelo: {} };
  for (const est of estados) {
    for (const [chave, r] of est.respostas) {
      if (dia && r.dia !== dia) continue;
      if (ignorar?.has(chave)) continue;
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
