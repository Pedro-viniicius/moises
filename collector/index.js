#!/usr/bin/env node
// Coletor local: lê as sessões do Claude Code, envia só metadados ao painel e executa os comandos
// assinados que o painel manda, depois de o porteiro conferir cada um (PLANO, tarefa 7).
// Uso: node collector/index.js           (laço contínuo, serviço systemd)
//      node collector/index.js --uma-vez  (um ciclo, imprime o retrato e não envia)
// Importar este módulo não inicia nada: main() só roda quando ele é o ponto de entrada.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Coletor, nomeConta } from './sessoes.js';
import { Ideias } from './ideias.js';
import { Auditoria } from './auditoria.js';
import { Chaveiro, Porteiro, TIPOS } from './comandos.js';
import { Orquestrador, MODELOS, ESFORCOS, MODOS, FERRAMENTAS_PADRAO } from './orquestrador.js';
import { redigir } from './redigir.js';

const REENVIO_MS = 5 * 60_000; // manda o retrato mesmo sem mudança, como sinal de vida
const PAINEL_ABERTO_MS = 60_000; // painel visto há menos que isso: ritmo rápido
const CICLO_MINIMO_MS = 200; // piso entre o início de dois ciclos, mesmo com o laço acordado
const MAX_RESPOSTA = 2_000_000; // 20 comandos de até 8.000 caracteres, com o escape do JSON
const RE_NOME_PROJETO = /^[A-Za-z0-9._-]{1,60}$/;
const RE_ID = /^c_[0-9a-f]{16}$/;
const RE_FERRAMENTA = /^[A-Za-z]{1,30}$/;
const ERRO_EXECUCAO = 'Erro interno do coletor.';
const ERRO_CONFERENCIA = 'Erro interno do coletor; o comando não foi executado.';

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Erro com mensagem escrita aqui (pode ir para o log como está).
class ErroDoPainel extends Error {}

// Só o que dá para mostrar no log sem risco de levar texto de sessão ou da resposta do painel.
function descreverErro(err) {
  if (err instanceof ErroDoPainel) return err.message;
  if (err?.name === 'TimeoutError') return 'tempo esgotado';
  return err?.cause?.code || err?.code || err?.name || 'erro';
}

// Id e verbo de um comando para o log: só no formato do contrato, senão '?' (vêm do servidor).
const idParaLog = (id) => (typeof id === 'string' && RE_ID.test(id) ? id : '?');
const tipoParaLog = (tipo) => (TIPOS.includes(tipo) ? tipo : '?');

// Token e retrato só trafegam cifrados (exceto no servidor local de teste).
export function urlAceita(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

// Lista local de projetos que o painel pode abrir: { nome: caminho absoluto }. Arquivo ausente ou
// inválido vale lista vazia; nome fora de /^[A-Za-z0-9._-]{1,60}$/ ou caminho relativo é ignorado.
export function lerProjetos(arquivo) {
  const lista = Object.create(null);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return lista;
  }
  if (!objetoSimples(json)) return lista;
  for (const [nome, caminho] of Object.entries(json)) {
    if (RE_NOME_PROJETO.test(nome) && typeof caminho === 'string' && path.isAbsolute(caminho)) lista[nome] = caminho;
  }
  return lista;
}

// Ritmo do laço: rápido se o dono olhou o painel há pouco, se há sessão comandada aberta ou se há
// confirmação para mandar; senão lento. painelVistoEm vem do relógio do servidor: só vale perto do nosso.
export function proximoIntervalo({ painelVistoEm, abertas, acksPendentes, agora, lento, rapido }) {
  const painelAberto = Number.isFinite(painelVistoEm) && Math.abs(agora - painelVistoEm) < PAINEL_ABERTO_MS;
  return painelAberto || abertas > 0 || acksPendentes > 0 ? rapido : lento;
}

// Confere cada comando com o porteiro e enfileira os acks em `acks`. Recusado: ack `recusado` e nada
// roda. Aceito: ack `recebido` na hora e execução sem esperar; ao terminar, ack `feito` ou `falhou`,
// `porteiro.concluir` e `aoTerminar()` (acorda o laço). Comando sem tipo ou sem assinatura é recusado
// pelo porteiro como qualquer outro; id que não é texto é ignorado sem ack.
// Devolve as promessas das execuções (nunca rejeitam).
export async function tratarComandos({ comandos, porteiro, orquestrador, acks, aoTerminar = () => {}, log } = {}) {
  const info = log ?? ((...a) => console.log(...a));
  const erro = log ?? ((...a) => console.error(...a));
  const execucoes = [];
  for (const cmd of Array.isArray(comandos) ? comandos : []) {
    const id = objetoSimples(cmd) ? cmd.id : undefined;
    if (typeof id !== 'string') continue;
    let r;
    try {
      r = porteiro.conferir(cmd);
    } catch (err) {
      erro(`[coletor] erro ao conferir o comando ${idParaLog(id)} (${descreverErro(err)})`);
      r = null;
    }
    if (!r?.ok) {
      const motivo = typeof r?.motivo === 'string' ? r.motivo : 'interno';
      acks.push({ id, estado: 'recusado', erro: typeof r?.erro === 'string' ? r.erro : ERRO_CONFERENCIA, motivo });
      info(`[coletor] ${tipoParaLog(cmd.tipo)} ${idParaLog(id)}: recusado (${motivo})`);
      continue;
    }
    // Só o que o orquestrador usa: dados (já conferidos, em r.dados) e assinatura ficam para trás.
    const alvo = Object.freeze({
      v: cmd.v,
      kid: cmd.kid,
      id,
      tipo: cmd.tipo,
      chave: cmd.chave,
      criadoEm: cmd.criadoEm,
      idadeMs: Number.isFinite(cmd.idadeMs) && cmd.idadeMs >= 0 ? cmd.idadeMs : 0,
    });
    acks.push({ id, estado: 'recebido' });
    execucoes.push(executar({ cmd: alvo, dados: r.dados, porteiro, orquestrador, acks, aoTerminar, info, erro }));
  }
  return execucoes;
}

async function executar({ cmd, dados, porteiro, orquestrador, acks, aoTerminar, info, erro }) {
  let ack;
  try {
    const r = await orquestrador.executar(cmd, dados);
    if (!objetoSimples(r)) throw new TypeError('resultado fora do formato');
    if (r.ok === true) {
      ack = { id: cmd.id, estado: 'feito', erro: null };
      if (objetoSimples(r.log)) ack.log = r.log;
      if (typeof r.chaveNova === 'string') ack.chaveNova = r.chaveNova;
    } else {
      ack = { id: cmd.id, estado: 'falhou', erro: typeof r.erro === 'string' && r.erro ? r.erro : ERRO_EXECUCAO };
    }
  } catch (err) {
    // A mensagem da exceção pode trazer texto de sessão: no log vai só o tipo do erro.
    erro(`[coletor] erro ao executar ${cmd.tipo} ${cmd.id} (${descreverErro(err)})`);
    ack = { id: cmd.id, estado: 'falhou', erro: ERRO_EXECUCAO };
  }
  acks.push(ack);
  porteiro.concluir(cmd, { ok: ack.estado === 'feito', erro: ack.erro });
  info(`[coletor] ${cmd.tipo} ${cmd.id}: ${ack.estado}`);
  try {
    aoTerminar();
  } catch {
    /* acordar o laço é só pressa */
  }
}

// Hash do que importa no retrato (sem horários que mudam a cada ciclo sem mudança real).
function assinatura(r) {
  const base = r.sessoes.map((s) => [
    s.chave, s.status, s.estado, s.custo, s.modelo, s.esforco, s.nome, s.tarefa, s.ultimaAtividade, s.ultimaRespostaEm,
    s.gerenciada, s.retomavel, s.erro, (s.permissoes || []).map((p) => p.pedido), s.sugestao?.geradaEm,
  ]);
  return crypto.createHash('sha1').update(JSON.stringify([r.totalDia, base, r.orquestracao])).digest('hex');
}

async function enviar({ url, token }, corpo, sinal) {
  const r = await fetch(new URL('/api/ingest', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), sinal]),
    redirect: 'error', // nunca reenviar o retrato para outra origem
  });
  if (!r.ok) throw new ErroDoPainel(`painel respondeu ${r.status}`);
  const txt = await r.text();
  if (txt.length > MAX_RESPOSTA) throw new ErroDoPainel('resposta do painel grande demais');
  try {
    return JSON.parse(txt);
  } catch {
    // A mensagem do JSON.parse cita trechos da resposta: não vai para o log.
    throw new ErroDoPainel('resposta do painel não é JSON');
  }
}

// Monta tudo e inicia o laço; resolve logo (não espera o laço acabar). parar() para o laço, encerra
// as sessões comandadas e só resolve com todos os filhos encerrados.
export async function rodar({
  url,
  token,
  pastaEstado,
  chavesArq,
  projetosArq,
  dirs,
  intervaloMs = 20_000,
  intervaloRapidoMs = 3_000,
  soPrefixo = null,
  argsExtra = [],
  maxSessoes = 4,
  maxAbrirPorDia = 20,
  tetoSessaoUsd = 5,
  ferramentas = FERRAMENTAS_PADRAO,
  permissaoExpiraMs = 30 * 60_000,
  claudeBin = 'claude',
  ideiasTetoDia,
  log,
} = {}) {
  if (!url || !token || !urlAceita(url)) throw new Error('configure MOISES_URL (https) e MOISES_TOKEN');
  for (const [nome, v] of Object.entries({ pastaEstado, chavesArq, projetosArq })) {
    if (typeof v !== 'string' || !v) throw new Error(`caminho ausente: ${nome}`);
  }
  const info = log ?? ((...a) => console.log(...a));
  const erro = log ?? ((...a) => console.error(...a));
  const prefixo = typeof soPrefixo === 'string' && soPrefixo ? soPrefixo : null;
  const doPrefixo = (s) => typeof s.nome === 'string' && s.nome.startsWith(prefixo);

  const coletor = new Coletor({ dirs, ignorarCwds: [pastaEstado] });
  const ideias = new Ideias({ pastaEstado, tetoDia: ideiasTetoDia });
  const chaveiro = new Chaveiro({ arquivo: chavesArq });
  const auditoria = new Auditoria({ arquivo: path.join(pastaEstado, 'auditoria.jsonl') });
  const porteiro = new Porteiro({ chaveiro, pastaEstado, auditoria });
  // Relida a cada uso: abrir sempre vê a lista atual.
  const projetos = () => lerProjetos(projetosArq);
  const orquestrador = new Orquestrador({
    coletor, projetos, pastaEstado, claudeBin, argsExtra, ferramentas, tetoSessaoUsd, maxSessoes, maxAbrirPorDia, permissaoExpiraMs, soPrefixo: prefixo,
  });

  function montarRetrato() {
    const retrato = coletor.retrato();
    if (prefixo) retrato.sessoes = retrato.sessoes.filter(doPrefixo);
    ideias.aplicar(retrato);
    orquestrador.aplicar(retrato);
    if (prefixo) retrato.sessoes = retrato.sessoes.filter(doPrefixo);
    const { ativa, motivo } = porteiro.ativo();
    retrato.orquestracao = {
      ativa,
      motivo,
      projetos: Object.keys(projetos()),
      contas: coletor.dirs.map(nomeConta),
      modelos: [...MODELOS],
      esforcos: [...ESFORCOS],
      modos: [...MODOS],
      maxSessoes,
      abertas: orquestrador.abertas(),
      aparelhos: chaveiro.aparelhos().map(({ kid, rotulo }) => ({ kid, rotulo: redigir(rotulo, 40) ?? '' })),
    };
    return retrato;
  }

  const acks = [];
  const execucoes = new Set();
  const cancelar = new AbortController();
  let parado = false;
  let ultimaAss = null;
  let ultimoEnvio = 0;
  let painelVistoEm = null;
  let falhasSeguidas = 0;
  let despertar = null;
  let acordarLogo = false;

  const acordar = () => {
    if (despertar) despertar();
    else acordarLogo = true;
  };
  const dormir = (ms) =>
    new Promise((resolve) => {
      if (parado || acordarLogo) {
        acordarLogo = false;
        return resolve();
      }
      const fim = () => {
        clearTimeout(timer);
        despertar = null;
        resolve();
      };
      const timer = setTimeout(fim, ms);
      despertar = fim;
    });

  async function ciclo(inicio) {
    const retrato = montarRetrato();
    const ass = assinatura(retrato);
    const enviando = acks.splice(0);
    // Resultado de comando vai sempre com o retrato do mesmo instante (estado novo da sessão).
    const mandarRetrato = enviando.length > 0 || ass !== ultimaAss || inicio - ultimoEnvio > REENVIO_MS;
    let resp;
    try {
      resp = await enviar({ url, token }, { retrato: mandarRetrato ? retrato : null, acks: enviando }, cancelar.signal);
    } catch (err) {
      acks.unshift(...enviando); // tenta de novo no próximo ciclo
      throw err;
    }
    if (mandarRetrato) {
      ultimaAss = ass;
      ultimoEnvio = inicio;
    }
    falhasSeguidas = 0;
    painelVistoEm = Number.isFinite(resp?.painelVistoEm) ? resp.painelVistoEm : null;
    if (parado) return;
    const novas = await tratarComandos({ comandos: resp?.comandos, porteiro, orquestrador, acks, aoTerminar: acordar, log });
    for (const p of novas) {
      execucoes.add(p);
      p.finally(() => execucoes.delete(p));
    }
    if (acks.length) acordar(); // as confirmações de recebimento saem já
  }

  const laco = (async () => {
    while (!parado) {
      const inicio = Date.now();
      try {
        await ciclo(inicio);
      } catch (err) {
        if (parado) break;
        falhasSeguidas++;
        if (falhasSeguidas <= 3 || falhasSeguidas % 30 === 0) erro(`[coletor] falha (${falhasSeguidas}x): ${descreverErro(err)}`);
      }
      if (parado) break;
      const ms = proximoIntervalo({
        painelVistoEm,
        abertas: orquestrador.abertas(),
        acksPendentes: acks.length,
        agora: Date.now(),
        lento: intervaloMs,
        rapido: intervaloRapidoMs,
      });
      await dormir(Math.max(0, ms - (Date.now() - inicio)));
      // Nem acordado o laço chama o painel mais que o piso: um servidor que devolvesse comandos em
      // toda resposta não o faz girar sem pausa.
      const resto = CICLO_MINIMO_MS - (Date.now() - inicio);
      if (resto > 0 && !parado) await new Promise((r) => setTimeout(r, resto));
    }
  })();

  const { ativa, motivo } = porteiro.ativo();
  info(
    `[coletor] lendo ${coletor.dirs.length} diretórios; enviando para ${new URL(url).host} a cada ${intervaloMs / 1000}s ` +
      `(${intervaloRapidoMs / 1000}s com o painel aberto); comandos ${ativa ? 'ativos' : `desligados (${motivo})`}`,
  );

  let parando = null;
  function parar() {
    parando ??= (async () => {
      parado = true;
      cancelar.abort();
      acordar();
      await laco;
      await orquestrador.fechar();
      await Promise.allSettled([...execucoes]);
      auditoria.descarregar();
    })();
    return parando;
  }
  return { parar };
}

// ---------- configuração de produção ----------

function lerConf(arquivo) {
  const out = {};
  try {
    for (const l of fs.readFileSync(arquivo, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* sem arquivo: usa variáveis de ambiente */
  }
  return out;
}

// Número do ambiente ou do coletor.env, dentro dos limites; fora deles vale o padrão, com um aviso
// que não repete o valor.
function numeroEntre(valor, nome, padrao, min, max, inteiro = true) {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  if (Number.isFinite(n) && n >= min && n <= max && (!inteiro || Number.isInteger(n))) return n;
  console.error(`[coletor] valor inválido em ${nome} (aceito: ${min} a ${max}); usando o padrão ${padrao}.`);
  return padrao;
}

function listaDeFerramentas(valor) {
  if (valor === undefined || valor === '') return FERRAMENTAS_PADRAO;
  const lista = valor.split(',').map((f) => f.trim()).filter(Boolean);
  if (lista.length && lista.every((f) => RE_FERRAMENTA.test(f))) return lista;
  console.error(`[coletor] valor inválido em MOISES_FERRAMENTAS; usando o padrão ${FERRAMENTAS_PADRAO.join(',')}.`);
  return FERRAMENTAS_PADRAO;
}

// coletor.env (ou o ambiente, que tem precedência). A chave de comandos nunca vem daqui: só o
// caminho do arquivo dela.
function configuracao() {
  const home = os.homedir();
  const arquivo = process.env.MOISES_CONF || path.join(home, '.config/moises/coletor.env');
  const doArquivo = lerConf(arquivo);
  const v = (k) => process.env[k] || doArquivo[k] || undefined;
  return {
    arquivo,
    url: v('MOISES_URL'),
    token: v('MOISES_TOKEN'),
    pastaEstado: process.env.MOISES_ESTADO || path.join(home, '.local/state/moises'),
    chavesArq: v('MOISES_CHAVES_ARQ') || path.join(home, '.config/moises/chaves-comandos.json'),
    projetosArq: v('MOISES_PROJETOS') || path.join(home, '.config/moises/projetos.json'),
    intervaloMs: numeroEntre(v('MOISES_INTERVALO_MS'), 'MOISES_INTERVALO_MS', 20_000, 1000, 3_600_000),
    intervaloRapidoMs: numeroEntre(v('MOISES_INTERVALO_RAPIDO_MS'), 'MOISES_INTERVALO_RAPIDO_MS', 3_000, 1000, 60_000),
    maxSessoes: numeroEntre(v('MOISES_MAX_SESSOES'), 'MOISES_MAX_SESSOES', 4, 1, 50),
    maxAbrirPorDia: numeroEntre(v('MOISES_MAX_ABRIR_DIA'), 'MOISES_MAX_ABRIR_DIA', 20, 0, 1000),
    tetoSessaoUsd: numeroEntre(v('MOISES_TETO_SESSAO_USD'), 'MOISES_TETO_SESSAO_USD', 5, 0.01, 100, false),
    ferramentas: listaDeFerramentas(v('MOISES_FERRAMENTAS')),
    permissaoExpiraMs: numeroEntre(v('MOISES_PERMISSAO_EXPIRA_MIN'), 'MOISES_PERMISSAO_EXPIRA_MIN', 30, 1, 1440) * 60_000,
    soPrefixo: v('MOISES_SO_PREFIXO') || null,
  };
}

async function main() {
  if (process.argv.includes('--uma-vez')) {
    const pastaEstado = process.env.MOISES_ESTADO || path.join(os.homedir(), '.local/state/moises');
    const coletor = new Coletor({ ignorarCwds: [pastaEstado] });
    const ideias = new Ideias({ pastaEstado });
    console.log(JSON.stringify(ideias.aplicar(coletor.retrato()), null, 2));
    return;
  }
  const conf = configuracao();
  if (!conf.url || !conf.token || !urlAceita(conf.url)) {
    console.error(`[coletor] configure MOISES_URL (https) e MOISES_TOKEN em ${conf.arquivo}`);
    process.exit(1);
  }
  const { arquivo, ...opcoes } = conf;
  let coletor;
  try {
    coletor = await rodar(opcoes);
  } catch (err) {
    console.error(`[coletor] não foi possível iniciar: ${err.message}`);
    process.exit(1);
  }
  // Reiniciar ou parar o serviço encerra as sessões comandadas (elas ficam retomáveis pelo painel).
  const sair = (sinal) => {
    console.log(`[coletor] ${sinal}: encerrando as sessões comandadas`);
    coletor
      .parar()
      .catch((err) => console.error(`[coletor] falha ao encerrar: ${descreverErro(err)}`))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => sair('SIGTERM'));
  process.once('SIGINT', () => sair('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
