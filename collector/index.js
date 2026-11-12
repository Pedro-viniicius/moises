#!/usr/bin/env node
// Coletor local: lê as sessões do Claude Code, envia só metadados ao painel e executa os comandos
// assinados que o painel manda, depois de o porteiro conferir cada um (PLANO, tarefa 7).
// Uso: node collector/index.js           (laço contínuo, serviço systemd)
//      node collector/index.js --uma-vez  (um ciclo, imprime o retrato e não envia)
// Importar este módulo não inicia nada: main() só roda quando ele é o ponto de entrada.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Coletor, nomeConta } from './sessoes.js';
import { Ideias } from './ideias.js';
import { Auditoria, escreverAtomico } from './auditoria.js';
import { Chaveiro, Porteiro } from './comandos.js';
import { Orquestrador, FERRAMENTAS_PADRAO } from './orquestrador.js';
import { ESFORCOS, MODELOS, MODOS, TIPOS, objetoSimples } from './contrato.js';
import { caminhosDoColetor, configuracao } from './config.js';
import { redigir } from './redigir.js';
import { pedidoDeAparelho } from './assinatura.js';

// A configuração de produção fica em collector/config.js; reexportada para quem já a importava daqui.
export { caminhosDoColetor, configuracao };

const PROTOCOLO = 2; // anunciado em todo envio: o servidor só entrega comandos a quem confere assinatura
const REENVIO_MS = 5 * 60_000; // manda o retrato mesmo sem mudança, como sinal de vida
const PAINEL_ABERTO_MS = 60_000; // painel visto há menos que isso: ritmo rápido
const CICLO_MINIMO_MS = 200; // piso entre o início de dois ciclos, mesmo com o laço acordado
const MAX_RESPOSTA = 2_000_000; // 20 comandos de até 8.000 caracteres, com o escape do JSON
const MAX_COMANDOS_POR_RESPOSTA = 20; // o resto, se vier, o servidor entrega de novo
const ENVIO_FINAL_MS = 5_000; // parar(): tempo para mandar as últimas confirmações
// Pedidos de pareamento de aparelho que o servidor entrega (tarefa 15): o dono os confere e autoriza com
// `configurar-comandos.js --pedidos` e `--autorizar`. O servidor guarda no máximo 5.
const ARQ_PEDIDOS_APARELHOS = 'aparelhos-pedidos.json';
const MAX_PEDIDOS_APARELHOS = 5;
const ESTADOS_OCUPADOS = ['trabalhando', 'esperando_permissao'];
// Integridade do painel publicado (S15, S27): todos os arquivos de public/ (com as subpastas) e o caminho `/`.
// O resultado de cada conferência vai para <estado>/painel-conferencia.json, que o --autorizar consulta.
const ARQ_CONFERENCIA = 'painel-conferencia.json';
const CONFERIR_PAINEL_MS = 10 * 60_000;
const CONFERIR_PAINEL_TEMPO_MS = 15_000;
const MAX_ARQUIVO_PAINEL = 5_000_000;
const PASTA_PUBLICA = fileURLToPath(new URL('../public/', import.meta.url));
const PAINEL_ALTERADO = Object.freeze({
  motivo: 'painel_alterado',
  erro: 'O painel publicado é diferente do código deste computador; comandos desligados.',
});
const RE_NOME_PROJETO = /^[A-Za-z0-9._-]{1,60}$/;
const RE_ID = /^c_[0-9a-f]{16}$/;
const ERRO_EXECUCAO = 'Erro interno do coletor.';
const ERRO_CONFERENCIA = 'Erro interno do coletor; o comando não foi executado.';

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

// Última lista lida de cada arquivo de projetos, com a marca do arquivo (dispositivo, inode, tamanho, mtime e
// ctime, como a do chaveiro): o laço consulta a lista mais de uma vez por ciclo e só relê quando ela muda.
const projetosLidos = new Map(); // caminho → { marca, lista }

// Lista local de projetos que o painel pode abrir: { nome: caminho absoluto }. Arquivo ausente ou
// inválido vale lista vazia; nome fora de /^[A-Za-z0-9._-]{1,60}$/ ou caminho relativo é ignorado.
// Relida só quando o arquivo muda; cada chamada recebe uma cópia.
export function lerProjetos(arquivo) {
  let marca;
  try {
    const st = fs.statSync(arquivo, { bigint: true });
    marca = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    projetosLidos.delete(arquivo);
    return Object.create(null);
  }
  let lido = projetosLidos.get(arquivo);
  if (lido?.marca !== marca) {
    // A marca é a de antes da leitura: se o arquivo mudar no meio, o próximo ciclo relê.
    lido = { marca, lista: lerArquivoDeProjetos(arquivo) };
    projetosLidos.set(arquivo, lido);
  }
  return Object.assign(Object.create(null), lido.lista);
}

function lerArquivoDeProjetos(arquivo) {
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

// Ritmo do laço: rápido se o dono olhou o painel há pouco, se há sessão comandada trabalhando ou
// esperando permissão, ou se há confirmação para mandar; senão lento. painelVistoEm vem do relógio do
// servidor: só vale perto do nosso.
export function proximoIntervalo({ painelVistoEm, ocupadas, acksPendentes, agora, lento, rapido }) {
  const painelAberto = Number.isFinite(painelVistoEm) && Math.abs(agora - painelVistoEm) < PAINEL_ABERTO_MS;
  return painelAberto || ocupadas > 0 || acksPendentes > 0 ? rapido : lento;
}

// Sessões comandadas do retrato que estão trabalhando ou esperando permissão.
export function contarOcupadas(retrato) {
  const sessoes = Array.isArray(retrato?.sessoes) ? retrato.sessoes : [];
  return sessoes.filter((s) => s?.gerenciada === true && ESTADOS_OCUPADOS.includes(s.estado)).length;
}

// Texto de conversa só sobe de sessão comandada pelo painel (S16): a aberta à mão vai sem a última
// resposta e sem a tarefa tirada do primeiro pedido (cai para o nome).
function semTextoDeConversa(s) {
  s.ultimaResposta = null;
  s.ultimaRespostaEm = null;
  if (s.tarefaOrigem === 'pedido') {
    s.tarefa = typeof s.nome === 'string' && s.nome ? s.nome : null;
    s.tarefaOrigem = s.tarefa ? 'nome' : null;
  }
}

// Baixa um arquivo do painel (sem token, sem seguir redirecionamento, com teto de tamanho).
async function baixarDoPainel(endereco, sinal) {
  const r = await fetch(endereco, { signal: sinal, redirect: 'error' });
  if (!r.ok) throw new ErroDoPainel(`painel respondeu ${r.status}`);
  const partes = [];
  let total = 0;
  if (r.body) {
    for await (const parte of r.body) {
      total += parte.length;
      if (total > MAX_ARQUIVO_PAINEL) throw new ErroDoPainel('arquivo grande demais');
      partes.push(parte);
    }
  }
  return Buffer.concat(partes);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Arquivos de `pasta` e das subpastas, como caminhos relativos com '/', em ordem. Lança se a pasta não
// puder ser lida.
function arquivosDoPainel(pasta) {
  const nomes = [];
  for (const nome of fs.readdirSync(pasta, { recursive: true })) {
    let ehArquivo = false;
    try {
      ehArquivo = fs.statSync(path.join(pasta, nome)).isFile();
    } catch {
      ehArquivo = true; // some entre a lista e a leitura: a leitura do conteúdo falha e desliga
    }
    if (ehArquivo) nomes.push(nome.split(path.sep).join('/'));
  }
  return nomes.sort();
}

// Confere se o que o painel publicado serve é o que está em `pastaPublica` (S15, S27): cada arquivo da pasta
// e das subpastas, em ordem, e depois `/` contra index.html. Devolve {ok: true} ou {ok: false, arquivo,
// causa}, com causa 'local' (pasta ou arquivo local ilegível), 'download' (não baixou) ou 'diferente'.
// `arquivo` é o caminho relativo ('/' para a raiz). Nunca lança.
export async function conferirPainelPublicado({ url, pastaPublica = PASTA_PUBLICA, sinal }) {
  let lista;
  try {
    lista = arquivosDoPainel(pastaPublica);
  } catch {
    return { ok: false, arquivo: '.', causa: 'local' };
  }
  const alvos = lista.map((nome) => ({ arquivo: nome, local: nome, caminho: `/${nome.split('/').map(encodeURIComponent).join('/')}` }));
  alvos.push({ arquivo: '/', local: 'index.html', caminho: '/' });
  for (const { arquivo, local: nomeLocal, caminho } of alvos) {
    let local;
    try {
      local = sha256(fs.readFileSync(path.join(pastaPublica, nomeLocal)));
    } catch {
      return { ok: false, arquivo, causa: 'local' };
    }
    let servido;
    try {
      servido = sha256(await baixarDoPainel(new URL(caminho, url), sinal));
    } catch {
      return { ok: false, arquivo, causa: 'download' };
    }
    if (servido !== local) return { ok: false, arquivo, causa: 'diferente' };
  }
  return { ok: true };
}

// Confere cada comando com o porteiro e enfileira os acks em `acks`. Recusado: ack `recusado` e nada
// roda. Aceito: ack `recebido` na hora e execução sem esperar; ao terminar, ack `feito` ou `falhou`,
// `porteiro.concluir` e `aoTerminar()` (acorda o laço). Comando sem tipo ou sem assinatura é recusado
// pelo porteiro como qualquer outro; id que não é texto é ignorado sem ack. Trata no máximo 20 itens
// por resposta. Com `bloqueio` ({motivo, erro}), todos são recusados antes do porteiro.
// Devolve as promessas das execuções (nunca rejeitam).
export async function tratarComandos({ comandos, porteiro, orquestrador, acks, aoTerminar = () => {}, bloqueio = null, log } = {}) {
  const info = log ?? ((...a) => console.log(...a));
  const erro = log ?? ((...a) => console.error(...a));
  const execucoes = [];
  for (const cmd of Array.isArray(comandos) ? comandos.slice(0, MAX_COMANDOS_POR_RESPOSTA) : []) {
    const id = objetoSimples(cmd) ? cmd.id : undefined;
    if (typeof id !== 'string') continue;
    if (bloqueio) {
      acks.push({ id, estado: 'recusado', erro: bloqueio.erro, motivo: bloqueio.motivo });
      info(`[coletor] ${tipoParaLog(cmd.tipo)} ${idParaLog(id)}: recusado (${bloqueio.motivo})`);
      continue;
    }
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
  porteiro.concluir(cmd, { ok: ack.estado === 'feito', erro: ack.erro, chaveNova: ack.chaveNova ?? null });
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

// Texto de aparelhos-pedidos.json: só os pedidos de pareamento que passam em pedidoDeAparelho (kid da
// própria chave pública, ponto na curva, rótulo visível), no máximo 5. O servidor não é confiável; o
// script confere tudo de novo antes de autorizar.
function textoDosPedidos(lista) {
  const validos = [];
  for (const p of Array.isArray(lista) ? lista : []) {
    const ok = pedidoDeAparelho(p);
    if (ok) validos.push(ok);
    if (validos.length >= MAX_PEDIDOS_APARELHOS) break;
  }
  return { validos: validos.length, texto: `${JSON.stringify(validos)}\n` };
}

// Grava o texto em <pastaEstado>/<nome> (600, por temporário e rename). Lança só com o código do erro de
// disco (nada do conteúdo); `oQue` diz o que era, para o log.
function gravarNoEstado(pastaEstado, nome, texto, oQue) {
  try {
    escreverAtomico(path.join(pastaEstado, nome), texto);
  } catch (err) {
    throw new ErroDoPainel(`não foi possível gravar ${oQue} (${err?.code || 'erro'})`);
  }
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
  conferirPainel = true,
  pastaPublica = PASTA_PUBLICA,
  conferirPainelMs = CONFERIR_PAINEL_MS,
  envioFinalMs = ENVIO_FINAL_MS,
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
  // Conferida a cada uso e relida quando o arquivo muda: abrir sempre vê a lista atual.
  const projetos = () => lerProjetos(projetosArq);
  // Pastas que as sessões comandadas não podem ler nem editar (SE-M5b): as chaves dos aparelhos, a lista de
  // projetos e o estado do coletor, onde quer que a configuração as ponha.
  const protegidos = [...new Set([path.dirname(path.resolve(chavesArq)), path.dirname(path.resolve(projetosArq)), path.resolve(pastaEstado)])];
  const orquestrador = new Orquestrador({
    coletor, projetos, pastaEstado, claudeBin, argsExtra, ferramentas, tetoSessaoUsd, maxSessoes, maxAbrirPorDia, permissaoExpiraMs, soPrefixo: prefixo, protegidos,
  });

  // Painel publicado diferente de public/ (ou que não baixou): comandos desligados até a próxima
  // conferência bater. Se o porteiro sabe desligar, ele recusa (e audita); senão, o laço recusa antes.
  let painelAlterado = false;
  let porteiroDesligado = false; // o porteiro aceitou desligar(): ele mesmo recusa
  let proximaConferencia = 0;
  const porteiroDesliga = () => typeof porteiro.desligar === 'function' && typeof porteiro.religar === 'function';
  const situacao = () => {
    const s = porteiro.ativo();
    return s.ativa && painelAlterado ? { ativa: false, motivo: PAINEL_ALTERADO.motivo } : s;
  };

  function montarRetrato() {
    const retrato = coletor.retrato();
    if (prefixo) retrato.sessoes = retrato.sessoes.filter(doPrefixo);
    ideias.aplicar(retrato);
    orquestrador.aplicar(retrato);
    if (prefixo) retrato.sessoes = retrato.sessoes.filter(doPrefixo);
    for (const s of retrato.sessoes) if (s.gerenciada !== true) semTextoDeConversa(s);
    const { ativa, motivo } = situacao();
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
  let ocupadas = 0;
  let falhasSeguidas = 0;
  let despertar = null;
  let acordarLogo = false;
  let pedidosGravados = null; // texto do último aparelhos-pedidos.json gravado (só regrava se mudar)
  let falhaPedidos = null; // última falha ao gravá-lo, para não repetir a mesma linha no log
  let falhaConferencia = null; // idem, para painel-conferencia.json

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

  // No início e a cada `conferirPainelMs`, antes do ciclo: nenhum comando é tratado antes da primeira
  // conferência. Nunca lança.
  async function conferirSeHora() {
    if (!conferirPainel || Date.now() < proximaConferencia) return;
    proximaConferencia = Date.now() + conferirPainelMs;
    const sinal = AbortSignal.any([AbortSignal.timeout(CONFERIR_PAINEL_TEMPO_MS), cancelar.signal]);
    const r = await conferirPainelPublicado({ url, pastaPublica, sinal });
    if (parado) return;
    registrarConferencia(r);
    const alterado = !r.ok;
    if (alterado && !painelAlterado) {
      const porque = { diferente: 'é diferente de public/', download: 'não pôde ser baixado', local: 'não existe em public/ deste computador' }[r.causa];
      erro(`[coletor] painel publicado: ${r.arquivo} ${porque}; comandos desligados (${PAINEL_ALTERADO.motivo})`);
    } else if (!alterado && painelAlterado) {
      info('[coletor] painel publicado confere com public/; comandos religados');
    }
    painelAlterado = alterado;
    porteiroDesligado = false;
    try {
      if (porteiroDesliga()) {
        if (alterado) {
          porteiro.desligar(PAINEL_ALTERADO.motivo);
          porteiroDesligado = true;
        } else {
          porteiro.religar();
        }
      }
    } catch (err) {
      // Sem o porteiro avisado, o laço recusa sozinho (porteiroDesligado continua false).
      erro(`[coletor] erro ao avisar o porteiro da conferência do painel (${descreverErro(err)})`);
    }
  }

  // Resultado da conferência para o --autorizar (A1-resto): {ok, em} e, se divergiu, arquivo e causa;
  // nada do conteúdo servido. Falha de disco vai para o log uma vez; o laço segue.
  function registrarConferencia(r) {
    const registro = r.ok ? { ok: true, em: Date.now() } : { ok: false, em: Date.now(), arquivo: r.arquivo, causa: r.causa };
    try {
      gravarNoEstado(pastaEstado, ARQ_CONFERENCIA, `${JSON.stringify(registro)}\n`, 'o resultado da conferência do painel');
      falhaConferencia = null;
    } catch (err) {
      const msg = descreverErro(err);
      if (msg !== falhaConferencia) erro(`[coletor] ${msg}`);
      falhaConferencia = msg;
    }
  }

  // Resposta sem a lista (servidor antigo) não mexe no arquivo; lista igual à última gravada não regrava.
  // Falha de disco vai para o log uma vez (tenta de novo a cada ciclo). Nada do conteúdo vai para o log.
  function repassarPedidos(lista) {
    if (!Array.isArray(lista)) return;
    const { validos, texto } = textoDosPedidos(lista);
    if (texto === pedidosGravados) return;
    try {
      gravarNoEstado(pastaEstado, ARQ_PEDIDOS_APARELHOS, texto, 'os pedidos de pareamento');
      pedidosGravados = texto;
      falhaPedidos = null;
      if (validos) info(`[coletor] ${validos} pedido(s) de autorização de aparelho; confira com configurar-comandos.js --pedidos`);
    } catch (err) {
      const msg = descreverErro(err);
      if (msg !== falhaPedidos) erro(`[coletor] ${msg}`);
      falhaPedidos = msg;
    }
  }

  async function ciclo(inicio) {
    const retrato = montarRetrato();
    ocupadas = contarOcupadas(retrato);
    const ass = assinatura(retrato);
    const enviando = acks.splice(0);
    // Resultado de comando vai sempre com o retrato do mesmo instante (estado novo da sessão).
    const mandarRetrato = enviando.length > 0 || ass !== ultimaAss || inicio - ultimoEnvio > REENVIO_MS;
    let resp;
    try {
      resp = await enviar({ url, token }, { protocolo: PROTOCOLO, retrato: mandarRetrato ? retrato : null, acks: enviando }, cancelar.signal);
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
    repassarPedidos(resp?.aparelhosPedidos);
    const bloqueio = painelAlterado && !porteiroDesligado ? PAINEL_ALTERADO : null;
    const novas = await tratarComandos({ comandos: resp?.comandos, porteiro, orquestrador, acks, aoTerminar: acordar, bloqueio, log });
    for (const p of novas) {
      execucoes.add(p);
      p.finally(() => execucoes.delete(p));
    }
    if (acks.length) acordar(); // as confirmações de recebimento saem já
  }

  const laco = (async () => {
    while (!parado) {
      const inicio = Date.now();
      await conferirSeHora();
      if (parado) break;
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
        ocupadas,
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
  const texto = process.env.MOISES_SUBIR_TEXTO === '0' ? 'não sobe' : 'sobe';
  info(
    `[coletor] lendo ${coletor.dirs.length} diretórios; enviando para ${new URL(url).host} a cada ${intervaloMs / 1000}s ` +
      `(${intervaloRapidoMs / 1000}s com o painel aberto); comandos: ${ativa ? 'ligados' : `desligados (${motivo})`}; texto: ${texto}; ` +
      `conferência do painel: ${conferirPainel ? `a cada ${Math.round(conferirPainelMs / 60_000)} min` : 'desligada'}`,
  );
  // O mesmo arquivo que o configurar-comandos.js usa (SE-M4); só o caminho e a contagem, nunca as chaves.
  info(`[coletor] chaves dos aparelhos em ${path.resolve(chavesArq)}: ${chaveiro.aparelhos().length} carregada(s)`);

  // Confirmações que ficaram na fila (resultado de execução encerrada agora): uma tentativa, com tempo
  // limite, só com os acks. Os comandos que vierem na resposta ficam para o próximo coletor.
  async function enviarUltimosAcks() {
    if (!acks.length) return;
    const enviando = acks.splice(0);
    try {
      await enviar({ url, token }, { protocolo: PROTOCOLO, retrato: null, acks: enviando }, AbortSignal.timeout(envioFinalMs));
      info(`[coletor] ${enviando.length} confirmações enviadas ao parar`);
    } catch (err) {
      erro(`[coletor] ${enviando.length} confirmações não foram enviadas ao parar (${descreverErro(err)})`);
    }
  }

  let parando = null;
  function parar() {
    parando ??= (async () => {
      parado = true;
      cancelar.abort();
      acordar();
      await laco;
      await orquestrador.fechar();
      await Promise.allSettled([...execucoes]);
      await enviarUltimosAcks();
      auditoria.descarregar();
    })();
    return parando;
  }
  return { parar };
}

async function main() {
  if (process.argv.includes('--uma-vez')) {
    const { pastaEstado } = caminhosDoColetor();
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
