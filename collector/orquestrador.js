// Sessões comandadas pelo painel (ADR-001, caminho B). O coletor abre o Claude Code como
// `claude -p` em stream-json, isolado das configurações do usuário, e conversa com ele por stdin/stdout.
// Executa os seis verbos: abrir, mensagem, permissao, interromper, encerrar e retomar.
//
// Regras que valem para tudo aqui (PLANO, "Restrições globais" e tarefa 6):
// - nenhum texto do painel vira argumento, variável de ambiente ou caminho: só listas fechadas e
//   expressões regulares; o texto livre (pedido e mensagens) vai pelo stdin, embrulhado pelo coletor;
// - a resposta a um pedido de permissão é montada só pelo coletor, vale uma vez e nunca cria regra;
// - nenhum texto de sessão, mensagem ou pedido vai para log ou para mensagem de erro (o fim do stderr
//   do filho só sai passado por `redigir`).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nomeConta } from './sessoes.js';
import { executarEncerrar, logDeEncerramento } from './encerrar.js';
import { hashVisto } from './assinatura.js';
import { escondeConteudo, redigir, redigirBloco } from './redigir.js';
import { diaLocal } from './transcript.js';

export const MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODOS = ['manual', 'acceptEdits', 'plan'];
export const FERRAMENTAS_PADRAO = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

// O modo que o `init` tem de mostrar para cada modo pedido.
const MODO_NO_INIT = { manual: 'default', acceptEdits: 'acceptEdits', plan: 'plan' };
// Configuração fixa da sessão: bypass desligado e os caminhos do coletor e do SSH negados.
const CONFIG_FIXA = JSON.stringify({
  permissions: {
    disableBypassPermissionsMode: 'disable',
    deny: [
      'Read(~/.config/moises/**)',
      'Edit(~/.config/moises/**)',
      'Read(~/.ssh/**)',
      'Edit(~/.ssh/**)',
      'Read(~/.local/state/moises/**)',
      'Edit(~/.local/state/moises/**)',
    ],
  },
});
const ARG_PROIBIDO = /bypass|dangerously|permission|allowed|settings|setting-sources|add-dir|mcp|plugin/i;
const RE_FERRAMENTA_CONF = /^[A-Za-z]{1,30}$/;
const RE_FERRAMENTA = /^[A-Za-z0-9_.:-]{1,80}$/;
const RE_PEDIDO = /^[A-Za-z0-9_.:-]{1,80}$/;
const RE_NOME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const RE_CONTA = /^[a-z0-9]{1,20}$/;
const RE_CHAVE = /^([a-z0-9]{1,20}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SENSIVEL = /\.config\/moises|\.local\/state\/moises|\.ssh\b|\bprintenv\b|(^|[\s;&|])env(\s|$)|\.claude\/settings|\.git\/hooks|credentials/;
// Comando de Bash com caractere fora de ASCII imprimível (homóglifo, letra acentuada, invisível) também é sensível (S26).
const FORA_DO_ASCII = /[^\x20-\x7E\n\t]/;
// A raiz do repositório onde este coletor roda (a pasta acima de collector/).
const RAIZ_COLETOR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Campos de entrada do Bash que não mudam o que roda: com eles, o painel mostra só o comando.
const CAMPOS_BASH_SIMPLES = new Set(['command', 'description', 'timeout']);
const AMBIENTE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'TMPDIR'];
const MAX_LINHA = 5 * 1024 * 1024;
const MAX_STDERR = 2000;
const MAX_TEXTO = 6000;
const MAX_NOME_LOG = 140;
const MAX_VISTO = 200;
const GUARDA_FALHA_MS = 10 * 60_000;

const ERROS = {
  dados: 'Dados do comando fora do formato.',
  verbo: 'Verbo desconhecido.',
  fechado: 'O coletor está encerrando; tente de novo em instantes.',
  sessao: 'Sessão inválida.',
  projeto: 'Projeto fora da lista deste computador.',
  conta: 'Conta desconhecida neste computador.',
  tetoSessoes: (n) => `Já há ${n} sessões comandadas abertas; encerre uma antes de abrir outra.`,
  tetoDia: (n) => `Limite de ${n} aberturas e retomadas pelo painel hoje atingido.`,
  contagem: 'Não foi possível registrar a abertura neste computador; nada foi aberto.',
  naoComandada: 'Esta sessão não foi aberta pelo Moisés; só é possível ver e encerrar.',
  naoPendente: 'Este pedido de permissão não está mais pendente.',
  incompleto: 'Este pedido não coube inteiro no painel; só é possível negar.',
  sensivel: 'Este pedido mexe em configuração ou chaves; aprove só no computador, ou negue.',
  pastaColetor: 'Esta pasta contém o próprio Moisés; abra-a só pelo terminal.',
  hash: 'O pedido mudou desde que apareceu no painel; atualize e confira de novo.',
  aindaAberta: 'A sessão ainda está aberta; encerre antes de retomar.',
  saindo: 'A sessão já está sendo encerrada.',
  pasta: 'A pasta da sessão não está na lista de projetos deste computador.',
  prefixo: 'Neste computador só é possível comandar sessões cujo nome começa com o prefixo configurado.',
  visto: 'A sessão mudou desde que você abriu o painel; atualize e tente de novo.',
  init: 'A sessão abriu com configuração diferente da esperada e foi encerrada.',
  demorou: 'A sessão não respondeu a tempo e foi encerrada.',
  iniciar: 'Não foi possível iniciar o Claude Code neste computador.',
  escrita: 'A sessão não está aceitando mensagens.',
  naoEncerrou: 'O processo da sessão não respondeu ao pedido de encerrar.',
};
const falha = (erro) => ({ ok: false, erro });
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textoValido = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// Resolve `p` dentro de `ms`: true se resolveu, false se o prazo passou. Não deixa temporizador para trás.
async function comPrazo(p, ms) {
  let t;
  const prazo = new Promise((r) => (t = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([p.then(() => true), prazo]);
  } finally {
    clearTimeout(t);
  }
}

// Caminho absoluto de um diretório existente, com links resolvidos; null para qualquer outra coisa.
function pastaReal(c) {
  if (typeof c !== 'string' || !path.isAbsolute(c)) return null;
  try {
    const real = fs.realpathSync(c);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// Lê o stdout do filho linha a linha, em bytes (um caractere multibyte pode chegar partido).
// Linha com mais de MAX_LINHA bytes é descartada inteira, sem guardar o excesso na memória.
function lerLinhas(stream, aoLer) {
  let pedacos = [];
  let tamanho = 0;
  let descartando = false;
  stream.on('data', (buf) => {
    let ini = 0;
    while (ini < buf.length) {
      const nl = buf.indexOf(10, ini);
      const fim = nl === -1 ? buf.length : nl;
      if (!descartando) {
        if (tamanho + (fim - ini) > MAX_LINHA) {
          descartando = true;
          pedacos = [];
          tamanho = 0;
        } else {
          pedacos.push(buf.subarray(ini, fim));
          tamanho += fim - ini;
        }
      }
      if (nl === -1) break;
      if (!descartando) aoLer(Buffer.concat(pedacos, tamanho).toString('utf8'));
      pedacos = [];
      tamanho = 0;
      descartando = false;
      ini = nl + 1;
    }
  });
}

// O que o painel mostra de um pedido: o comando, no Bash simples; senão a entrada inteira em JSON.
function textoDoPedido(ferramenta, input) {
  if (ferramenta === 'Bash' && ehObjeto(input) && typeof input.command === 'string' && Object.keys(input).every((k) => CAMPOS_BASH_SIMPLES.has(k))) {
    return input.command;
  }
  return JSON.stringify(input ?? null, null, 2) ?? '';
}

function vistoConfere(visto, real) {
  if (!ehObjeto(visto) || typeof visto.projeto !== 'string' || visto.projeto.length > MAX_VISTO) return false;
  if (!(visto.nome === null || (typeof visto.nome === 'string' && visto.nome.length <= MAX_VISTO))) return false;
  return visto.projeto === real.projeto && visto.nome === (real.nome ?? null);
}

export class Orquestrador {
  constructor({
    coletor,
    projetos,
    pastaEstado,
    claudeBin = 'claude',
    argsExtra = [],
    ferramentas = FERRAMENTAS_PADRAO,
    tetoSessaoUsd = 5,
    maxSessoes = 4,
    maxAbrirPorDia = 20,
    permissaoExpiraMs = 30 * 60_000,
    soPrefixo = null,
    agora = () => Date.now(),
    esperaAberturaMs = 30_000,
    esperaRetomarMs = 5000,
    esperaFimMs = 10_000,
    esperaTermMs = 5000,
    kill = null,
    pastaColetor = RAIZ_COLETOR,
  } = {}) {
    // As mensagens de erro não citam o valor recebido (argsExtra pode trazer um prompt inteiro).
    if (!Array.isArray(argsExtra) || argsExtra.some((a) => typeof a !== 'string' || ARG_PROIBIDO.test(a))) {
      throw new Error('argsExtra inválido: só argumentos que não mexem em permissão, configuração, MCP ou plugin.');
    }
    if (!Array.isArray(ferramentas) || !ferramentas.length || ferramentas.some((f) => typeof f !== 'string' || !RE_FERRAMENTA_CONF.test(f))) {
      throw new Error('ferramentas inválidas: lista de nomes só com letras, até 30 cada.');
    }
    if (typeof tetoSessaoUsd !== 'number' || !(tetoSessaoUsd >= 0.01 && tetoSessaoUsd <= 100)) {
      throw new Error('teto de gasto por sessão inválido: número entre 0,01 e 100.');
    }
    this.coletor = coletor;
    this.projetos = projetos;
    this.pastaEstado = pastaEstado;
    this.claudeBin = claudeBin;
    this.argsExtra = [...argsExtra];
    this.ferramentas = [...ferramentas];
    this.tetoSessaoUsd = tetoSessaoUsd;
    this.maxSessoes = maxSessoes;
    this.maxAbrirPorDia = maxAbrirPorDia;
    this.permissaoExpiraMs = permissaoExpiraMs;
    this.soPrefixo = typeof soPrefixo === 'string' && soPrefixo ? soPrefixo : null;
    this.agora = agora;
    this.esperaAberturaMs = esperaAberturaMs;
    this.esperaRetomarMs = esperaRetomarMs;
    this.esperaFimMs = esperaFimMs;
    this.esperaTermMs = esperaTermMs;
    this.opcoesEncerrar = kill ? { kill } : {};
    // Caminho real; se não der para resolver, o caminho absoluto como veio (a recusa continua valendo para ele).
    this.pastaColetor = pastaReal(pastaColetor) ?? path.resolve(String(pastaColetor));
    this.sessoes = new Map(); // chave → registro do processo comandado
    this.falhas = new Map(); // chave → { erro, em, ... } de sessão comandada que morreu sozinha
    this.cwdCache = new Map(); // chave de sessão encerrada → pasta (para `retomavel`, sem reler a cada ciclo)
    this.fechado = false;
  }

  // ------------------------------------------------------------------ verbos

  async executar(cmd, dados) {
    if (this.fechado) return falha(ERROS.fechado);
    if (!ehObjeto(dados)) return falha(ERROS.dados);
    const tipo = cmd?.tipo;
    if (tipo === 'abrir') return this.abrir(dados);
    if (!['mensagem', 'permissao', 'interromper', 'encerrar', 'retomar'].includes(tipo)) return falha(ERROS.verbo);
    const alvo = this.alvo(cmd, dados);
    if (alvo.erro) return falha(alvo.erro);
    if (tipo === 'mensagem') return this.mensagem(alvo, dados);
    if (tipo === 'permissao') return this.permissao(alvo, dados);
    if (tipo === 'interromper') return this.interromper(alvo);
    if (tipo === 'encerrar') return this.encerrar(alvo, dados, cmd);
    return this.retomar(alvo, dados);
  }

  abrir(dados) {
    const { projeto, pedido } = dados;
    const conta = dados.conta ?? 'principal';
    const modo = dados.modoPermissao ?? 'manual';
    const modelo = dados.modelo ?? null;
    const esforco = dados.esforco ?? null;
    const nome = dados.nome ?? null;
    const worktree = dados.worktree ?? false;
    if (
      !textoValido(pedido, MAX_TEXTO) ||
      typeof projeto !== 'string' ||
      typeof conta !== 'string' ||
      !MODOS.includes(modo) ||
      (modelo !== null && !MODELOS.includes(modelo)) ||
      (esforco !== null && !ESFORCOS.includes(esforco)) ||
      (nome !== null && (typeof nome !== 'string' || !RE_NOME.test(nome))) ||
      typeof worktree !== 'boolean'
    ) {
      return falha(ERROS.dados);
    }
    if (this.soPrefixo && !(nome && nome.startsWith(this.soPrefixo))) return falha(ERROS.prefixo);
    const lista = this.lerProjetos();
    const cwd = Object.hasOwn(lista, projeto) ? pastaReal(lista[projeto]) : null;
    if (!cwd) return falha(ERROS.projeto);
    if (this.contemColetor(cwd)) return falha(ERROS.pastaColetor);
    const dir = RE_CONTA.test(conta) ? this.coletor.dirs.find((d) => nomeConta(d) === conta) : null;
    if (!dir) return falha(ERROS.conta);
    // Daqui até registrar a sessão não há `await`: dois comandos simultâneos não furam os tetos.
    const teto = this.conferirTetos();
    if (teto) return falha(teto);
    if (!this.contarAbertura()) return falha(ERROS.contagem);

    const sessionId = crypto.randomUUID();
    const chave = `${conta}:${sessionId}`;
    const args = this.argumentos({ sessionId, modo, modelo, esforco, nome, worktree });
    const rec = this.iniciar({ chave, conta, sessionId, dir, cwd, modo, args, projeto: path.basename(cwd), nome: redigir(nome, 60) });
    if (!rec) return falha(ERROS.iniciar);
    rec.modelo = modelo;
    rec.esforco = esforco;
    // O `init` só chega depois da primeira mensagem: o pedido vai logo, e a abertura vale no primeiro evento.
    this.escrever(rec, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: pedido }] } });
    return this.esperarPrimeiroEvento(rec, this.esperaAberturaMs, { ok: true, chaveNova: chave }, false);
  }

  mensagem({ rec }, dados) {
    if (!this.ativa(rec)) return falha(ERROS.naoComandada);
    if (!textoValido(dados.texto, MAX_TEXTO)) return falha(ERROS.dados);
    if (!this.escrever(rec, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: dados.texto }] } })) return falha(ERROS.escrita);
    rec.estado = 'trabalhando';
    return { ok: true };
  }

  permissao({ rec }, dados) {
    if (!this.ativa(rec)) return falha(ERROS.naoComandada);
    const { pedido, decisao, vistoHash } = dados;
    if (typeof pedido !== 'string' || !RE_PEDIDO.test(pedido) || (decisao !== 'aprovar' && decisao !== 'negar')) return falha(ERROS.dados);
    const p = rec.pendentes.get(pedido);
    if (!p) return falha(ERROS.naoPendente);
    if (this.agora() - p.criadoEm >= this.permissaoExpiraMs) {
      this.expirar(rec, pedido);
      return falha(ERROS.naoPendente);
    }
    if (decisao === 'aprovar') {
      // Pedido sensível só se aprova no computador; pelo painel, só negar.
      if (p.sensivel) return falha(ERROS.sensivel);
      if (!p.completo) return falha(ERROS.incompleto);
      if (typeof vistoHash !== 'string' || vistoHash !== p.hash) return falha(ERROS.hash);
    }
    // Sai da lista antes de responder: cada pedido é respondido uma vez só.
    this.tirarPendente(rec, pedido);
    const resposta = decisao === 'aprovar' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Negado pelo painel.' };
    if (!this.escrever(rec, { type: 'control_response', response: { subtype: 'success', request_id: pedido, response: resposta } })) return falha(ERROS.escrita);
    rec.estado = 'trabalhando';
    return { ok: true };
  }

  interromper({ rec }) {
    if (!this.ativa(rec)) return falha(ERROS.naoComandada);
    const id = `int_${crypto.randomBytes(8).toString('hex')}`;
    if (!this.escrever(rec, { type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })) return falha(ERROS.escrita);
    // Os pedidos pendentes morrem com o turno interrompido.
    for (const pedido of [...rec.pendentes.keys()]) this.tirarPendente(rec, pedido);
    return { ok: true };
  }

  async encerrar({ chave, rec }, dados, cmd) {
    const nome = dados.nome ?? null;
    if (nome !== null && (typeof nome !== 'string' || nome.length > MAX_NOME_LOG)) return falha(ERROS.dados);
    if (rec?.saindo) return falha(ERROS.saindo);
    if (!this.ativa(rec)) {
      // Sessão aberta à mão: o encerrar antigo, que confere pid, início e executável.
      const idadeMs = Number.isFinite(cmd.idadeMs) ? cmd.idadeMs : 0;
      return executarEncerrar(this.coletor, { id: cmd.id, chave, nome, idadeMs }, this.opcoesEncerrar);
    }
    if (!(await this.encerrarFilho(rec))) return falha(ERROS.naoEncerrou);
    const fim = this.agora();
    return { ok: true, log: logDeEncerramento(this.sessaoReal(chave, rec), nome, fim) };
  }

  retomar({ chave, conta, sessionId, dir, rec, real }, dados) {
    const modo = dados.modoPermissao ?? 'manual';
    const modelo = dados.modelo ?? null;
    const esforco = dados.esforco ?? null;
    if (!MODOS.includes(modo) || (modelo !== null && !MODELOS.includes(modelo)) || (esforco !== null && !ESFORCOS.includes(esforco))) {
      return falha(ERROS.dados);
    }
    if (rec || (real.estado != null && real.estado !== 'encerrada')) return falha(ERROS.aindaAberta);
    let bruta = null;
    try {
      bruta = this.coletor.cwdDe(chave);
    } catch {
      bruta = null;
    }
    const cwd = this.pastaPermitida(bruta, this.lerProjetos());
    if (!cwd) return falha(ERROS.pasta);
    if (this.contemColetor(cwd)) return falha(ERROS.pastaColetor);
    const teto = this.conferirTetos();
    if (teto) return falha(teto);
    if (!this.contarAbertura()) return falha(ERROS.contagem);
    const args = this.argumentos({ sessionId, retomar: true, modo, modelo, esforco });
    const novo = this.iniciar({ chave, conta, sessionId, dir, cwd, modo, args, projeto: real.projeto, nome: real.nome ?? null });
    if (!novo) return falha(ERROS.iniciar);
    novo.estado = 'esperando_mensagem';
    novo.modelo = modelo;
    novo.esforco = esforco;
    this.falhas.delete(chave);
    // Sem mensagem não há evento: vale o primeiro evento ou o filho vivo depois da espera.
    return this.esperarPrimeiroEvento(novo, this.esperaRetomarMs, { ok: true }, true);
  }

  // ------------------------------------------------------------------ retrato e ciclo de vida

  aplicar(retrato) {
    if (!Array.isArray(retrato.sessoes)) retrato.sessoes = [];
    const sessoes = retrato.sessoes;
    const agora = this.agora();
    for (const [chave, f] of this.falhas) if (agora - f.em > GUARDA_FALHA_MS) this.falhas.delete(chave);
    let lista = null;
    const vistas = new Set();
    for (const s of sessoes) {
      vistas.add(s.chave);
      const rec = this.sessoes.get(s.chave);
      if (rec) {
        Object.assign(s, this.publico(rec));
        s.retomavel = false;
        continue;
      }
      s.retomavel = false;
      if (s.estado === 'encerrada') {
        if (!this.cwdCache.has(s.chave)) {
          let c = null;
          try {
            c = this.coletor.cwdDe(s.chave);
          } catch {
            c = null;
          }
          this.cwdCache.set(s.chave, c);
        }
        const pasta = this.pastaPermitida(this.cwdCache.get(s.chave), (lista ??= this.lerProjetos()));
        s.retomavel = pasta != null && !this.contemColetor(pasta);
      }
      const f = this.falhas.get(s.chave);
      if (f) s.erro = f.erro;
    }
    // A pasta de uma sessão só é guardada enquanto ela está encerrada e no retrato.
    for (const chave of this.cwdCache.keys()) {
      const s = sessoes.find((x) => x.chave === chave);
      if (!s || s.estado !== 'encerrada' || this.sessoes.has(chave)) this.cwdCache.delete(chave);
    }
    for (const rec of this.sessoes.values()) if (!vistas.has(rec.chave)) sessoes.push({ ...this.sintetica(rec, 'ativa'), ...this.publico(rec) });
    for (const [chave, f] of this.falhas) {
      if (vistas.has(chave) || this.sessoes.has(chave)) continue;
      sessoes.push({ ...this.sintetica(f, 'encerrada'), estado: 'encerrada', gerenciada: false, permissoes: [], erro: f.erro });
    }
    return retrato;
  }

  abertas() {
    let n = 0;
    for (const rec of this.sessoes.values()) if (rec.vivo) n++;
    return n;
  }

  async fechar() {
    this.fechado = true;
    await Promise.all([...this.sessoes.values()].map((rec) => this.encerrarFilho(rec)));
  }

  // ------------------------------------------------------------------ processo

  argumentos({ sessionId, retomar = false, modo, modelo, esforco, nome = null, worktree = false }) {
    const a = ['-p', '--input-format=stream-json', '--output-format=stream-json', '--verbose', '--permission-prompt-tool=stdio'];
    a.push(retomar ? `--resume=${sessionId}` : `--session-id=${sessionId}`);
    a.push(`--permission-mode=${modo}`);
    if (modelo) a.push(`--model=${modelo}`);
    if (esforco) a.push(`--effort=${esforco}`);
    if (nome) a.push(`--name=${nome}`);
    if (worktree) a.push(`--worktree=moises-${sessionId.slice(0, 8)}`);
    a.push(
      '--restricted',
      `--tools=${this.ferramentas.join(',')}`,
      '--strict-mcp-config',
      '--disable-slash-commands',
      `--settings=${CONFIG_FIXA}`,
      `--max-budget-usd=${this.tetoSessaoUsd}`,
    );
    return [...a, ...this.argsExtra];
  }

  // Inicia o filho e registra a sessão. Devolve null se o `spawn` falhar na hora.
  iniciar({ chave, conta, sessionId, dir, cwd, modo, args, projeto, nome }) {
    const env = {};
    for (const k of AMBIENTE) if (process.env[k] != null) env[k] = process.env[k];
    if (conta !== 'principal') env.CLAUDE_CONFIG_DIR = dir;
    let filho;
    try {
      // `detached`: o filho lidera um grupo de processos próprio, e os sinais de encerramento vão para o
      // grupo inteiro, alcançando os netos (comandos que o Bash deixou em segundo plano) (S18).
      filho = spawn(this.claudeBin, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
    const rec = {
      chave,
      conta,
      sessionId,
      projeto,
      nome,
      modo,
      filho,
      estado: 'trabalhando',
      pendentes: new Map(),
      vivo: true,
      saindo: false, // encerrar ou fechar pediu o fim: o fim não é erro
      morto: false, // morto pelo coletor (init divergente, demora): a saída que ainda chegar é ignorada
      initConferido: false, // até o primeiro `init` conferido, nenhum pedido de permissão vale
      stderr: '',
      linhasIgnoradas: 0,
      custo: 0,
      erro: null,
      relatado: false,
      falhouSpawn: false,
      saida: null,
      aoEvento: null,
      aoFim: [],
      abertaEm: this.agora(),
    };
    this.sessoes.set(chave, rec);
    // Escrever num filho que morreu dá EPIPE: o erro é tratado em `escrever`, nunca derruba o coletor.
    filho.stdin.on('error', () => {});
    filho.stdout.on('error', () => {});
    filho.stderr.on('error', () => {});
    lerLinhas(filho.stdout, (linha) => this.aoLer(rec, linha));
    filho.stderr.setEncoding('utf8');
    filho.stderr.on('data', (s) => {
      rec.stderr = (rec.stderr + s).slice(-MAX_STDERR);
    });
    filho.on('error', () => {
      rec.falhouSpawn = true;
      this.finalizar(rec);
    });
    // `close` espera o stdio fechar (o fim do stderr já foi lido). Se um neto segurar os canais abertos,
    // `exit` garante o fim do registro pouco depois.
    filho.on('exit', (codigo, sinal) => {
      rec.saida ??= { codigo, sinal };
      // A sessão acabou: o que ainda sobrar no grupo dela (netos) morre junto. Só o grupo, nunca o pid,
      // que já pode ter sido reaproveitado.
      this.sinalizar(rec, 'SIGKILL', { soGrupo: true });
      setTimeout(() => this.finalizar(rec), 1000).unref();
    });
    filho.on('close', (codigo, sinal) => {
      rec.saida ??= { codigo, sinal };
      this.finalizar(rec);
    });
    return rec;
  }

  esperarPrimeiroEvento(rec, ms, resultadoOk, vivoBasta) {
    return new Promise((resolve) => {
      const aviso = ({ ok, erro }) => {
        clearTimeout(timer);
        resolve(ok ? resultadoOk : falha(erro));
      };
      const timer = setTimeout(() => {
        if (rec.aoEvento !== aviso) return;
        rec.aoEvento = null;
        if (vivoBasta && this.ativa(rec)) return resolve(resultadoOk);
        rec.relatado = true;
        this.matar(rec);
        resolve(falha(ERROS.demorou));
      }, ms);
      rec.aoEvento = aviso;
    });
  }

  avisar(rec, resultado) {
    const aviso = rec.aoEvento;
    if (!aviso) return false;
    rec.aoEvento = null;
    if (!resultado.ok) rec.relatado = true;
    aviso(resultado);
    return true;
  }

  aoLer(rec, linha) {
    if (!rec.vivo || rec.morto) return;
    if (!linha.trim()) return;
    let ev;
    try {
      ev = JSON.parse(linha);
    } catch {
      rec.linhasIgnoradas++;
      return;
    }
    if (!ehObjeto(ev)) {
      rec.linhasIgnoradas++;
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (!this.initConfere(rec, ev)) return this.initDivergiu(rec);
      rec.initConferido = true;
    }
    if (ev.type === 'control_request') this.pedidoDeControle(rec, ev);
    else if (ev.type === 'result') {
      // Um turno inteiro sem `init`: a configuração da sessão nunca foi conferida (S19).
      if (!rec.initConferido) return this.initDivergiu(rec);
      // O turno acabou: um pedido que ainda estivesse na lista não vale mais.
      for (const pedido of [...rec.pendentes.keys()]) this.tirarPendente(rec, pedido);
      rec.estado = 'esperando_mensagem';
      if (Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0) rec.custo = ev.total_cost_usd;
    }
    // Outros tipos (assistant, user, rate_limit_event, control_response, system de outro subtipo): só contam como sinal de vida.
    this.avisar(rec, { ok: true });
  }

  // Configuração diferente da esperada (ou nunca mostrada): mata o filho e devolve o erro do `init`.
  initDivergiu(rec) {
    rec.erro = ERROS.init;
    this.matar(rec);
    this.avisar(rec, falha(ERROS.init));
  }

  initConfere(rec, ev) {
    return (
      ev.permissionMode === MODO_NO_INIT[rec.modo] &&
      Array.isArray(ev.mcp_servers) &&
      ev.mcp_servers.length === 0 &&
      Array.isArray(ev.tools) &&
      ev.tools.every((f) => this.ferramentas.includes(f))
    );
  }

  pedidoDeControle(rec, ev) {
    const req = ev.request;
    const id = ev.request_id;
    if (!ehObjeto(req) || req.subtype !== 'can_use_tool') {
      this.escrever(rec, { type: 'control_response', response: { subtype: 'error', request_id: id, error: 'não suportado' } });
      return;
    }
    // Id que o painel não consegue citar, ou repetido (ambíguo): negado na hora, sem passar pelo painel.
    if (typeof id !== 'string' || !RE_PEDIDO.test(id) || rec.pendentes.has(id)) {
      if (typeof id === 'string') this.tirarPendente(rec, id);
      this.escrever(rec, { type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'Pedido em formato inesperado.' } } });
      return;
    }
    // Sem um `init` conferido, o modo de permissão e as ferramentas não foram vistos: negado na hora, sem publicar (S19).
    if (!rec.initConferido) {
      this.escrever(rec, { type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'Sessão sem configuração conferida.' } } });
      return;
    }
    const nomeOk = typeof req.tool_name === 'string' && RE_FERRAMENTA.test(req.tool_name);
    const ferramenta = nomeOk ? req.tool_name : '?';
    const textoCompleto = textoDoPedido(ferramenta, req.input);
    const { texto, alterado } = redigirBloco(textoCompleto, 4000);
    const subirTexto = process.env.MOISES_SUBIR_TEXTO !== '0';
    const entrada = subirTexto ? texto : '';
    const comandoBash = ferramenta === 'Bash' && ehObjeto(req.input) && typeof req.input.command === 'string' ? req.input.command : null;
    const p = {
      pedido: id,
      ferramenta,
      entrada,
      // Inteiro só se nada foi mascarado, cortado ou escapado e se o texto não tem jeito de esconder parte de si (S14).
      completo: subirTexto && nomeOk && !alterado && ehObjeto(req.input) && !escondeConteudo(texto),
      sensivel: SENSIVEL.test(textoCompleto) || (comandoBash !== null && FORA_DO_ASCII.test(comandoBash)),
      criadoEm: this.agora(),
      hash: hashVisto(ferramenta, entrada),
      input: req.input,
      timer: setTimeout(() => this.expirar(rec, id), this.permissaoExpiraMs),
    };
    p.timer.unref?.();
    rec.pendentes.set(id, p);
  }

  expirar(rec, pedido) {
    if (!rec.pendentes.has(pedido)) return;
    this.tirarPendente(rec, pedido);
    this.escrever(rec, { type: 'control_response', response: { subtype: 'success', request_id: pedido, response: { behavior: 'deny', message: 'Sem resposta do painel a tempo.' } } });
  }

  tirarPendente(rec, pedido) {
    const p = rec.pendentes.get(pedido);
    if (!p) return;
    clearTimeout(p.timer);
    rec.pendentes.delete(pedido);
  }

  // Uma linha JSON no stdin. Quebras de linha do texto saem escapadas pelo JSON: o texto não forja protocolo.
  escrever(rec, obj) {
    const s = rec.filho.stdin;
    if (!rec.vivo || rec.morto || !s || s.destroyed || s.writableEnded) return false;
    try {
      s.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // Fim sem pedido de ninguém (configuração divergente, demora na abertura): SIGKILL na hora.
  matar(rec) {
    rec.morto = true;
    rec.saindo = true;
    for (const pedido of [...rec.pendentes.keys()]) this.tirarPendente(rec, pedido);
    try {
      rec.filho.stdin.end();
    } catch {
      /* já fechado */
    }
    this.sinalizar(rec, 'SIGKILL');
  }

  // Manda o sinal ao grupo de processos da sessão; se o grupo não existir, ao próprio filho.
  // O pid tem de ser de verdade (> 1): `kill(-0)` e `kill(-1)` atingiriam o coletor ou todos os processos.
  sinalizar(rec, sinal, { soGrupo = false } = {}) {
    const pid = rec.filho?.pid;
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(-pid, sinal);
        return;
      } catch {
        /* grupo inexistente: cai para o pid */
      }
    }
    if (soGrupo) return;
    try {
      rec.filho.kill(sinal);
    } catch {
      /* já morreu */
    }
  }

  // Fecha o stdin; se não sair em esperaFimMs, SIGTERM; mais esperaTermMs, SIGKILL.
  async encerrarFilho(rec) {
    if (!rec.vivo) return true;
    rec.saindo = true;
    for (const pedido of [...rec.pendentes.keys()]) this.tirarPendente(rec, pedido);
    const saiu = new Promise((r) => rec.aoFim.push(r));
    try {
      rec.filho.stdin.end();
    } catch {
      /* já fechado */
    }
    if (await comPrazo(saiu, this.esperaFimMs)) return true;
    this.sinalizar(rec, 'SIGTERM');
    if (await comPrazo(saiu, this.esperaTermMs)) return true;
    this.sinalizar(rec, 'SIGKILL');
    return comPrazo(saiu, 5000);
  }

  // O filho saiu (ou nem chegou a iniciar). Idempotente: `exit`, `close` e `error` podem chegar juntos.
  finalizar(rec) {
    if (!rec.vivo) return;
    rec.vivo = false;
    rec.estado = 'encerrada';
    for (const pedido of [...rec.pendentes.keys()]) this.tirarPendente(rec, pedido);
    if (this.sessoes.get(rec.chave) === rec) this.sessoes.delete(rec.chave);
    for (const f of rec.aoFim.splice(0)) f();
    // Abertura ou retomada ainda esperando: a falha volta no próprio comando.
    if (rec.aoEvento) {
      this.avisar(rec, falha(rec.falhouSpawn ? ERROS.iniciar : (rec.erro ?? this.erroDeSaida(rec, 'A sessão terminou antes de responder'))));
      return;
    }
    if (rec.relatado) return;
    // Fim que ninguém pediu, com erro: fica publicado no retrato por um tempo.
    let erro = rec.erro;
    if (!erro && rec.falhouSpawn) erro = ERROS.iniciar;
    if (!erro && !rec.saindo && rec.saida?.codigo !== 0) erro = this.erroDeSaida(rec, 'A sessão terminou com erro');
    if (!erro) return;
    rec.relatado = true;
    this.falhas.set(rec.chave, { chave: rec.chave, sessionId: rec.sessionId, conta: rec.conta, projeto: rec.projeto, nome: rec.nome, erro, em: this.agora() });
  }

  // Frase fixa, o código de saída e o fim do stderr passado por `redigir`.
  erroDeSaida(rec, frase) {
    const { codigo = null, sinal = null } = rec.saida ?? {};
    const motivo = codigo != null ? `código ${codigo}` : sinal ? `sinal ${sinal}` : 'sem código';
    const fimStderr = redigir(rec.stderr, 200);
    return `${frase} (${motivo})${fimStderr ? `: ${fimStderr}` : '.'}`;
  }

  // ------------------------------------------------------------------ apoio

  ativa(rec) {
    return !!rec && rec.vivo && !rec.saindo;
  }

  estadoPublico(rec) {
    return rec.pendentes.size ? 'esperando_permissao' : rec.estado;
  }

  publico(rec) {
    return {
      gerenciada: true,
      estado: this.estadoPublico(rec),
      permissoes: [...rec.pendentes.values()].map(({ pedido, ferramenta, entrada, completo, sensivel, criadoEm }) => ({ pedido, ferramenta, entrada, completo, sensivel, criadoEm })),
    };
  }

  // Sessão comandada que o coletor ainda não vê (o retrato dele sai do registro e do transcript).
  sintetica(r, status) {
    return {
      chave: r.chave,
      sessionId: r.sessionId,
      conta: r.conta,
      projeto: r.projeto,
      nome: r.nome,
      tarefa: null,
      tarefaOrigem: null,
      ultimaResposta: null,
      ultimaRespostaEm: null,
      status,
      retomavel: false,
      custo: 0,
      custoHoje: 0,
      tokens: 0,
    };
  }

  // A sessão como o dono a vê no painel (a mesma regra do `aplicar`): a do coletor, ou, para a comandada
  // que ele ainda não vê (viva ou que morreu com erro), o projeto e o nome com que foi aberta.
  sessaoReal(chave, rec) {
    let s = null;
    try {
      s = this.coletor.sessaoDe(chave);
    } catch {
      s = null;
    }
    if (s && s.projeto !== '?') return s;
    const r = rec ?? this.falhas.get(chave);
    if (r) {
      return {
        chave,
        sessionId: r.sessionId,
        conta: r.conta,
        projeto: r.projeto,
        nome: r.nome,
        tarefa: null,
        tarefaOrigem: null,
        resumo: null,
        iniciadaEm: r.abertaEm ?? null,
        modelo: r.modelo ?? null,
        esforco: r.esforco ?? null,
        porModelo: {},
        tokens: 0,
        custo: r.custo ?? 0,
      };
    }
    return s || { projeto: '?', nome: null };
  }

  // Confere chave, conta, prefixo e `visto` de todo verbo que age sobre uma sessão.
  alvo(cmd, dados) {
    const m = RE_CHAVE.exec(typeof cmd.chave === 'string' ? cmd.chave : '');
    if (!m) return { erro: ERROS.sessao };
    const [chave, conta, sessionId] = m;
    const dir = this.coletor.dirs.find((d) => nomeConta(d) === conta);
    if (!dir) return { erro: ERROS.conta };
    const rec = this.sessoes.get(chave) || null;
    const real = this.sessaoReal(chave, rec);
    if (this.soPrefixo && !(typeof real.nome === 'string' && real.nome.startsWith(this.soPrefixo))) return { erro: ERROS.prefixo };
    if (!vistoConfere(dados.visto, real)) return { erro: ERROS.visto };
    return { chave, conta, sessionId, dir, rec, real };
  }

  lerProjetos() {
    try {
      const p = this.projetos();
      return ehObjeto(p) ? p : {};
    } catch {
      return {};
    }
  }

  // A pasta resolvida tem de ser a de um projeto da lista ou estar dentro de <projeto>/.claude/worktrees/.
  pastaPermitida(cwd, lista) {
    const real = pastaReal(cwd);
    if (!real) return null;
    for (const caminho of Object.values(lista)) {
      const base = pastaReal(caminho);
      if (!base) continue;
      if (real === base) return real;
      const rel = path.relative(path.join(base, '.claude', 'worktrees'), real);
      if (rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..') return real;
    }
    return null;
  }

  // Verdadeiro se a pasta (caminho real) é a do coletor ou fica acima dela: uma sessão ali poderia
  // reescrever o próprio coletor (S23).
  contemColetor(real) {
    const rel = path.relative(real, this.pastaColetor);
    return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
  }

  conferirTetos() {
    if (this.abertas() >= this.maxSessoes) return ERROS.tetoSessoes(this.maxSessoes);
    if (this.lerContagem().n >= this.maxAbrirPorDia) return ERROS.tetoDia(this.maxAbrirPorDia);
    return null;
  }

  arqContagem() {
    return path.join(this.pastaEstado, 'abrir.json');
  }

  lerContagem() {
    const dia = diaLocal(this.agora());
    try {
      const c = JSON.parse(fs.readFileSync(this.arqContagem(), 'utf8'));
      if (c?.dia === dia && Number.isSafeInteger(c.n) && c.n >= 0) return { dia, n: c.n };
    } catch {
      /* primeira abertura, ou arquivo ilegível: conta do zero */
    }
    return { dia, n: 0 };
  }

  // Grava antes de abrir (temporário + rename, permissão 600). Se não conseguir gravar, não abre.
  contarAbertura() {
    const { dia, n } = this.lerContagem();
    const arq = this.arqContagem();
    const tmp = `${arq}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.pastaEstado, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ dia, n: n + 1 }), { mode: 0o600 });
      fs.renameSync(tmp, arq);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nada a limpar */
      }
      return false;
    }
  }
}
