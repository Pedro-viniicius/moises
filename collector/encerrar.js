// Executa um pedido de encerrar vindo do painel. Só encerra a sessão indicada e só se
// pid, sessionId, início do processo e executável baterem com o registro do próprio Claude Code.
// Os limites daqui são locais: nem o site nem o Redis conseguem afrouxá-los.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processoConfere, inicioDoProcesso, nomeConta } from './sessoes.js';
import { diaLocal } from './transcript.js';

export const EXPIRA_MS = 120_000;
const limiteConfig = Number(process.env.MOISES_ENCERRAR_POR_HORA);
export const MAX_POR_HORA = Number.isFinite(limiteConfig) && limiteConfig >= 0 ? limiteConfig : 5;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

export function nomePadrao(sessao, agora = Date.now()) {
  const resumo = (sessao.tarefa || sessao.nome || 'sessão').slice(0, 60);
  return `${diaLocal(agora)} ${sessao.projeto} – ${resumo}`;
}

// Só o executável do Claude Code: nome do processo "claude", ou node rodando o pacote dele.
export function ehClaude(pid) {
  try {
    if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'claude') return true;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.slice(0, 2).some((a) => /(^|\/)claude$/.test(a) || a.includes('/@anthropic-ai/claude-code/'));
  } catch {
    return false;
  }
}

// Memória local do que já foi executado e do ritmo de encerramentos, gravada em disco
// para um reinício do coletor não zerar os limites.
const ARQ_LIMITES = process.env.MOISES_LIMITES_ARQ || path.join(os.homedir(), '.local/state/moises/encerrar.json');
let executados = new Set();
let recentes = [];
try {
  const d = JSON.parse(fs.readFileSync(ARQ_LIMITES, 'utf8'));
  executados = new Set(d.executados || []);
  recentes = d.recentes || [];
} catch {
  /* primeira vez */
}
function gravarLimites() {
  try {
    fs.mkdirSync(path.dirname(ARQ_LIMITES), { recursive: true });
    const tmp = `${ARQ_LIMITES}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ executados: [...executados].slice(-200), recentes }));
    fs.renameSync(tmp, ARQ_LIMITES);
  } catch (err) {
    console.error('[encerrar] não gravou os limites:', err.message);
  }
}

export async function executarEncerrar(coletor, cmd, { kill = (pid, sig) => process.kill(pid, sig), esperaMaxMs = 10_000, agora = () => Date.now() } = {}) {
  if (process.env.MOISES_ENCERRAR === '0') return { ok: false, erro: 'Encerrar pelo painel está desligado neste computador.' };
  if (executados.has(cmd.id)) return { ok: false, erro: 'Pedido repetido; já foi tratado.' };
  executados.add(cmd.id);
  gravarLimites();
  if (!(cmd.idadeMs >= 0 && cmd.idadeMs < EXPIRA_MS)) return { ok: false, erro: 'Pedido antigo demais; peça de novo.' };
  while (recentes.length && agora() - recentes[0] > 3600_000) recentes.shift();
  if (recentes.length >= MAX_POR_HORA) return { ok: false, erro: `Limite de ${MAX_POR_HORA} encerramentos por hora atingido.` };

  const sep = String(cmd.chave || '').indexOf(':');
  if (sep < 1) return { ok: false, erro: 'Pedido sem sessão válida.' };
  const conta = cmd.chave.slice(0, sep);
  const sessionId = cmd.chave.slice(sep + 1);
  const dir = coletor.dirs.find((d) => nomeConta(d) === conta);
  if (!dir) return { ok: false, erro: 'Conta desconhecida neste computador.' };
  const reg = coletor.registroDe(dir, sessionId);
  if (!reg) return { ok: false, erro: 'A sessão não está registrada como aberta.' };
  if (reg.procStart == null) return { ok: false, erro: 'Registro sem início do processo; nada foi feito.' };
  if (!processoConfere(reg, { estrito: true })) return { ok: false, erro: 'O processo da sessão já terminou.' };
  if (!ehClaude(reg.pid)) return { ok: false, erro: 'O processo não é do Claude Code; nada foi feito.' };

  // Retrato da sessão antes do fim: garante o log mesmo se ela não tiver atividade hoje.
  const antes = coletor.sessaoDe(cmd.chave);
  recentes.push(agora());
  gravarLimites();
  kill(reg.pid, 'SIGTERM');
  const limite = agora() + esperaMaxMs;
  while (agora() < limite && inicioDoProcesso(reg.pid) === String(reg.procStart)) await espera(250);
  if (inicioDoProcesso(reg.pid) === String(reg.procStart)) return { ok: false, erro: 'O processo não respondeu ao pedido de encerrar.' };

  // Relê os transcripts depois do fim para o log sair com os números finais.
  const fim = agora();
  const sessao = coletor.sessaoDe(cmd.chave) || antes;
  if (!sessao) return { ok: true, log: { nome: cmd.nome || cmd.chave, encerradaEm: fim } };
  const inicio = sessao.iniciadaEm || null;
  return {
    ok: true,
    log: {
      nome: cmd.nome || nomePadrao(sessao, fim),
      projeto: sessao.projeto,
      conta: sessao.conta,
      tarefa: sessao.tarefa,
      resumo: sessao.resumo,
      iniciadaEm: inicio,
      encerradaEm: fim,
      duracaoMs: inicio ? fim - inicio : null,
      modelo: sessao.modelo,
      esforco: sessao.esforco,
      porModelo: sessao.porModelo,
      tokens: sessao.tokens,
      custo: sessao.custo,
    },
  };
}
