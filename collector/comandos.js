// Canal de comandos do painel, do lado do coletor: o Chaveiro guarda as chaves de cada aparelho
// autorizado e o Porteiro decide se um comando é aceito. É o ponto de decisão de segurança: o
// servidor e o Redis só transportam, e nada que venha deles é executado sem passar por aqui.
// Contrato e ordem das conferências no PLANO ("Contrato comum", tarefas 3 e 12); o porquê em ACHADOS
// (S5: ordem fixa, id gravado antes de executar, poda só por tempo; S7: formato antes da
// assinatura; S11: teto por minuto só para assinatura válida; R1: data no futuro também gasta o teto).
import fs from 'node:fs';
import path from 'node:path';
import { assinaturaConfere, chavePublica, impressaoDaPublica, RE_ASSINATURA, RE_KID } from './assinatura.js';
import { pastaSoDoDono } from './auditoria.js';
// Uma só fonte para o que o orquestrador também confere: listas de modelo, esforço e modo, e a chave de sessão.
import { ESFORCOS, MODELOS, MODOS, RE_CHAVE as RE_SESSAO } from './orquestrador.js';

export const TIPOS = Object.freeze(['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar']);
export const JANELA_MS = 120_000;
export const FOLGA_FUTURO_MS = 30_000;
export const GUARDA_IDS_MS = 600_000;

const MINUTO_MS = 60_000;
// Um id com data no futuro fica guardado até a própria data (mais a guarda), para não voltar a valer
// quando o relógio a alcançar, mas no máximo até 24 h depois da chegada: o arquivo não cresce sem
// limite. Resto aceito (R1): aparelho com relógio adiantado mais de 24 h.
const HORIZONTE_FUTURO_MS = 24 * 3_600_000;
const ARQ_VISTOS = 'comandos-vistos.json';
const MAX_DADOS = 8_000;
const MAX_ROTULO = 40;

// Campos do comando (conferidos antes da assinatura). O kid e a assinatura usam as regex de
// collector/assinatura.js; a chave de sessão, a de collector/orquestrador.js.
// A assinatura é ECDSA SHA-256 em IEEE P1363 (64 bytes) e base64url sem '=' (tarefa 15, achado A1): a
// assinatura HMAC do código do aparelho (43 caracteres) não vale mais e cai no formato.
const RE_ID = /^c_[0-9a-f]{16}$/;
const RE_TIPO = /^[A-Za-z_]{1,20}$/; // só a forma; se é um verbo conhecido, decide a etapa `verbo`
// Dados por verbo.
const RE_PROJETO = /^[A-Za-z0-9._-]{1,60}$/; // mesma regra dos nomes de projetos.json
const RE_CONTA = /^[a-z0-9]{1,20}$/; // mesma regra do prefixo da chave de sessão
const RE_NOME_SESSAO = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const RE_PEDIDO = /^[A-Za-z0-9_.:-]{1,80}$/;
const RE_HASH = /^[0-9a-f]{64}$/;
// Motivo de `desligar` (vai no ack e na auditoria).
const RE_MOTIVO = /^[a-z_]{1,20}$/;
const DECISOES = ['aprovar', 'negar'];

const ERROS = {
  desligado: 'Os comandos pelo painel estão desligados neste computador.',
  sem_chave: 'Nenhum aparelho está autorizado neste computador.',
  sem_credencial: 'Comando sem assinatura.',
  formato: 'Comando em formato inválido.',
  verbo: 'Tipo de comando desconhecido.',
  aparelho: 'Este aparelho não está autorizado neste computador.',
  assinatura: 'A assinatura do comando não confere com a chave deste aparelho.',
  expirado: 'O comando demorou mais de 2 minutos para chegar e não foi executado.',
  relogio: 'O relógio do aparelho está adiantado; acerte a hora e tente de novo.',
  repetido: 'Este comando já tinha sido recebido.',
  ritmo: 'Comandos demais em pouco tempo; espere um minuto e tente de novo.',
  interno: 'Erro interno do coletor; o comando não foi executado.',
  painel_alterado: 'O painel publicado é diferente do código deste computador; comandos desligados.',
};
// Mesmo motivo `relogio`, outra mensagem: o comando chegou há pouco ao servidor, mas veio datado
// antes da janela (achado Q1).
const ERRO_ATRASADO = 'O relógio do aparelho está atrasado; acerte a hora e tente de novo.';

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const desligado = () => process.env.MOISES_COMANDOS === '0';

// ---------- Chaveiro ----------

// Arquivo JSON { "<kid>": { "rotulo", "publica": "<pública ECDSA P-256 raw em base64url>", "criadaEm" } },
// com permissão 600, gravado por `configurar-comandos.js --autorizar` depois de o dono conferir a
// impressão digital (achado A1). Entrada com chave pública fora do formato ou fora da curva, e a do
// formato antigo (chave HMAC do código do aparelho), é ignorada.
// É relido quando muda (inode, tamanho, mtime, ctime ou modo): revogar um aparelho vale sem reiniciar.
export class Chaveiro {
  constructor({ arquivo }) {
    this.arquivo = arquivo;
    this.marca = undefined;
    this.chaves = new Map();
  }

  obter(kid) {
    if (typeof kid !== 'string') return null;
    this.#recarregar();
    const e = this.chaves.get(kid);
    return e ? { chave: e.chave, rotulo: e.rotulo } : null;
  }

  aparelhos() {
    this.#recarregar();
    return [...this.chaves].map(([kid, e]) => ({ kid, rotulo: e.rotulo }));
  }

  #recarregar() {
    let st;
    try {
      st = fs.statSync(this.arquivo, { bigint: true });
    } catch {
      this.marca = null;
      this.chaves = new Map();
      return;
    }
    if (marcaDe(st) === this.marca) return;
    let fd = null;
    try {
      fd = fs.openSync(this.arquivo, 'r');
      // A marca e a permissão vêm do mesmo arquivo aberto que vai ser lido.
      const aberto = fs.fstatSync(fd, { bigint: true });
      this.marca = marcaDe(aberto);
      this.chaves = new Map();
      if (!aberto.isFile()) return aviso('não é um arquivo comum');
      if ((Number(aberto.mode) & 0o077) !== 0) return aviso('tem permissão mais aberta que 600');
      let json;
      try {
        json = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } catch {
        // A mensagem do JSON.parse cita trechos do arquivo: nunca vai para o log.
        return aviso('não é um JSON válido');
      }
      if (!objetoSimples(json)) return aviso('não é um objeto JSON');
      let ignorados = 0;
      for (const [kid, e] of Object.entries(json)) {
        // KeyObject imutável: quem chama obter() não consegue trocar a chave guardada.
        const chave = RE_KID.test(kid) && objetoSimples(e) ? chavePublica(e.publica) : null;
        if (!chave) {
          ignorados++;
          continue;
        }
        // O kid tem de ser o derivado da própria chave pública (SE-B3): uma chave copiada para outro kid,
        // ou um kid com a chave de outro aparelho, não vale. O aviso cita só o kid (já conferido no formato).
        if (impressaoDaPublica(e.publica)?.kid !== kid) {
          console.error(`chaveiro: aparelho ${kid} ignorado: o kid não é o da chave pública dele; autorize de novo com configurar-comandos.js --pedidos e --autorizar.`);
          continue;
        }
        const rotulo = typeof e.rotulo === 'string' ? Array.from(e.rotulo).slice(0, MAX_ROTULO).join('') : '';
        this.chaves.set(kid, { chave, rotulo });
      }
      if (ignorados) {
        console.error(`chaveiro: ${ignorados} aparelho(s) do arquivo de chaves ignorado(s) (formato antigo ou chave pública inválida); autorize de novo com configurar-comandos.js --pedidos e --autorizar.`);
      }
    } catch (err) {
      this.marca = null;
      this.chaves = new Map();
      console.error(`chaveiro: não foi possível ler o arquivo de chaves de comandos (${err?.code || 'erro'}).`);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}

const marcaDe = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;

function aviso(problema) {
  console.error(`chaveiro: o arquivo de chaves de comandos ${problema}; nenhuma chave foi carregada.`);
}

// ---------- Dados por verbo ----------

const texto = (min, max) => (v) => typeof v === 'string' && v.length >= min && v.length <= max;
const casa = (re) => (v) => typeof v === 'string' && re.test(v);
const umDe = (lista) => (v) => typeof v === 'string' && lista.includes(v);
const booleano = (v) => typeof v === 'boolean';
const obrigatorio = (confere) => ({ obrigatorio: true, confere });
const opcional = (confere) => ({ obrigatorio: false, confere });

// `visto` = { projeto: string até 200, nome: string até 200 | null }, exatamente esses dois campos.
function copiarVisto(v) {
  if (!objetoSimples(v)) return null;
  const chaves = Object.keys(v);
  if (chaves.length !== 2 || !Object.hasOwn(v, 'projeto') || !Object.hasOwn(v, 'nome')) return null;
  if (!texto(0, 200)(v.projeto)) return null;
  if (v.nome !== null && !texto(0, 200)(v.nome)) return null;
  const copia = Object.create(null);
  copia.projeto = v.projeto;
  copia.nome = v.nome;
  return copia;
}
const VISTO = { obrigatorio: true, copiar: copiarVisto };

const DADOS = new Map([
  ['abrir', new Map([
    ['projeto', obrigatorio(casa(RE_PROJETO))],
    ['pedido', obrigatorio(texto(1, 6_000))],
    ['conta', opcional(casa(RE_CONTA))],
    ['modelo', opcional(umDe(MODELOS))],
    ['esforco', opcional(umDe(ESFORCOS))],
    ['modoPermissao', opcional(umDe(MODOS))],
    ['worktree', opcional(booleano)],
    ['nome', opcional(casa(RE_NOME_SESSAO))],
  ])],
  ['mensagem', new Map([
    ['texto', obrigatorio(texto(1, 6_000))],
    ['visto', VISTO],
  ])],
  ['permissao', new Map([
    ['pedido', obrigatorio(casa(RE_PEDIDO))],
    ['decisao', obrigatorio(umDe(DECISOES))],
    ['vistoHash', opcional(casa(RE_HASH))],
    ['visto', VISTO],
  ])],
  ['interromper', new Map([['visto', VISTO]])],
  ['encerrar', new Map([
    ['nome', opcional(texto(0, 140))],
    ['visto', VISTO],
  ])],
  ['retomar', new Map([
    ['modoPermissao', opcional(umDe(MODOS))],
    ['modelo', opcional(umDe(MODELOS))],
    ['esforco', opcional(umDe(ESFORCOS))],
    ['visto', VISTO],
  ])],
]);

// Faz o JSON.parse da mesma string cuja assinatura conferiu e devolve um objeto novo, sem protótipo,
// só com os campos da tabela do verbo; null se faltar campo obrigatório, sobrar campo (inclusive
// `__proto__`) ou algum valor fugir da regra. Campo opcional com null conta como ausente.
function dadosDoVerbo(tipo, bruto) {
  let d;
  try {
    d = JSON.parse(bruto);
  } catch {
    return null;
  }
  const regras = DADOS.get(tipo);
  if (!regras || !objetoSimples(d)) return null;
  for (const k of Object.keys(d)) if (!regras.has(k)) return null;
  const saida = Object.create(null);
  for (const [k, regra] of regras) {
    const v = Object.hasOwn(d, k) ? d[k] : undefined;
    if (v === undefined || (v === null && !regra.obrigatorio)) {
      if (regra.obrigatorio) return null;
      continue;
    }
    if (regra.copiar) {
      const copia = regra.copiar(v);
      if (copia === null) return null;
      saida[k] = copia;
    } else {
      if (!regra.confere(v)) return null;
      saida[k] = v;
    }
  }
  if (tipo === 'permissao' && saida.decisao === 'aprovar' && saida.vistoHash === undefined) return null;
  return saida;
}

// ---------- Formato do comando ----------

// Cada campo é lido uma única vez, para um getter não trocar o valor entre a conferência e o uso.
// `idadeMs` é posto pelo servidor e não é assinado: só escolhe a mensagem de uma recusa.
function copiarComando(cmd) {
  if (cmd === null || typeof cmd !== 'object') return null;
  const { v, kid, id, tipo, chave, criadoEm, dados, assinatura, idadeMs } = cmd;
  return { v, kid, id, tipo, chave, criadoEm, dados, assinatura, idadeMs };
}

// Tabela do "Contrato comum". A chave de sessão é conferida aqui, por verbo, porque null e ''
// assinam igual: nula em `abrir`, UUID com conta nos demais.
function formatoConfere(c) {
  if (c.v !== 1) return false;
  if (typeof c.kid !== 'string' || !RE_KID.test(c.kid)) return false;
  if (typeof c.id !== 'string' || !RE_ID.test(c.id)) return false;
  if (typeof c.tipo !== 'string' || !RE_TIPO.test(c.tipo)) return false;
  const chaveOk = typeof c.chave === 'string' && RE_SESSAO.test(c.chave);
  if (c.tipo === 'abrir') {
    if (c.chave !== null) return false;
  } else if (TIPOS.includes(c.tipo)) {
    if (!chaveOk) return false;
  } else if (c.chave !== null && !chaveOk) {
    return false;
  }
  if (!Number.isSafeInteger(c.criadoEm)) return false;
  if (typeof c.dados !== 'string' || c.dados.length > MAX_DADOS) return false;
  if (typeof c.assinatura !== 'string' || !RE_ASSINATURA.test(c.assinatura)) return false;
  return true;
}

// ---------- Porteiro ----------

export class Porteiro {
  constructor({ chaveiro, pastaEstado, auditoria, agora = () => Date.now(), maxPorMinuto = 30 }) {
    if (!Number.isSafeInteger(maxPorMinuto) || maxPorMinuto <= 0) throw new TypeError('maxPorMinuto inválido: inteiro maior que 0.');
    this.chaveiro = chaveiro;
    this.pastaEstado = pastaEstado;
    this.auditoria = auditoria;
    this.agora = agora;
    this.maxPorMinuto = maxPorMinuto;
    this.arqVistos = path.join(pastaEstado, ARQ_VISTOS);
    // id → instante que conta para a poda (sai GUARDA_IDS_MS depois dele): `criadoEm` dos comandos na
    // validade; nos recusados por data no futuro, `criadoEm` limitado à chegada + 24 h (achado R1).
    this.vistos = new Map();
    this.recentes = []; // instantes dos comandos válidos que entraram no teto por minuto
    // Instante da construção quando o arquivo de vistos existia mas não pôde ser lido: sem ele não há
    // como saber se um comando criado antes disso já rodou, e todos esses são recusados (falha fechada).
    this.recusarAntesDe = null;
    // Motivo posto por `desligar` (ex.: `painel_alterado`); null quando ligado.
    this.motivoDesligado = null;
    this.#lerVistos();
  }

  ativo() {
    if (desligado()) return { ativa: false, motivo: 'desligado' };
    if (this.motivoDesligado !== null) return { ativa: false, motivo: this.motivoDesligado };
    if (this.chaveiro.aparelhos().length === 0) return { ativa: false, motivo: 'sem_chave' };
    return { ativa: true, motivo: null };
  }

  // Desliga os comandos até `religar()` (o laço chama quando o painel publicado diverge do código
  // local, achado S15). Motivo fora do formato ainda desliga, com o motivo genérico `desligado`.
  desligar(motivo) {
    this.motivoDesligado = typeof motivo === 'string' && RE_MOTIVO.test(motivo) ? motivo : 'desligado';
  }

  religar() {
    this.motivoDesligado = null;
  }

  // Decide se o comando é aceito, nesta ordem (PLANO, tarefas 3 e 12). Cada decisão vira uma linha
  // na auditoria. Nunca lança: qualquer erro inesperado é recusa com motivo `interno`.
  conferir(cmd) {
    let c = null;
    let quem = null; // só depois da assinatura conferir (achado A5)
    const recusa = (motivo, erro) => this.#recusar(c, quem, motivo, erro);
    try {
      c = copiarComando(cmd);
      if (desligado()) return recusa('desligado');
      if (this.motivoDesligado !== null) return recusa(this.motivoDesligado);
      if (this.chaveiro.aparelhos().length === 0) return recusa('sem_chave');
      if (!c || c.assinatura === undefined || c.assinatura === null || c.assinatura === '') return recusa('sem_credencial');
      if (!formatoConfere(c)) return recusa('formato');
      if (!TIPOS.includes(c.tipo)) return recusa('verbo');
      const ap = this.chaveiro.obter(c.kid);
      if (!ap) return recusa('aparelho');
      if (!assinaturaConfere(ap.chave, c)) return recusa('assinatura');
      quem = `${c.kid} (${ap.rotulo})`;

      const agora = this.agora();
      if (agora - c.criadoEm >= JANELA_MS) {
        // Chegou há pouco ao servidor mas veio datado antes da janela: é o relógio do aparelho. A
        // idade não é assinada, então só muda a mensagem; expirado nunca volta a valer e não é guardado.
        const recente = Number.isFinite(c.idadeMs) && c.idadeMs < JANELA_MS;
        return recente ? recusa('relogio', ERRO_ATRASADO) : recusa('expirado');
      }
      if (c.criadoEm - agora > FOLGA_FUTURO_MS) {
        // Já guardado: recusa de novo sem gastar o teto nem regravar o arquivo.
        if (this.vistos.has(c.id)) return recusa('relogio');
        // O id é sempre guardado como visto, caiba ou não no teto, para quem copiou o comando não
        // reenviá-lo quando ele couber na folga: até a data dele, limitada a agora + 24 h. O teto por
        // minuto aqui só decide a mensagem (`relogio` ou `ritmo`); quem limita o arquivo de vistos é o
        // horizonte de 24 h, com a poda por tempo.
        this.vistos.set(c.id, Math.max(agora, Math.min(c.criadoEm, agora + HORIZONTE_FUTURO_MS)));
        const cabe = this.#cabeNoRitmo(agora);
        this.#gravarVistos(agora);
        return recusa(cabe ? 'relogio' : 'ritmo');
      }
      // Registro de vistos perdido no início (PLANO, tarefa 7): o que foi criado antes pode já ter rodado.
      if (this.recusarAntesDe !== null && c.criadoEm < this.recusarAntesDe) return recusa('interno');
      if (this.vistos.has(c.id)) return recusa('repetido');
      // A partir daqui o id está queimado, seja qual for a decisão.
      this.vistos.set(c.id, c.criadoEm);
      if (!this.#cabeNoRitmo(agora)) {
        this.#gravarVistos(agora);
        return recusa('ritmo');
      }
      const dados = dadosDoVerbo(c.tipo, c.dados);
      if (!dados) {
        this.#gravarVistos(agora);
        return recusa('formato');
      }
      // Falha fechada: sem o id em disco, um reinício permitiria executar de novo.
      if (!this.#gravarVistos(agora)) return recusa('interno');
      this.#auditar(c, quem, 'aceito');
      return { ok: true, dados, quem };
    } catch (err) {
      console.error(`porteiro: erro inesperado ao conferir um comando (${err?.code || err?.name || 'erro'}).`);
      return recusa('interno');
    }
  }

  // Registra o resultado da execução de um comando aceito: `{ ok, erro, chaveNova }`. Num `abrir`
  // bem-sucedido, a sessão da linha é a criada (`chaveNova`, achado R3). A auditoria guarda só a
  // primeira frase do erro (achado S24). Nunca lança.
  concluir(cmd, fim) {
    try {
      const c = { ...(copiarComando(cmd) ?? {}) };
      const kid = typeof c.kid === 'string' ? c.kid : null;
      const ap = kid ? this.chaveiro.obter(kid) : null;
      const ok = fim?.ok === true;
      const erro = !ok && typeof fim?.erro === 'string' && fim.erro ? fim.erro : null;
      if (ok && c.tipo === 'abrir') {
        const nova = fim?.chaveNova;
        c.chave = typeof nova === 'string' && RE_SESSAO.test(nova) ? nova : null;
      }
      this.#auditar(c, ap ? `${kid} (${ap.rotulo})` : kid, ok ? 'feito' : 'falhou', null, erro);
    } catch (err) {
      console.error(`porteiro: não foi possível registrar a conclusão de um comando (${err?.code || err?.name || 'erro'}).`);
    }
  }

  // A linha de recusa leva `quem` (nulo antes da assinatura) e o kid que o comando diz ter, se
  // estiver no formato. Motivo sem texto próprio (um de `desligar`) usa o texto de desligado.
  #recusar(c, quem, motivo, erro = Object.hasOwn(ERROS, motivo) ? ERROS[motivo] : ERROS.desligado) {
    const kidInformado = c && typeof c.kid === 'string' && RE_KID.test(c.kid) ? c.kid : null;
    this.auditoria?.registrar({ id: c?.id, tipo: c?.tipo, chave: c?.chave, quem, kidInformado, decisao: 'recusado', motivo });
    return { ok: false, motivo, erro };
  }

  #auditar(c, quem, decisao, motivo = null, resultado = null) {
    this.auditoria?.registrar({ id: c?.id, tipo: c?.tipo, chave: c?.chave, quem, decisao, motivo, resultado });
  }

  // Teto por minuto, contando só comandos com assinatura válida, dentro da validade e inéditos.
  #cabeNoRitmo(agora) {
    this.recentes = this.recentes.filter((t) => agora - t < MINUTO_MS);
    if (this.recentes.length >= this.maxPorMinuto) return false;
    this.recentes.push(agora);
    return true;
  }

  #lerVistos() {
    let bruto;
    try {
      bruto = fs.readFileSync(this.arqVistos, 'utf8');
    } catch (err) {
      // Arquivo ausente é começo limpo; qualquer outra falha de leitura fecha a porta para o que veio antes.
      if (err?.code === 'ENOENT') return;
      this.recusarAntesDe = this.agora();
      console.error(`porteiro: não foi possível ler os comandos vistos (${err?.code || 'erro'}); comandos anteriores a este início serão recusados.`);
      return;
    }
    let json;
    try {
      json = JSON.parse(bruto);
    } catch {
      json = null;
    }
    if (!objetoSimples(json)) {
      this.recusarAntesDe = this.agora();
      console.error('porteiro: o arquivo de comandos vistos é inválido; comandos anteriores a este início serão recusados.');
      return;
    }
    // Arquivo do formato anterior podia guardar a data do comando sem limite: além do horizonte,
    // o instante é trazido para agora + 24 h (sai, no máximo, 24 h + a guarda depois deste início).
    const teto = this.agora() + HORIZONTE_FUTURO_MS;
    for (const [id, instante] of Object.entries(json)) {
      if (RE_ID.test(id) && Number.isSafeInteger(instante)) this.vistos.set(id, Math.min(instante, teto));
    }
  }

  // Poda por tempo (nunca por contagem: um id só sai quando já não pode valer) e grava por
  // arquivo temporário e rename. Devolve false se não conseguiu gravar.
  #gravarVistos(agora) {
    for (const [id, instante] of this.vistos) if (agora - instante > GUARDA_IDS_MS) this.vistos.delete(id);
    const tmp = `${this.arqVistos}.${process.pid}.tmp`;
    let fd = null;
    try {
      pastaSoDoDono(this.pastaEstado);
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, JSON.stringify(Object.fromEntries(this.vistos)));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.arqVistos);
      return true;
    } catch (err) {
      console.error(`porteiro: não foi possível gravar os comandos vistos (${err?.code || 'erro'}).`);
      if (fd !== null) fs.closeSync(fd);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nada a limpar */
      }
      return false;
    }
  }
}
