// Descobre as sessões do Claude Code nos diretórios de configuração e monta o retrato.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lerNovidades, novoEstado, somar, diaLocal } from './transcript.js';
import { redigir } from './redigir.js';

export const OCIOSA_APOS_MS = 15 * 60 * 1000;

export function diretoriosDeConfig(home = os.homedir()) {
  if (process.env.MOISES_CONFIG_DIRS) return process.env.MOISES_CONFIG_DIRS.split(':').filter(Boolean);
  return fs
    .readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === '.claude' || d.name.startsWith('.claude-')))
    .map((d) => path.join(home, d.name))
    .filter((d) => fs.existsSync(path.join(d, 'sessions')) || fs.existsSync(path.join(d, 'projects')));
}

const nomeConta = (dir) => path.basename(dir).replace(/^\.claude-?/, '') || 'principal';

// Início do processo em ticks (campo 22 de /proc/<pid>/stat), o mesmo valor que o Claude grava em procStart.
export function inicioDoProcesso(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const depoisDoNome = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return depoisDoNome[19]; // campo 22 contando pid e comm
  } catch {
    return null;
  }
}

export function processoConfere(reg) {
  if (!reg?.pid) return false;
  const inicio = inicioDoProcesso(reg.pid);
  return inicio != null && (reg.procStart == null || String(reg.procStart) === inicio);
}

function lerRegistros(dir) {
  const pasta = path.join(dir, 'sessions');
  const out = [];
  let nomes = [];
  try {
    nomes = fs.readdirSync(pasta);
  } catch {
    return out;
  }
  for (const n of nomes) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(pasta, n), 'utf8'));
      if (r.sessionId) out.push(r);
    } catch {
      /* arquivo sendo regravado: fica para o próximo ciclo */
    }
  }
  return out;
}

export function statusDe(reg, vivo, agora = Date.now()) {
  if (!vivo) return 'encerrada';
  const s = String(reg.status || '').toLowerCase();
  if (s === 'busy' || s === 'shell' || s === 'running') return 'ativa';
  if (s.includes('wait') || s.includes('perm') || s.includes('input')) return 'aguardando';
  const desde = reg.statusUpdatedAt || reg.updatedAt || 0;
  return agora - desde > OCIOSA_APOS_MS ? 'ociosa' : 'aguardando';
}

export class Coletor {
  constructor({ dirs = diretoriosDeConfig(), agora = () => Date.now() } = {}) {
    this.dirs = dirs;
    this.agora = agora;
    this.estados = new Map(); // caminho do arquivo → estado
    this.indice = new Map(); // `${dir}|${sessionId}` → { dir, principal, pastaSessao, mtime }
    this.indiceEm = 0;
  }

  // Lista os transcripts: <dir>/projects/<projeto>/<sessionId>.jsonl
  reindexar() {
    this.indice.clear();
    for (const dir of this.dirs) {
      const proj = path.join(dir, 'projects');
      let projetos = [];
      try {
        projetos = fs.readdirSync(proj, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const p of projetos) {
        const pasta = path.join(proj, p.name);
        let arquivos = [];
        try {
          arquivos = fs.readdirSync(pasta);
        } catch {
          continue;
        }
        for (const a of arquivos) {
          if (!a.endsWith('.jsonl')) continue;
          const id = a.slice(0, -6);
          const principal = path.join(pasta, a);
          let mtime = 0;
          try {
            mtime = fs.statSync(principal).mtimeMs;
          } catch {
            continue;
          }
          this.indice.set(`${dir}|${id}`, { dir, id, principal, pastaSessao: path.join(pasta, id), mtime });
        }
      }
    }
    this.indiceEm = this.agora();
  }

  estadoDe(caminho, principal) {
    let est = this.estados.get(caminho);
    if (!est) this.estados.set(caminho, (est = novoEstado()));
    lerNovidades(caminho, est, { principal });
    return est;
  }

  lerSessao(info) {
    const principal = this.estadoDe(info.principal, true);
    const subs = [];
    const pastaSub = path.join(info.pastaSessao, 'subagents');
    try {
      for (const a of fs.readdirSync(pastaSub)) {
        if (a.endsWith('.jsonl')) subs.push(this.estadoDe(path.join(pastaSub, a), false));
      }
    } catch {
      /* sem subagentes */
    }
    let tituloArquivo = null;
    try {
      tituloArquivo = JSON.parse(fs.readFileSync(path.join(info.pastaSessao, 'custom-title.json'), 'utf8')).customTitle;
    } catch {
      /* sem /rename */
    }
    return { principal, todos: [principal, ...subs], tituloArquivo };
  }

  // Retrato completo: sessões vivas + sessões com atividade hoje.
  retrato() {
    const agora = this.agora();
    const hoje = diaLocal(agora);
    if (agora - this.indiceEm > 60_000) this.reindexar();
    const inicioHoje = agora - 26 * 3600 * 1000; // margem para fuso; o filtro real é por dia
    const vivos = new Map();
    for (const dir of this.dirs) {
      for (const reg of lerRegistros(dir)) {
        const chave = `${dir}|${reg.sessionId}`;
        const vivo = processoConfere(reg);
        const atual = vivos.get(chave);
        if (!atual || (vivo && !atual.vivo) || (reg.updatedAt || 0) > (atual.reg.updatedAt || 0)) vivos.set(chave, { reg, vivo, dir });
      }
    }
    const chaves = new Set();
    for (const [k, v] of vivos) if (v.vivo) chaves.add(k);
    for (const [k, info] of this.indice) if (info.mtime >= inicioHoje) chaves.add(k);

    const sessoes = [];
    const estadosHoje = [];
    for (const chave of chaves) {
      const info = this.indice.get(chave);
      const viv = vivos.get(chave);
      const [dir, id] = [chave.slice(0, chave.lastIndexOf('|')), chave.slice(chave.lastIndexOf('|') + 1)];
      const lido = info ? this.lerSessao(info) : null;
      const p = lido?.principal;
      const totalSessao = lido ? somar(lido.todos) : somar([]);
      const totalHoje = lido ? somar(lido.todos, hoje) : somar([]);
      // O cost-state do Claude Code inclui chamadas que não vão para o transcript
      // (títulos, resumos, compactação). Quando ele cobre esta sessão inteira, vale ele.
      const fator = fatorOficial(p, totalSessao.custo);
      if (!viv?.vivo && totalHoje.custo === 0 && !(p?.ultimaAtividade && diaLocal(p.ultimaAtividade) === hoje)) continue;
      if (lido) estadosHoje.push(...lido.todos);
      const reg = viv?.reg || {};
      const cwd = reg.cwd || p?.cwd || null;
      const nome = lido?.tituloArquivo || p?.tituloManual || reg.name || null;
      const ultima = Math.max(p?.ultimaAtividade || 0, viv?.vivo ? reg.statusUpdatedAt || reg.updatedAt || 0 : 0) || null;
      sessoes.push({
        chave: `${nomeConta(dir)}:${id}`,
        sessionId: id,
        conta: nomeConta(dir),
        projeto: cwd ? path.basename(cwd) : '?',
        nome: redigir(nome, 60),
        tarefa: redigir(p?.tituloIA || p?.resumo, 140),
        resumo: redigir(p?.resumo, 280),
        status: statusDe(reg, !!viv?.vivo, agora),
        tipo: reg.kind || null,
        iniciadaEm: horario(reg.startedAt, agora) || horario(p?.primeiraAtividade, agora),
        ultimaAtividade: horario(ultima, agora),
        modelo: p?.modelo || null,
        esforco: p?.esforco || null,
        custo: arred(totalSessao.custo * fator),
        custoHoje: arred(totalHoje.custo * fator),
        custoConferido: fator !== 1 || !!p?.custoOficial,
        tokens: totalSessao.tokens,
        porModelo: arredModelos(totalSessao.porModelo),
        modelosSemPreco: p ? [...new Set(lido.todos.flatMap((e) => [...e.modelosDesconhecidos]))] : [],
      });
    }
    sessoes.sort((a, b) => b.custo - a.custo);
    const dia = somar(estadosHoje, hoje);
    return {
      geradoEm: agora,
      dia: hoje,
      totalDia: arred(sessoes.reduce((t, s) => t + s.custoHoje, 0)),
      porModeloDia: arredModelos(dia.porModelo),
      sessoes,
    };
  }

  // Dados completos de uma sessão para gravar o log ao encerrar.
  registroDe(dir, sessionId) {
    return lerRegistros(dir).find((r) => r.sessionId === sessionId) || null;
  }
}

export function fatorOficial(est, meu) {
  const of = est?.custoOficial;
  if (!of || !(meu > 0)) return 1;
  const cobreTudo = of.inicio == null || est.primeiraAtividade == null || of.inicio <= est.primeiraAtividade + 5 * 60_000;
  const r = of.total / meu;
  return cobreTudo && r > 1 && r < 1.5 ? r : 1;
}

// Horário plausível em ms (descarta lixo como nanossegundos ou datas no futuro).
const horario = (v, agora) => (Number.isFinite(v) && v > 1e12 && v < agora + 86_400_000 ? v : null);

const arred = (v) => Math.round(v * 10000) / 10000;
function arredModelos(pm) {
  const out = {};
  for (const [m, v] of Object.entries(pm)) out[m] = { custo: arred(v.custo), tokens: v.tokens };
  return out;
}
