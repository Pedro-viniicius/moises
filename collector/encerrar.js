// Executa um pedido de encerrar vindo do painel. Só encerra a sessão indicada e só se
// pid, sessionId, início do processo e executável baterem com o registro do próprio Claude Code.
// Os limites daqui são locais: nem o site nem o Redis conseguem afrouxá-los.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processoConfere, inicioDoProcesso, nomeConta } from './sessoes.js';
import { diaLocal } from './transcript.js';

export const EXPIRA_MS = 120_000;
// Lido a cada uso: a variável pode chegar do coletor.env depois da importação.
export function maxPorHora() {
  const bruto = process.env.MOISES_ENCERRAR_POR_HORA;
  const n = bruto == null || bruto === '' ? NaN : Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}
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
// para um reinício do coletor não zerar os limites. O caminho é lido no primeiro uso
// (não na importação), para o teste poder apontar para uma pasta temporária.
let arqLimites = null;
let executados = null;
let recentes = null;
// Dia (AAAA-MM-DD) até o qual o arquivo de limites estragado segura os encerramentos; null se não segura.
let bloqueadoAte = null;
const ERRO_GRAVAR = 'Não foi possível registrar o pedido de encerrar neste computador; nada foi feito.';
const listaDe = (v, confere) => v === undefined || (Array.isArray(v) && v.every(confere));

// Arquivo ausente conta zero. Corrompido ou ilegível conta como teto atingido até o dia virar, com erro
// no log: o dia é o da última gravação do arquivo (mtime), e um arquivo estragado num dia anterior não
// segura hoje. Enquanto segura, o arquivo não é regravado (SE-B2, falha fechada).
function carregarLimites(agora) {
  if (executados) return;
  arqLimites = process.env.MOISES_LIMITES_ARQ || path.join(os.homedir(), '.local/state/moises/encerrar.json');
  executados = new Set();
  recentes = [];
  bloqueadoAte = null;
  let motivo;
  try {
    const d = JSON.parse(fs.readFileSync(arqLimites, 'utf8'));
    if (d !== null && typeof d === 'object' && !Array.isArray(d) && listaDe(d.executados, (x) => typeof x === 'string') && listaDe(d.recentes, Number.isFinite)) {
      executados = new Set(d.executados ?? []);
      recentes = d.recentes ?? [];
      return;
    }
    motivo = 'corrompido';
  } catch (err) {
    if (err?.code === 'ENOENT') return; // primeira vez
    // A mensagem do JSON.parse cita o conteúdo: no log vai só o código.
    motivo = err?.code ? `ilegível (${err.code})` : 'corrompido';
  }
  try {
    bloqueadoAte = diaLocal(fs.statSync(arqLimites).mtimeMs);
  } catch {
    bloqueadoAte = diaLocal(agora());
  }
  console.error(`[encerrar] o arquivo de limites está ${motivo}; encerrar pelo painel fica recusado até o dia virar.`);
}
// Esquece o que está em memória; a próxima chamada relê o arquivo. Uso em teste.
export function reiniciarLimites() {
  arqLimites = null;
  executados = null;
  recentes = null;
  bloqueadoAte = null;
}
// Devolve false se não conseguiu gravar: quem chama recusa a ação (falha fechada).
function gravarLimites() {
  const tmp = `${arqLimites}.tmp`;
  try {
    fs.mkdirSync(path.dirname(arqLimites), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ executados: [...executados].slice(-200), recentes }), { mode: 0o600 });
    fs.renameSync(tmp, arqLimites);
    return true;
  } catch (err) {
    console.error(`[encerrar] não gravou os limites (${err?.code || 'erro'}); o pedido foi recusado.`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nada a limpar */
    }
    return false;
  }
}

export async function executarEncerrar(coletor, cmd, { kill = (pid, sig) => process.kill(pid, sig), esperaMaxMs = 10_000, agora = () => Date.now() } = {}) {
  if (process.env.MOISES_ENCERRAR === '0') return { ok: false, erro: 'Encerrar pelo painel está desligado neste computador.' };
  carregarLimites(agora);
  const porHora = maxPorHora();
  if (bloqueadoAte !== null) {
    if (diaLocal(agora()) <= bloqueadoAte) return { ok: false, erro: `Limite de ${porHora} encerramentos por hora atingido.` };
    bloqueadoAte = null; // o dia virou: começa do zero e a próxima gravação substitui o arquivo estragado
  }
  if (executados.has(cmd.id)) return { ok: false, erro: 'Pedido repetido; já foi tratado.' };
  executados.add(cmd.id);
  if (!gravarLimites()) return { ok: false, erro: ERRO_GRAVAR };
  if (!(cmd.idadeMs >= 0 && cmd.idadeMs < EXPIRA_MS)) return { ok: false, erro: 'Pedido antigo demais; peça de novo.' };
  while (recentes.length && agora() - recentes[0] > 3600_000) recentes.shift();
  if (recentes.length >= porHora) return { ok: false, erro: `Limite de ${porHora} encerramentos por hora atingido.` };

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
  if (!gravarLimites()) return { ok: false, erro: ERRO_GRAVAR };
  kill(reg.pid, 'SIGTERM');
  const limite = agora() + esperaMaxMs;
  while (agora() < limite && inicioDoProcesso(reg.pid) === String(reg.procStart)) await espera(250);
  if (inicioDoProcesso(reg.pid) === String(reg.procStart)) return { ok: false, erro: 'O processo não respondeu ao pedido de encerrar.' };

  // Relê os transcripts depois do fim para o log sair com os números finais.
  const fim = agora();
  const sessao = coletor.sessaoDe(cmd.chave) || antes;
  if (!sessao) return { ok: true, log: { nome: cmd.nome || cmd.chave, encerradaEm: fim } };
  return { ok: true, log: logDeEncerramento(sessao, cmd.nome, fim) };
}

// O registro que vai para o Histórico. O texto de um pedido não vai para lá:
// quando a tarefa veio do primeiro pedido, ela fica de fora (inclusive do nome padrão).
export function logDeEncerramento(sessao, nome, fim) {
  const tarefa = sessao.tarefaOrigem === 'pedido' ? null : sessao.tarefa;
  const inicio = sessao.iniciadaEm || null;
  return {
    nome: nome || nomePadrao({ ...sessao, tarefa }, fim),
    projeto: sessao.projeto,
    conta: sessao.conta,
    tarefa,
    resumo: sessao.resumo,
    iniciadaEm: inicio,
    encerradaEm: fim,
    duracaoMs: inicio ? fim - inicio : null,
    modelo: sessao.modelo,
    esforco: sessao.esforco,
    porModelo: sessao.porModelo,
    tokens: sessao.tokens,
    custo: sessao.custo,
  };
}
