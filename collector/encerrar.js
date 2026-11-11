// Executa um pedido de encerrar vindo do painel. Só encerra a sessão indicada e só se
// pid, sessionId e início do processo baterem com o registro do próprio Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { processoConfere, inicioDoProcesso } from './sessoes.js';
import { diaLocal } from './transcript.js';

export const EXPIRA_MS = 120_000;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

export function nomePadrao(sessao, agora = Date.now()) {
  const resumo = (sessao.tarefa || sessao.nome || 'sessão').slice(0, 60);
  return `${diaLocal(agora)} ${sessao.projeto} – ${resumo}`;
}

function ehClaude(pid) {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    if (comm.startsWith('claude')) return true;
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /(^|[\/\0])claude(\0|$)|claude-code|@anthropic-ai/.test(cmd);
  } catch {
    return false;
  }
}

export async function executarEncerrar(coletor, cmd, { kill = (pid, sig) => process.kill(pid, sig), esperaMaxMs = 10_000, agora = () => Date.now() } = {}) {
  if (!(cmd.idadeMs < EXPIRA_MS)) return { ok: false, erro: 'Pedido antigo demais; peça de novo.' };
  const sep = String(cmd.chave || '').indexOf(':');
  if (sep < 1) return { ok: false, erro: 'Pedido sem sessão válida.' };
  const conta = cmd.chave.slice(0, sep);
  const sessionId = cmd.chave.slice(sep + 1);
  const dir = coletor.dirs.find((d) => (path.basename(d).replace(/^\.claude-?/, '') || 'principal') === conta);
  if (!dir) return { ok: false, erro: 'Conta desconhecida neste computador.' };
  const reg = coletor.registroDe(dir, sessionId);
  if (!reg) return { ok: false, erro: 'A sessão não está registrada como aberta.' };
  if (!processoConfere(reg)) return { ok: false, erro: 'O processo da sessão já terminou.' };
  if (!ehClaude(reg.pid)) return { ok: false, erro: 'O processo não é do Claude Code; nada foi feito.' };

  kill(reg.pid, 'SIGTERM');
  const limite = agora() + esperaMaxMs;
  while (agora() < limite && inicioDoProcesso(reg.pid) === String(reg.procStart)) await espera(250);
  if (inicioDoProcesso(reg.pid) === String(reg.procStart)) return { ok: false, erro: 'O processo não respondeu ao pedido de encerrar.' };

  // Relê os transcripts depois do fim para o log sair com os números finais.
  const fim = agora();
  const sessao = coletor.retrato().sessoes.find((s) => s.chave === cmd.chave);
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
