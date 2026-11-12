// Painel do Moisés: sessões, histórico e comandos assinados neste aparelho (módulo ES, sem dependências).
// Regras da tela em docs/orquestracao/SPEC-interface.md. A CSP exige Trusted Types: nenhum innerHTML, todo
// texto vindo do coletor entra por textContent. Nada de texto de sessão em console.*.
import { gerarAparelho, impressaoDaPublica, assinarComando, hashVisto } from './assinatura.js';
import { guardar, obter, esquecer } from './cofre.js';

const TZ = 'America/Sao_Paulo';
const INTERVALO_MS = 15000;
const INTERVALO_RAPIDO_MS = 2000; // enquanto houver comando a caminho
const RETRY_MS = 5000;
const COLETOR_PARADO_MS = 120000;
const VISIVEL_MS = 5 * 60_000; // a linha de andamento fica 5 min depois do envio
const AVISO_PARADO_MS = 20_000;
// Depois disso um comando não acelera mais a consulta (o servidor só expira pendentes quando o coletor volta).
const LIMITE_ANDAMENTO_MS = { pendente: 3 * 60_000, recebido: 11 * 60_000 };
const MAX_TEXTO = 6000; // mensagem e pedido inicial (contrato)
const CONTADOR_DESDE = 5000;
const MAX_DADOS = 8000; // tamanho da string `dados` aceito pelo servidor
const MAX_ROTULO = 40; // nome do aparelho no pedido de autorização (o servidor confere de novo)
const INVISIVEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RE_NOME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const TITULO = 'Moisés · Sessões do Claude Code';

/* ---------- Textos ---------- */

const TEXTOS = {
  semAutorizacao: 'Comando não enviado: este aparelho ainda não foi autorizado no computador.',
  rotuloInvalido: 'Escreva um nome de 1 a 40 caracteres para este aparelho, sem quebra de linha.',
  semIndexedDB: 'Este navegador não deixou guardar a chave do aparelho. Saia do modo privado e tente de novo.',
  semCripto: 'Este navegador não oferece a criptografia que os comandos exigem. Abra o painel pelo endereço https e tente de novo.',
  erroChave: 'Não foi possível criar a chave deste aparelho. Tente de novo.',
  pedidosDemais: 'Há pedidos de autorização demais esperando o computador. Autorize os que são seus ou espere uma hora e tente de novo.',
  pedidoEnviado: 'Pedido enviado. Ele chega ao computador no próximo ciclo do coletor e vale por 1 hora.',
  aguardandoAutorizacao: 'Aguardando autorização no computador.',
  aparelhoAutorizado: 'Aparelho autorizado. Já pode mandar comandos.',
  aparelhoEsquecido: (kid) => 'Aparelho esquecido. Para tirar a autorização dele no computador, rode node scripts/configurar-comandos.js --revogar ' + kid + '.',
  desligadoSemDados: 'Comandos desligados: o coletor ainda não enviou dados.',
  desligadoForaDoAr: (h) => 'Comandos desligados: o coletor está fora do ar desde ' + h + '.',
  desligadoOrquestracao: 'Comandos desligados: a orquestração está desligada neste computador.',
  desligadoSemAparelho: 'Comandos desligados: nenhum aparelho está autorizado neste computador. Use "Autorizar este aparelho", no fim da página.',
  desligadoCripto: 'Comandos desligados: este navegador não oferece a criptografia que os comandos exigem (abra o painel por https).',
  bannerSemDados: 'O coletor ainda não enviou dados. Sem ele não dá para mandar comandos.',
  bannerForaDoAr: (h) => 'O coletor está fora do ar desde ' + h + '. Você vê o último estado conhecido, mas não pode mandar comandos.',
  estadoAntigo: (h) => 'Estado de ' + h + '. Pode estar desatualizado.',
  erroRede: 'Não enviado: sem conexão. Tente de novo.',
  erro400: 'Não enviado: o pedido está inválido.',
  erro409: 'Este pedido já tinha sido enviado.',
  erro413: 'Não enviado: o pedido ficou grande demais. Encurte o texto e tente de novo.',
  erro429: 'Há pedidos demais esperando o coletor. Espere alguns instantes e tente de novo.',
  erroOutro: 'Não enviado: erro ao falar com o painel.',
  erroAssinar: 'Não enviado: não foi possível assinar o pedido neste aparelho.',
  semResposta: 'Esta sessão ainda não respondeu.',
  notaOcultoResposta: 'Trechos marcados [oculto] foram escondidos por segurança antes de sair do computador.',
  notaCorte: 'Resposta cortada em 1.200 caracteres.',
  naoComandada: 'Esta sessão foi aberta fora do Moisés. Daqui dá para acompanhar e encerrar. Para mandar mensagens pelo painel, encerre e toque em Retomar.',
  naoComandadaPermissao: 'Esta sessão está esperando permissão no terminal onde foi aberta.',
  encerradaRetomavel: 'Sessão encerrada. Toque em Retomar para continuar a conversa por aqui.',
  encerradaNaoRetomavel: 'Sessão encerrada. A pasta do projeto não está na lista de projetos permitidos deste computador, então não dá para retomar pelo painel.',
  encerrada: 'Sessão encerrada.',
  msgTrabalhando: 'A sessão está trabalhando. Espere terminar ou toque em Interromper.',
  msgPermissao: 'Responda ao pedido de permissão acima antes de mandar outra mensagem.',
  msgAnterior: 'Aguarde a mensagem anterior chegar à sessão.',
  msgLonga: 'A mensagem passa de 6.000 caracteres.',
  msgDevolvida: 'Sua mensagem foi devolvida à caixa.',
  permSensivel: ' Este pedido mexe em configuração ou chaves; aprove só no computador, ou negue.',
  permLinhas: (n) => (n === 1 ? '1 linha' : n + ' linhas'),
  permIncompleto: 'Este pedido não coube inteiro no painel; só é possível negar.',
  permOculto: 'Trechos marcados [oculto] foram escondidos por segurança.',
  permRespondido: 'Resposta enviada. Aguardando o coletor.',
  permForaDoAr: 'O coletor está fora do ar. Este pedido pode já ter sido resolvido.',
  aguardeVerbo: (verbo) => 'Aguarde: já existe um pedido de ' + verbo + ' em andamento.',
  confInterromper: 'Interromper o que a sessão está fazendo agora? A sessão continua aberta e você pode mandar outra mensagem.',
  confEncerrarTitulo: 'Encerrar esta sessão?',
  confEncerrarComandada: 'O processo será fechado no computador. Você pode retomar a conversa depois.',
  confEncerrarManual: 'O Claude Code desta sessão será finalizado no computador, inclusive no terminal onde ele está aberto. Trabalho que não foi salvo pode se perder. Você pode retomar a conversa pelo painel depois.',
  confRetomar: 'Retomar esta conversa no computador?',
  foraDoArPedido: ' O coletor está fora do ar. O pedido vale por 2 minutos e depois expira.',
  expirado: 'O coletor não buscou o pedido em 2 minutos, então ele expirou e não foi executado. Tente de novo quando o coletor voltar.',
  novaDesligada: 'A orquestração está desligada neste computador.',
  novaSemAparelho: 'Nenhum aparelho está autorizado neste computador. Use "Autorizar este aparelho", no fim da página.',
  novaProjetosVazio: 'Nenhum projeto permitido neste computador. Adicione projetos ao arquivo projetos.json, em ~/.config/moises.',
  novaLimite: (n) => 'Limite de ' + n + ' sessões abertas pelo painel. Encerre uma para abrir outra.',
  novaFrase: (abertas, max) => 'O Claude vai trabalhar na pasta do projeto, neste modo, no seu computador. Ele roda isolado: sem seus plugins, MCP, skills e comandos de barra, só com as ferramentas básicas. Sessões abertas pelo painel: ' + abertas + ' de ' + max + '.',
  novaErros: (n) => 'Corrija ' + n + (n === 1 ? ' campo' : ' campos') + ' para continuar.',
  erroProjeto: 'Escolha um projeto.',
  erroPedido: 'Escreva o pedido inicial.',
  erroPedidoLongo: 'O pedido passa de 6.000 caracteres.',
  erroNomeTrabalho: 'Escreva um nome para o trabalho.',
  erroNome: 'Use só letras, números, espaço, ponto, hífen e sublinhado, começando por letra ou número.',
};

// Frases da linha de andamento por verbo (spec, item 6).
const FRASES = {
  mensagem: {
    pendente: 'Mensagem enviada. Aguardando o coletor…',
    recebido: 'O coletor recebeu a mensagem. Entregando à sessão…',
    feito: 'Mensagem entregue à sessão.',
    recusado: 'O coletor recusou a mensagem: ',
    falhou: 'A mensagem não foi entregue: ',
  },
  permissao: {
    pendente: 'Resposta enviada. Aguardando o coletor…',
    recebido: 'O coletor recebeu a resposta. Entregando à sessão…',
    feito: 'Resposta entregue à sessão.',
    recusado: 'O coletor recusou a resposta: ',
    falhou: 'A resposta não foi entregue: ',
  },
  interromper: {
    pendente: 'Pedido de interrupção enviado…',
    recebido: 'O coletor recebeu. Interrompendo…',
    feito: 'Sessão interrompida. Ela espera a sua próxima mensagem.',
    recusado: 'O coletor recusou o pedido de interrupção: ',
    falhou: 'A sessão não foi interrompida: ',
  },
  encerrar: {
    pendente: 'Encerrando… aguardando o coletor.',
    recebido: 'O coletor recebeu. Encerrando a sessão…',
    feito: 'Encerrada. Log salvo no Histórico.',
    recusado: 'O coletor recusou o pedido de encerrar: ',
    falhou: 'Não encerrou: ',
  },
  retomar: {
    pendente: 'Pedido de retomada enviado…',
    recebido: 'O coletor recebeu. Retomando…',
    feito: 'Sessão retomada.',
    recusado: 'O coletor recusou o pedido de retomada: ',
    falhou: 'A sessão não foi retomada: ',
  },
  abrir: {
    pendente: 'Pedido de nova sessão enviado…',
    recebido: 'O coletor recebeu. Abrindo a sessão…',
    feito: 'Sessão aberta. Ela aparece na lista em instantes.',
    recusado: 'O coletor recusou o pedido de nova sessão: ',
    falhou: 'A sessão não foi aberta: ',
  },
};

// Texto da recusa escolhido só pelo `motivo`, nunca procurando palavras no `erro`.
const MOTIVOS = {
  assinatura: 'a chave deste aparelho não foi aceita pelo computador.',
  aparelho: 'este aparelho não está autorizado no computador (ou a autorização foi revogada).',
  relogio: 'o relógio deste aparelho está errado. Acerte a data e a hora (de preferência no automático) e tente de novo.',
  expirado: 'o pedido demorou mais de 2 minutos para chegar e não foi executado. Tente de novo.',
  repetido: 'este pedido já tinha sido recebido.',
  ritmo: 'pedidos demais em pouco tempo. Espere um minuto e tente de novo.',
  desligado: 'os comandos estão desligados neste computador.',
  sem_chave: 'o computador não tem nenhum aparelho autorizado.',
  formato: 'o pedido veio em formato inválido.',
  verbo: 'este tipo de pedido não é aceito.',
  interno: 'erro interno do coletor. Tente de novo; se repetir, veja o log no computador.',
};
const SEM_MOTIVO = 'motivo não informado.';

const MODELOS = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
const ESFORCOS = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const MODOS = {
  manual: { rotulo: 'Perguntar antes de agir', ajuda: 'A sessão pede a sua permissão antes de editar arquivos ou rodar comandos.' },
  acceptEdits: { rotulo: 'Aceitar edições', ajuda: 'Edita arquivos sem perguntar; comandos ainda pedem permissão.' },
  plan: { rotulo: 'Só planejar', ajuda: 'A sessão só propõe um plano, sem mudar nada.' },
};

/* ---------- Formatação ---------- */

const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtInt = new Intl.NumberFormat('pt-BR');
const fmtDec = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const $ = (id) => document.getElementById(id);

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  return e;
}

function botao(texto, classe = 'btn') {
  const b = el('button', classe, texto);
  b.type = 'button';
  return b;
}

let seqDom = 0;
const idDom = (prefixo) => prefixo + '-' + (++seqDom);

const moeda = (v) => fmtMoeda.format(Number.isFinite(v) ? v : 0);
const dataValida = (ms) => Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
const hora = (ms) => (dataValida(ms) ? fmtHora.format(new Date(ms)) : '—');
const dataHora = (ms) => (dataValida(ms) ? fmtDataHora.format(new Date(ms)).replace(',', '') : '—');
const hojeSP = () => fmtDia.format(new Date());
// "às 14:32" hoje; "12/11 14:32" em outro dia.
const quando = (ms) => (fmtDia.format(new Date(ms)) === hojeSP() ? 'às ' + hora(ms) : dataHora(ms));

function tempoRel(ms) {
  const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (min < 1) return 'agora há pouco';
  if (min < 60) return 'há ' + min + ' min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'há ' + h + ' h';
  return 'há ' + Math.floor(h / 24) + ' d';
}

function duracao(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'menos de 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' min';
  return h + ' h ' + String(m).padStart(2, '0') + ' min';
}

function tokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return fmtDec.format(n / 1e6) + ' mi';
  if (n >= 1e3) return fmtInt.format(Math.round(n / 1e3)) + ' mil';
  return fmtInt.format(n);
}

const NOMES_MODELO = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-2': 'Fable 5.2',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
};

function modeloLegivel(m) {
  if (!m) return '—';
  if (NOMES_MODELO[m]) return NOMES_MODELO[m];
  let s = String(m).replace(/^claude-/, '');
  const i = s.search(/\d-\d(?!.*\d-\d)/);
  if (i >= 0) s = s.slice(0, i + 1) + '.' + s.slice(i + 2);
  s = s.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const rotuloDe = (mapa, v) => mapa[v] || String(v).charAt(0).toUpperCase() + String(v).slice(1);

function nomePadrao(s) {
  const base = s.tarefa ? String(s.tarefa).slice(0, 60) : (s.nome || '');
  return hojeSP() + ' ' + (s.projeto || '') + ' – ' + base;
}

// Selo pelo `estado` novo; sem ele (coletor antigo), pelo `status` de antes.
const ESTADOS = {
  trabalhando: { rotulo: 'Trabalhando', classe: 'ativa' },
  esperando_mensagem: { rotulo: 'Esperando você', classe: 'aguardando' },
  esperando_permissao: { rotulo: 'Pedindo permissão', classe: 'permissao' },
  parada: { rotulo: 'Parada', classe: 'ociosa' },
  encerrada: { rotulo: 'Encerrada', classe: 'encerrada' },
};
const STATUS = {
  ativa: { rotulo: 'Ativa', classe: 'ativa' },
  aguardando: { rotulo: 'Aguardando você', classe: 'aguardando' },
  ociosa: { rotulo: 'Ociosa', classe: 'ociosa' },
  encerrada: { rotulo: 'Encerrada', classe: 'encerrada' },
};

function seloDe(s) {
  if (s.estado != null) return ESTADOS[s.estado] || { rotulo: String(s.estado), classe: 'ociosa' };
  return STATUS[s.status] || { rotulo: s.status || '—', classe: 'ociosa' };
}

const estaEncerrada = (s) => (s.estado != null ? s.estado === 'encerrada' : s.status === 'encerrada');
const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/* ---------- Rede ---------- */

class NaoAutorizado extends Error {}

async function api(caminho, opcoes) {
  const r = await fetch(caminho, Object.assign({ credentials: 'same-origin' }, opcoes));
  if (r.status === 401) {
    location.href = '/login.html';
    throw new NaoAutorizado();
  }
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, ok: r.ok, dados };
}

function jsonOpcoes(metodo, corpo) {
  return {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  };
}

/* ---------- Estado ---------- */

const estado = {
  dados: null, // última resposta de /api/estado
  filtro: 'abertas',
  aba: 'sessoes',
  cartoes: new Map(), // chave -> objeto do cartão
  pendentesLocais: new Map(), // id -> comando aceito pelo servidor que ainda não voltou em /api/estado
  textosEnviados: new Map(), // id -> texto da mensagem, para devolver à caixa se o comando não chegar
  aparelho: null, // { kid, impressao } do aparelho guardado neste navegador (só o que é público)
};

const criptoDisponivel = () => !!(window.isSecureContext && globalThis.crypto && globalThis.crypto.subtle);
const orquestracao = () => (estado.dados && estado.dados.retrato && estado.dados.retrato.orquestracao) || null;

function coletorParado() {
  const d = estado.dados;
  return !d || !d.retrato || !d.recebidoEm || Date.now() - d.recebidoEm > COLETOR_PARADO_MS;
}

// Por que nenhum comando pode sair agora (null = pode). Ordem: coletor fora do ar, orquestração desligada.
function motivoBloqueio() {
  const d = estado.dados;
  if (!d || !d.retrato) return TEXTOS.desligadoSemDados;
  if (coletorParado()) return TEXTOS.desligadoForaDoAr(hora(d.recebidoEm));
  const o = orquestracao();
  if (o && o.ativa !== true && o.motivo === 'sem_chave') return TEXTOS.desligadoSemAparelho;
  if (!o || o.ativa !== true) return TEXTOS.desligadoOrquestracao;
  if (!criptoDisponivel()) return TEXTOS.desligadoCripto;
  return null;
}

/* ---------- Comandos ---------- */

// Lista do servidor mais os enviados por este aparelho que ainda não apareceram nela.
function todosComandos() {
  const doServidor = (estado.dados && estado.dados.comandos) || [];
  const ids = new Set(doServidor.map((c) => c.id));
  for (const [id, local] of estado.pendentesLocais) {
    if (ids.has(id) || Date.now() - local.criadoEm > LIMITE_ANDAMENTO_MS.recebido) estado.pendentesLocais.delete(id);
  }
  return [...doServidor, ...estado.pendentesLocais.values()];
}

function maisNovo(cmds) {
  let achado = null;
  for (const c of cmds) if (!achado || c.criadoEm > achado.criadoEm) achado = c;
  return achado;
}

const comandosDe = (chave) => todosComandos().filter((c) => c.chave === chave);
const comandoDe = (chave) => maisNovo(comandosDe(chave));
const comandoAbrir = () => maisNovo(todosComandos().filter((c) => c.tipo === 'abrir'));

function emAndamento(c) {
  const limite = c && LIMITE_ANDAMENTO_MS[c.estado];
  return !!limite && Date.now() - c.criadoEm < limite;
}

const verboEmAndamento = (chave, tipo) => comandosDe(chave).some((c) => c.tipo === tipo && emAndamento(c));
const haComandoEmAndamento = () => todosComandos().some(emAndamento);

function textoHttp(status) {
  if (status === 400) return TEXTOS.erro400;
  if (status === 409) return TEXTOS.erro409;
  if (status === 413) return TEXTOS.erro413;
  if (status === 429) return TEXTOS.erro429;
  return TEXTOS.erroOutro;
}

// Única saída de comandos do painel. `sessao` é a sessão como o cartão a mostrava no toque (null em abrir);
// dela sai o `visto`. Em aprovar, `exibido` traz a ferramenta e a entrada como estão na tela, e delas sai o
// `vistoHash`. Devolve { ok: true, id } ou { ok: false, erro } com o texto para mostrar perto do controle.
async function enviarComando(tipo, sessao, dados = {}, { exibido = null } = {}) {
  const bloqueio = motivoBloqueio();
  if (bloqueio) return { ok: false, erro: bloqueio };
  const aparelho = await chaveDoAparelho();
  if (!aparelho) return { ok: false, erro: TEXTOS.semAutorizacao };

  const corpo = { ...dados };
  let cmd;
  try {
    if (tipo === 'permissao' && dados.decisao === 'aprovar') {
      if (!exibido) return { ok: false, erro: TEXTOS.erro400 };
      corpo.vistoHash = await hashVisto(exibido.ferramenta, exibido.entrada);
    }
    if (sessao) corpo.visto = { projeto: sessao.projeto, nome: sessao.nome ?? null };
    cmd = await assinarComando(aparelho, { tipo, chave: sessao ? sessao.chave : null, dados: corpo });
  } catch {
    return { ok: false, erro: TEXTOS.erroAssinar };
  }
  if (cmd.dados.length > MAX_DADOS) return { ok: false, erro: TEXTOS.erro413 };

  let r;
  try {
    r = await api('/api/comando', jsonOpcoes('POST', cmd));
  } catch (e) {
    if (e instanceof NaoAutorizado) return { ok: false, erro: null };
    return { ok: false, erro: TEXTOS.erroRede };
  }
  if (!r.ok || !r.dados || r.dados.id !== cmd.id) return { ok: false, erro: textoHttp(r.status) };

  estado.pendentesLocais.set(cmd.id, {
    id: cmd.id, tipo, chave: cmd.chave, estado: 'pendente', erro: null, motivo: null, criadoEm: cmd.criadoEm,
  });
  carregarEstado();
  return { ok: true, id: cmd.id };
}

// Texto, passos e pistas de um comando para a linha de andamento.
function descreverComando(c) {
  const f = FRASES[c.tipo] || FRASES.mensagem;
  switch (c.estado) {
    case 'pendente': {
      let texto = f.pendente;
      if (coletorParado() && Date.now() - c.criadoEm > AVISO_PARADO_MS) texto += TEXTOS.foraDoArPedido;
      return { passos: ['feito', 'atual', 'futuro'], texto, falha: false };
    }
    case 'recebido': return { passos: ['feito', 'feito', 'atual'], texto: f.recebido, falha: false };
    case 'feito': return { passos: ['feito', 'feito', 'feito'], texto: f.feito, falha: false };
    case 'recusado': {
      const razao = MOTIVOS[c.motivo] || (c.erro ? String(c.erro) : SEM_MOTIVO);
      return {
        passos: ['feito', 'Recusado', null],
        texto: f.recusado + razao,
        falha: true,
        pedirAutorizacao: c.motivo === 'assinatura' || c.motivo === 'aparelho',
      };
    }
    case 'falhou':
      return { passos: ['feito', 'feito', 'Falhou'], texto: f.falhou + (c.erro ? String(c.erro) : SEM_MOTIVO), falha: true };
    case 'expirado':
      return { passos: ['feito', 'Expirado', null], texto: TEXTOS.expirado, falha: true };
    default:
      return null;
  }
}

/* ---------- Linha de andamento ---------- */

const ROTULOS_PASSOS = ['Enviado', 'Recebido', 'Executado'];

function criarAndamento() {
  const raiz = el('div', 'andamento');
  const passos = el('ol', 'passos');
  passos.setAttribute('aria-hidden', 'true');
  passos.hidden = true;
  const itens = ROTULOS_PASSOS.map(() => passos.appendChild(el('li', 'passo')));
  // A frase é o que o leitor de tela ouve: só muda quando o comando muda de estado.
  const frase = el('p', 'acao-estado');
  frase.setAttribute('role', 'status');
  frase.setAttribute('aria-live', 'polite');
  const alerta = el('p', 'acao-estado erro');
  alerta.setAttribute('role', 'alert');
  const nota = el('p', 'meta');
  nota.hidden = true;
  const autorizar = botao('Autorizar este aparelho', 'btn btn-leve');
  autorizar.hidden = true;
  autorizar.addEventListener('click', () => abrirDialogoAparelho());
  raiz.append(passos, frase, alerta, nota, autorizar);
  return { raiz, passos, itens, frase, alerta, nota, autorizar, marca: null };
}

function atualizarAndamento(a, cmd, nota = null) {
  const visivel = !!cmd && (emAndamento(cmd) || Date.now() - cmd.criadoEm < VISIVEL_MS);
  const d = visivel ? descreverComando(cmd) : null;
  a.passos.hidden = !d;
  a.nota.hidden = !d || !nota;
  if (d && nota) a.nota.textContent = nota;
  a.autorizar.hidden = !d || !d.pedirAutorizacao;

  const marca = d ? cmd.id + '|' + d.texto : null;
  if (marca === a.marca) return;
  a.marca = marca;
  a.frase.textContent = d && !d.falha ? d.texto : '';
  a.alerta.textContent = d && d.falha ? d.texto : '';
  if (!d) return;
  d.passos.forEach((p, i) => {
    const li = a.itens[i];
    li.hidden = p === null;
    if (p === null) return;
    const rotulo = ROTULOS_PASSOS[i];
    if (p === 'feito') { li.className = 'passo passo-feito'; li.textContent = '✓ ' + rotulo; }
    else if (p === 'atual') { li.className = 'passo passo-atual'; li.textContent = rotulo; }
    else if (p === 'futuro') { li.className = 'passo'; li.textContent = rotulo; }
    else { li.className = 'passo passo-falha'; li.textContent = '✕ ' + p; }
  });
}

/* ---------- Resumo, banner e título ---------- */

function renderResumo() {
  const d = estado.dados;
  if (!d) return;
  $('resumo').hidden = false;
  const r = d.retrato;
  $('resumo-total').textContent = r ? moeda(r.totalDia) : '—';

  const top = $('resumo-top');
  const sessoes = (r && r.sessoes) || [];
  let maior = null;
  for (const s of sessoes) {
    if ((s.custoHoje || 0) > 0 && (!maior || s.custoHoje > maior.custoHoje)) maior = s;
  }
  if (maior) {
    top.textContent = 'Mais gasta hoje: ' + maior.projeto + ' · ' + moeda(maior.custoHoje);
    top.hidden = false;
  } else {
    top.hidden = true;
  }

  const pedindo = sessoes.filter((s) => s.estado === 'esperando_permissao').length;
  const perm = $('resumo-permissao');
  perm.hidden = !pedindo;
  if (pedindo) perm.textContent = pedindo + ' esperando permissão';
  document.title = pedindo ? '(' + pedindo + ') ' + TITULO : TITULO;

  const ideias = $('resumo-ideias');
  if (r && r.custoIdeiasHoje > 0) {
    ideias.textContent = 'ideias: ' + moeda(r.custoIdeiasHoje);
    ideias.hidden = false;
  } else {
    ideias.hidden = true;
  }

  const col = $('coletor');
  const parado = coletorParado();
  col.classList.toggle('alerta', parado);
  if (!r) {
    col.textContent = 'Coletor ainda não enviou dados';
  } else if (parado) {
    col.textContent = 'Coletor sem enviar desde ' + hora(d.recebidoEm);
  } else {
    col.textContent = 'coletor ok · atualizado ' + hora(d.recebidoEm);
  }

  const banner = $('banner-coletor');
  banner.hidden = !parado;
  if (parado) banner.textContent = r ? TEXTOS.bannerForaDoAr(hora(d.recebidoEm)) : TEXTOS.bannerSemDados;
}

/* ---------- Cartões ---------- */

function criarCartao(s) {
  const c = { chave: s.chave, expandido: false, sessao: s, confirmando: null };

  const li = el('li');
  const art = el('article', 'cartao');
  li.appendChild(art);

  const cab = el('button', 'cartao-cab');
  cab.type = 'button';
  cab.setAttribute('aria-expanded', 'false');

  const l1 = el('span', 'l1');
  const projeto = el('span', 'projeto');
  const custo = el('span', 'custo');
  l1.append(projeto, custo);
  const tarefa = el('span', 'tarefa');
  const l3 = el('span', 'l3');
  const selo = el('span', 'selo');
  const modelo = el('span', 'modelo');
  l3.append(selo, modelo);
  const atividade = el('span', 'atividade');
  const meta = el('span', 'meta');
  const hoje = el('span', 'meta num');
  cab.append(l1, tarefa, l3, atividade, meta, hoje);

  const detalhe = el('div', 'detalhe');
  detalhe.hidden = true;
  detalhe.id = idDom('det');
  cab.setAttribute('aria-controls', detalhe.id);
  const info = el('div');

  Object.assign(c, { li, art, cab, projeto, custo, tarefa, selo, modelo, atividade, meta, hoje, detalhe, info });
  detalhe.append(criarOrquestracao(c), info);
  art.append(cab, detalhe);

  cab.addEventListener('click', () => {
    c.expandido = !c.expandido;
    atualizarCartao(c);
  });
  return c;
}

// Bloco novo do detalhe: permissões, última resposta, mensagem, andamento e ações. Criado uma vez por cartão
// e atualizado no lugar, para o rascunho e o foco sobreviverem às consultas.
function criarOrquestracao(c) {
  const raiz = el('div', 'orq');
  c.avisoEstado = el('p', 'meta aviso-estado');
  c.avisoEstado.hidden = true;
  c.permissoesBox = el('div', 'permissoes');
  c.blocos = new Map();
  c.resp = criarResposta();
  c.msg = criarMensagem(c);
  c.and = criarAndamento();
  c.acoes = criarAcoes(c);
  c.erroSessao = el('div', 'erro-sessao');
  c.erroSessao.setAttribute('role', 'alert');
  c.erroSessao.hidden = true;
  c.erroSessaoTexto = el('span', 'erro-sessao-texto');
  c.erroSessao.append(el('strong', null, 'A sessão parou com erro.'), c.erroSessaoTexto);
  raiz.append(c.avisoEstado, c.permissoesBox, c.resp.raiz, c.msg.raiz, c.and.raiz, c.erroSessao, c.acoes.raiz);
  return raiz;
}

/* ----- Última resposta ----- */

function criarResposta() {
  const raiz = el('section', 'resposta-bloco');
  const titulo = el('h3', 'titulo-linha');
  titulo.id = idDom('resp');
  titulo.tabIndex = -1;
  const tempo = el('time', 'tempo');
  titulo.append(el('span', null, 'Última resposta'), tempo);
  raiz.setAttribute('aria-labelledby', titulo.id);
  const texto = el('p', 'resposta recolhida');
  texto.id = idDom('resp-texto');
  const mais = botao('Mostrar tudo', 'btn btn-leve');
  mais.setAttribute('aria-expanded', 'false');
  mais.setAttribute('aria-controls', texto.id);
  mais.hidden = true;
  const notaOculto = el('p', 'meta', TEXTOS.notaOcultoResposta);
  const notaCorte = el('p', 'meta', TEXTOS.notaCorte);
  raiz.append(titulo, texto, mais, notaOculto, notaCorte);
  const r = { raiz, titulo, tempo, texto, mais, notaOculto, notaCorte, aberta: false, atual: null };
  mais.addEventListener('click', () => {
    r.aberta = !r.aberta;
    texto.classList.toggle('recolhida', !r.aberta);
    mais.textContent = r.aberta ? 'Mostrar menos' : 'Mostrar tudo';
    mais.setAttribute('aria-expanded', String(r.aberta));
  });
  return r;
}

function atualizarResposta(c) {
  const s = c.sessao;
  const r = c.resp;
  // Coletor antigo não manda o campo: o bloco não aparece.
  r.raiz.hidden = s.ultimaResposta === undefined;
  if (r.raiz.hidden) return;
  const texto = typeof s.ultimaResposta === 'string' ? s.ultimaResposta : '';
  if (texto !== r.atual) {
    r.atual = texto;
    r.texto.textContent = texto || TEXTOS.semResposta;
    r.texto.classList.toggle('vazia', !texto);
    r.aberta = false;
    r.texto.classList.add('recolhida');
    r.mais.textContent = 'Mostrar tudo';
    r.mais.setAttribute('aria-expanded', 'false');
    r.notaOculto.hidden = !texto.includes('[oculto]');
    r.notaCorte.hidden = texto.length < 1200;
  }
  const ms = s.ultimaRespostaEm;
  r.tempo.hidden = !texto || !dataValida(ms);
  if (!r.tempo.hidden) {
    r.tempo.textContent = quando(ms);
    r.tempo.dateTime = new Date(ms).toISOString();
  }
  // Só dá para medir com o detalhe visível; "Mostrar tudo" só aparece se o texto passa de 6 linhas.
  if (c.expandido && texto && !r.aberta) r.mais.hidden = !(r.texto.scrollHeight > r.texto.clientHeight + 1);
  else if (!texto) r.mais.hidden = true;
}

/* ----- Caixa de mensagem ----- */

function criarMensagem(c) {
  const raiz = el('div', 'mensagem');
  const form = el('form', 'mensagem-form');
  const idCampo = idDom('msg');
  const rotulo = el('label', null, 'Mensagem para a sessão');
  rotulo.htmlFor = idCampo;
  const campo = el('textarea', 'campo campo-area');
  campo.id = idCampo;
  campo.rows = 3;
  campo.maxLength = MAX_TEXTO;
  const contador = el('p', 'meta num contador');
  contador.setAttribute('aria-live', 'off');
  contador.hidden = true;
  const dica = el('p', 'meta so-ponteiro', 'Ctrl+Enter envia');
  const enviar = el('button', 'btn btn-primario', 'Enviar mensagem');
  enviar.type = 'submit';
  const botoes = el('div', 'botoes');
  botoes.append(enviar);
  const motivo = el('p', 'acao-estado motivo');
  motivo.id = idDom('msg-motivo');
  const erro = el('p', 'acao-estado erro');
  erro.setAttribute('role', 'alert');
  form.append(rotulo, campo, contador, dica, botoes, motivo, erro);
  const explicacao = el('p', 'meta');
  const explicacao2 = el('p', 'meta');
  raiz.append(form, explicacao, explicacao2);

  const m = { raiz, form, campo, contador, enviar, motivo, erro, explicacao, explicacao2, enviando: false, erroTexto: null };
  campo.addEventListener('input', () => {
    m.erroTexto = null;
    atualizarMensagem(c);
  });
  campo.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    enviarMensagem(c);
  });
  return m;
}

function motivoMensagem(s) {
  return motivoBloqueio()
    || (verboEmAndamento(s.chave, 'mensagem') ? TEXTOS.msgAnterior : null)
    || (s.estado === 'trabalhando' ? TEXTOS.msgTrabalhando : null)
    || (s.estado === 'esperando_permissao' ? TEXTOS.msgPermissao : null);
}

function atualizarMensagem(c) {
  const s = c.sessao;
  const m = c.msg;
  const enc = estaEncerrada(s);
  const comandada = s.gerenciada === true;
  m.form.hidden = enc || !comandada;

  let explicacao = null;
  let explicacao2 = null;
  if (enc) {
    explicacao = s.retomavel === true ? TEXTOS.encerradaRetomavel
      : s.retomavel === false ? TEXTOS.encerradaNaoRetomavel : TEXTOS.encerrada;
  } else if (!comandada) {
    explicacao = TEXTOS.naoComandada;
    if (s.estado === 'esperando_permissao') explicacao2 = TEXTOS.naoComandadaPermissao;
  }
  m.explicacao.hidden = !explicacao;
  m.explicacao.textContent = explicacao || '';
  m.explicacao2.hidden = !explicacao2;
  m.explicacao2.textContent = explicacao2 || '';
  if (m.form.hidden) return;

  const motivo = motivoMensagem(s);
  // "Comandos desligados" aparece uma vez por cartão, nas ações; aqui o botão só aponta para ele (D1).
  const desligado = !!motivoBloqueio();
  const valor = m.campo.value;
  m.enviar.disabled = m.enviando || !!motivo || !valor.trim();
  m.enviar.textContent = m.enviando ? 'Enviando…' : 'Enviar mensagem';
  m.campo.readOnly = m.enviando;
  const proprio = desligado ? '' : motivo || '';
  if (m.motivo.textContent !== proprio) m.motivo.textContent = proprio;
  if (desligado) m.enviar.setAttribute('aria-describedby', c.acoes.motivo.id);
  else if (motivo) m.enviar.setAttribute('aria-describedby', m.motivo.id);
  else m.enviar.removeAttribute('aria-describedby');
  if (m.erro.textContent !== (m.erroTexto || '')) m.erro.textContent = m.erroTexto || '';
  m.contador.hidden = valor.length < CONTADOR_DESDE;
  if (!m.contador.hidden) m.contador.textContent = fmtInt.format(valor.length) + ' de ' + fmtInt.format(MAX_TEXTO);
}

async function enviarMensagem(c) {
  const m = c.msg;
  const texto = m.campo.value;
  if (m.enviando || !texto.trim() || motivoMensagem(c.sessao)) return;
  if (texto.length > MAX_TEXTO) {
    m.erroTexto = TEXTOS.msgLonga;
    atualizarMensagem(c);
    return;
  }
  m.enviando = true;
  m.erroTexto = null;
  atualizarMensagem(c);
  const r = await enviarComando('mensagem', c.sessao, { texto });
  m.enviando = false;
  if (r.ok) {
    estado.textosEnviados.set(r.id, texto);
    m.campo.value = ''; // o rascunho só some quando o servidor aceitou
  } else {
    m.erroTexto = r.erro;
  }
  atualizarCartao(c);
  if (r.ok) m.campo.focus();
}

// Mensagem recusada, que falhou ou expirou volta para a caixa, se ela estiver vazia. Devolve a nota a mostrar.
function devolverMensagens(c) {
  let nota = null;
  for (const cmd of comandosDe(c.chave)) {
    if (cmd.tipo !== 'mensagem' || !estado.textosEnviados.has(cmd.id)) continue;
    if (cmd.estado === 'feito') {
      estado.textosEnviados.delete(cmd.id);
    } else if (['recusado', 'falhou', 'expirado'].includes(cmd.estado)) {
      const texto = estado.textosEnviados.get(cmd.id);
      estado.textosEnviados.delete(cmd.id);
      if (!c.msg.form.hidden && !c.msg.campo.value) {
        c.msg.campo.value = texto;
        c.msg.devolvida = cmd.id;
      }
    }
  }
  const ultimo = comandoDe(c.chave);
  if (ultimo && c.msg.devolvida === ultimo.id) nota = TEXTOS.msgDevolvida;
  return nota;
}

/* ----- Pedidos de permissão ----- */

function criarBlocoPermissao(c, p) {
  const ferramenta = String(p.ferramenta ?? '');
  const entrada = String(p.entrada ?? '');
  const completo = p.completo === true;
  const raiz = el('section', 'permissao');
  raiz.setAttribute('role', 'group');
  const titulo = el('h3', 'permissao-titulo');
  titulo.id = idDom('perm');
  raiz.setAttribute('aria-labelledby', titulo.id);

  const quer = el('p');
  quer.append('A sessão quer usar a ferramenta ', el('strong', null, ferramenta), '.');
  raiz.append(titulo, quer);
  if (p.sensivel === true) {
    const aviso = el('p', 'permissao-aviso');
    aviso.append(el('strong', null, 'Atenção.'), TEXTOS.permSensivel);
    raiz.append(aviso);
  }
  raiz.append(el('p', 'permissao-rotulo', 'O que ela quer fazer'));
  raiz.append(el('p', 'meta', TEXTOS.permLinhas(entrada ? entrada.split('\n').length : 0)));
  // Exatamente o texto que será assinado (vistoHash): inteiro, sem corte, sem rolagem própria, quebras preservadas.
  const pre = el('pre', 'entrada');
  pre.setAttribute('role', 'group');
  pre.setAttribute('aria-label', 'Entrada do pedido');
  pre.textContent = entrada;
  raiz.append(pre);
  if (entrada.includes('[oculto]')) raiz.append(el('p', 'meta', TEXTOS.permOculto));
  if (!completo) raiz.append(el('p', 'permissao-aviso', TEXTOS.permIncompleto));

  const faixa = el('p', 'permissao-aviso');
  faixa.id = idDom('perm-faixa');
  faixa.hidden = true;
  const botoes = el('div', 'botoes botoes-permissao');
  const negar = botao('Negar', 'btn');
  botoes.append(negar);
  // Pedido que não veio inteiro, ou que é sensível, não oferece Aprovar: nem desabilitado, para não induzir
  // a insistir (o coletor também recusa a aprovação nesses casos).
  const sensivel = p.sensivel === true;
  const aprovar = completo ? botao('Aprovar', 'btn btn-primario') : null;
  if (aprovar && !sensivel) botoes.append(aprovar);
  const respondido = el('p', 'acao-estado', TEXTOS.permRespondido);
  respondido.tabIndex = -1;
  respondido.hidden = true;
  const erro = el('p', 'acao-estado erro');
  erro.setAttribute('role', 'alert');
  const autorizar = botao('Autorizar este aparelho', 'btn btn-leve');
  autorizar.hidden = true;
  autorizar.addEventListener('click', () => abrirDialogoAparelho());
  raiz.append(faixa, botoes, respondido, erro, autorizar);

  const b = {
    raiz, titulo, pre, faixa, botoes, negar, aprovar: sensivel ? null : aprovar, respondido, erro, autorizar,
    pedido: p.pedido, ferramenta, completo, enviando: null, idCmd: null, erroTexto: null,
    assinatura: JSON.stringify([ferramenta, entrada, completo, p.sensivel === true]),
  };
  negar.addEventListener('click', () => responderPermissao(c, b, 'negar'));
  if (b.aprovar) b.aprovar.addEventListener('click', () => responderPermissao(c, b, 'aprovar'));
  return b;
}

function atualizarPermissoes(c) {
  const s = c.sessao;
  const pedidos = Array.isArray(s.permissoes) ? s.permissoes.filter((p) => p && p.pedido != null) : [];
  const vistos = new Set();
  let perdeuFoco = false;
  pedidos.forEach((p, i) => {
    const k = String(p.pedido);
    vistos.add(k);
    let b = c.blocos.get(k);
    const assinatura = JSON.stringify([String(p.ferramenta ?? ''), String(p.entrada ?? ''), p.completo === true, p.sensivel === true]);
    // O mesmo pedido com outra entrada: o bloco é recriado e o hash segue o que está na tela.
    if (b && b.assinatura !== assinatura) {
      perdeuFoco ||= b.raiz.contains(document.activeElement);
      b.raiz.remove();
      b = null;
    }
    if (!b) {
      b = criarBlocoPermissao(c, p);
      c.blocos.set(k, b);
    }
    b.titulo.textContent = 'Pedido de permissão' + (pedidos.length > 1 ? ' (' + (i + 1) + ' de ' + pedidos.length + ')' : '');
    if (c.permissoesBox.children[i] !== b.raiz) c.permissoesBox.insertBefore(b.raiz, c.permissoesBox.children[i] || null);
    atualizarBlocoPermissao(c, b);
  });
  for (const [k, b] of c.blocos) {
    if (vistos.has(k)) continue;
    perdeuFoco ||= b.raiz.contains(document.activeElement);
    b.raiz.remove();
    c.blocos.delete(k);
  }
  return perdeuFoco;
}

function atualizarBlocoPermissao(c, b) {
  const bloqueio = motivoBloqueio();
  const cmd = b.idCmd ? todosComandos().find((x) => x.id === b.idCmd) : null;
  let respondido = false;
  let erro = b.erroTexto;
  let pedirAutorizacao = false;
  if (cmd) {
    const d = descreverComando(cmd);
    if (d && d.falha) {
      erro = d.texto;
      pedirAutorizacao = !!d.pedirAutorizacao;
    } else {
      respondido = true;
    }
  }
  // "Comandos desligados" aparece uma vez por cartão, nas ações (D1). Aqui só fica a frase própria do pedido
  // quando o coletor parou; nos demais casos os botões apontam para o motivo das ações.
  const parado = !!bloqueio && coletorParado();
  b.faixa.hidden = !parado;
  if (parado) b.faixa.textContent = TEXTOS.permForaDoAr;
  const motivos = [parado ? b.faixa.id : null, c.acoes.motivo.id].filter(Boolean).join(' ');
  const controles = b.aprovar ? [b.negar, b.aprovar] : [b.negar];
  for (const x of controles) {
    if (bloqueio) x.setAttribute('aria-describedby', motivos);
    else x.removeAttribute('aria-describedby');
  }
  b.botoes.hidden = respondido;
  b.respondido.hidden = !respondido;
  b.negar.disabled = !!bloqueio || !!b.enviando;
  b.negar.textContent = b.enviando === 'negar' ? 'Negando…' : 'Negar';
  if (b.aprovar) {
    b.aprovar.disabled = !!bloqueio || !!b.enviando;
    b.aprovar.textContent = b.enviando === 'aprovar' ? 'Aprovando…' : 'Aprovar';
  }
  if (b.erro.textContent !== (erro || '')) b.erro.textContent = erro || '';
  b.autorizar.hidden = !pedirAutorizacao;
}

async function responderPermissao(c, b, decisao) {
  if (b.enviando) return;
  if (decisao === 'aprovar' && !b.completo) return;
  if (decisao === 'aprovar' && !b.aprovar) return; // pedido sensível: só negar
  const clicado = decisao === 'aprovar' ? b.aprovar : b.negar;
  b.enviando = decisao;
  b.erroTexto = null;
  b.idCmd = null;
  atualizarBlocoPermissao(c, b);
  // A impressão digital sai do que está na tela agora: a ferramenta exibida e o texto do <pre>.
  const exibido = decisao === 'aprovar' ? { ferramenta: b.ferramenta, entrada: b.pre.textContent } : null;
  const r = await enviarComando('permissao', c.sessao, { pedido: b.pedido, decisao }, { exibido });
  b.enviando = null;
  if (r.ok) b.idCmd = r.id;
  else b.erroTexto = r.erro;
  atualizarCartao(c);
  if (!b.raiz.isConnected) return;
  // Os botões somem ou voltam: o foco não pode ficar perdido no corpo da página.
  if (r.ok) b.respondido.focus();
  else clicado.focus();
}

/* ----- Ações ----- */

function criarAcoes(c) {
  const raiz = el('div', 'acao');
  const botoes = el('div', 'botoes');
  const interromper = botao('Interromper');
  const encerrar = botao('Encerrar', 'btn btn-perigo');
  const retomar = botao('Retomar');
  botoes.append(interromper, encerrar, retomar);
  const motivo = el('p', 'acao-estado motivo');
  motivo.id = idDom('acoes-motivo');
  const confirmacao = el('div');
  raiz.append(botoes, motivo, confirmacao);
  interromper.addEventListener('click', () => abrirConfirmacao(c, 'interromper'));
  encerrar.addEventListener('click', () => abrirConfirmacao(c, 'encerrar'));
  retomar.addEventListener('click', () => abrirConfirmacao(c, 'retomar'));
  return { raiz, botoes, motivo, confirmacao, porVerbo: { interromper, encerrar, retomar } };
}

// Matriz da spec (item 5): o que aparece para cada estado e tipo de sessão.
function acoesVisiveis(s) {
  const enc = estaEncerrada(s);
  const comandada = s.gerenciada === true;
  return {
    interromper: comandada && !enc && (s.estado === 'trabalhando' || s.estado === 'esperando_permissao'),
    encerrar: !enc,
    retomar: enc && s.retomavel === true && !verboEmAndamento(s.chave, 'retomar'),
  };
}

function atualizarAcoes(c) {
  const s = c.sessao;
  const a = c.acoes;
  const vis = acoesVisiveis(s);
  if (c.confirmando && !vis[c.confirmando.tipo] && !c.confirmando.enviando) fecharConfirmacao(c, false);

  const bloqueio = motivoBloqueio();
  const aguardando = [];
  for (const [tipo, b] of Object.entries(a.porVerbo)) {
    b.hidden = !vis[tipo];
    const ocupado = (tipo === 'interromper' || tipo === 'encerrar') && verboEmAndamento(s.chave, tipo);
    if (vis[tipo] && ocupado) aguardando.push(tipo);
    b.disabled = !!bloqueio || ocupado;
  }
  const algum = Object.values(vis).some(Boolean);
  a.botoes.hidden = !algum || !!c.confirmando;
  const motivo = algum ? bloqueio || aguardando.map(TEXTOS.aguardeVerbo).join(' ') : '';
  if (a.motivo.textContent !== motivo) a.motivo.textContent = motivo;
  for (const b of Object.values(a.porVerbo)) {
    if (motivo) b.setAttribute('aria-describedby', a.motivo.id);
    else b.removeAttribute('aria-describedby');
  }
  a.raiz.hidden = !algum && !c.confirmando;
}

function selectCom(id, rotulo, opcoes, padrao) {
  const caixa = el('div', 'campo-grupo');
  const l = el('label', null, rotulo);
  l.htmlFor = id;
  const sel = el('select', 'campo');
  sel.id = id;
  for (const [valor, texto] of opcoes) sel.add(new Option(texto, valor));
  sel.value = padrao;
  caixa.append(l, sel);
  return { caixa, sel };
}

function abrirConfirmacao(c, tipo) {
  if (c.confirmando) return;
  const s = c.sessao;
  const o = orquestracao() || {};
  const raiz = el(tipo === 'interromper' ? 'div' : 'form', 'confirmar');
  const erro = el('p', 'acao-estado erro');
  erro.setAttribute('role', 'alert');
  const botoes = el('div', 'botoes');
  const cancelar = botao('Cancelar');
  let ok;
  let foco;
  let dadosDe;

  if (tipo === 'interromper') {
    raiz.append(el('p', null, TEXTOS.confInterromper));
    ok = botao('Interromper', 'btn btn-perigo');
    botoes.append(ok, cancelar);
    foco = cancelar;
    dadosDe = () => ({});
    ok.addEventListener('click', () => enviar());
  } else if (tipo === 'encerrar') {
    raiz.append(el('p', 'confirmar-titulo', TEXTOS.confEncerrarTitulo));
    raiz.append(el('p', null, s.gerenciada === true ? TEXTOS.confEncerrarComandada : TEXTOS.confEncerrarManual));
    const idCampo = idDom('nome');
    const rotulo = el('label', null, 'Nome do trabalho');
    rotulo.htmlFor = idCampo;
    const campo = el('input', 'campo');
    campo.id = idCampo;
    campo.type = 'text';
    campo.maxLength = 140;
    campo.value = nomePadrao(s);
    raiz.append(rotulo, campo);
    ok = el('button', 'btn btn-primario', 'Encerrar e salvar log');
    ok.type = 'submit';
    botoes.append(ok, cancelar);
    foco = campo;
    dadosDe = () => {
      const nome = campo.value.trim();
      if (!nome) {
        erro.textContent = TEXTOS.erroNomeTrabalho;
        campo.focus();
        return null;
      }
      return { nome };
    };
    campo.addEventListener('input', () => {
      if (erro.textContent === TEXTOS.erroNomeTrabalho) erro.textContent = '';
    });
  } else {
    raiz.append(el('p', 'confirmar-titulo', TEXTOS.confRetomar));
    const modos = lista(o.modos).filter((m) => MODOS[m]);
    const modo = selectCom(idDom('ret-modo'), 'Modo de permissão',
      (modos.length ? modos : Object.keys(MODOS)).map((m) => [m, MODOS[m].rotulo + (m === 'manual' ? ' (manual)' : '')]), 'manual');
    const modelo = selectCom(idDom('ret-modelo'), 'Modelo',
      [['', 'Manter o da sessão'], ...lista(o.modelos).map((m) => [m, rotuloDe(MODELOS, m)])], '');
    const esforco = selectCom(idDom('ret-esforco'), 'Esforço',
      [['', 'Manter o da sessão'], ...(lista(o.esforcos).length ? lista(o.esforcos) : Object.keys(ESFORCOS)).map((e) => [e, rotuloDe(ESFORCOS, e)])], '');
    raiz.append(modo.caixa, modelo.caixa, esforco.caixa);
    ok = el('button', 'btn btn-primario', 'Retomar sessão');
    ok.type = 'submit';
    botoes.append(ok, cancelar);
    foco = modo.sel;
    dadosDe = () => {
      const d = { modoPermissao: modo.sel.value || 'manual' };
      if (modelo.sel.value) d.modelo = modelo.sel.value;
      if (esforco.sel.value) d.esforco = esforco.sel.value;
      return d;
    };
  }
  raiz.append(botoes, erro);
  const rotuloOk = ok.textContent;

  async function enviar() {
    if (c.confirmando.enviando) return;
    const dados = dadosDe();
    if (!dados) return;
    c.confirmando.enviando = true;
    ok.disabled = true;
    cancelar.disabled = true;
    ok.textContent = 'Enviando…';
    erro.textContent = '';
    const r = await enviarComando(tipo, c.sessao, dados);
    if (!c.confirmando || c.confirmando.raiz !== raiz) return;
    c.confirmando.enviando = false;
    if (r.ok) {
      fecharConfirmacao(c);
      atualizarCartao(c);
      return;
    }
    ok.disabled = false;
    cancelar.disabled = false;
    ok.textContent = rotuloOk;
    if (r.erro) erro.textContent = r.erro;
    ok.focus();
  }

  if (raiz.tagName === 'FORM') {
    raiz.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviar();
    });
  }
  cancelar.addEventListener('click', () => fecharConfirmacao(c));
  raiz.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && c.confirmando && !c.confirmando.enviando) {
      ev.stopPropagation();
      fecharConfirmacao(c);
    }
  });

  c.confirmando = { tipo, raiz, enviando: false };
  c.acoes.confirmacao.replaceChildren(raiz);
  atualizarAcoes(c);
  foco.focus();
  if (foco.select) foco.select();
}

function fecharConfirmacao(c, devolverFoco = true) {
  const tipo = c.confirmando && c.confirmando.tipo;
  c.acoes.confirmacao.replaceChildren();
  c.confirmando = null;
  atualizarAcoes(c);
  if (!devolverFoco) return;
  const b = c.acoes.porVerbo[tipo];
  if (b && !b.hidden && !b.disabled && !c.acoes.botoes.hidden) b.focus();
  else c.cab.focus();
}

/* ----- Detalhe existente ----- */

function linhaGrade(dl, k, v) {
  dl.append(el('dt', null, k), el('dd', null, v));
}

function secao(pai, titulo) {
  pai.appendChild(el('h3', null, titulo));
}

function montarDetalhe(c) {
  const s = c.sessao;
  const info = c.info;
  const nodes = [];

  if (s.resumo) {
    const d = el('div');
    secao(d, 'Resumo');
    d.appendChild(el('p', null, s.resumo));
    nodes.push(d);
  }

  const tempo = el('div');
  secao(tempo, 'Tempo');
  const g1 = el('dl', 'grade');
  linhaGrade(g1, 'Início', dataHora(s.iniciadaEm));
  const fim = estaEncerrada(s) ? s.ultimaAtividade : Date.now();
  linhaGrade(g1, 'Duração', dataValida(s.iniciadaEm) && dataValida(fim) ? duracao(fim - s.iniciadaEm) : '—');
  tempo.appendChild(g1);
  nodes.push(tempo);

  const tk = s.tokens || {};
  const t = el('div');
  secao(t, 'Tokens');
  const g2 = el('dl', 'grade');
  linhaGrade(g2, 'Entrada', tokens(tk.input));
  linhaGrade(g2, 'Saída', tokens(tk.output));
  linhaGrade(g2, 'Cache lido', tokens(tk.read));
  linhaGrade(g2, 'Cache escrito', tokens((tk.w5m || 0) + (tk.w1h || 0)));
  t.appendChild(g2);
  nodes.push(t);

  const pm = s.porModelo ? Object.entries(s.porModelo) : [];
  if (pm.length) {
    const m = el('div');
    secao(m, 'Custo por modelo');
    const g3 = el('dl', 'grade');
    for (const [nome, v] of pm) linhaGrade(g3, modeloLegivel(nome), moeda(v && v.custo));
    m.appendChild(g3);
    nodes.push(m);
  }

  const sg = s.sugestao;
  if (sg && sg.recomendacao) {
    const rec = sg.recomendacao;
    const m = el('div');
    secao(m, 'Modelo e esforço');
    if (rec.adequado) {
      m.appendChild(el('p', 'sugestao-ok', '✓ Combina com a tarefa'));
    } else {
      m.appendChild(el('p', 'sugestao-troca',
        'Sugestão: trocar para ' + modeloLegivel(rec.modelo) + ' · ' + (rec.esforco || '—')));
    }
    if (rec.motivo) m.appendChild(el('p', null, rec.motivo));
    nodes.push(m);
  }
  if (sg && Array.isArray(sg.ideias) && sg.ideias.length) {
    const p = el('div');
    secao(p, 'Próximos passos');
    const ul = el('ul');
    for (const i of sg.ideias) ul.appendChild(el('li', null, i));
    p.appendChild(ul);
    nodes.push(p);
  }

  info.replaceChildren(...nodes);
}

function atualizarCartao(c) {
  const s = c.sessao;
  c.projeto.textContent = s.projeto || '(sem projeto)';
  const conferido = s.custoConferido !== false;
  c.custo.textContent = (conferido ? '' : '≈ ') + moeda(s.custo);
  if (conferido) c.custo.removeAttribute('title');
  else c.custo.title = 'estimado a partir do transcript';

  c.tarefa.textContent = s.tarefa || 'Sem tarefa registrada';

  const selo = seloDe(s);
  c.selo.className = 'selo selo-' + selo.classe;
  c.selo.textContent = selo.rotulo;
  c.art.dataset.status = selo.classe;
  c.modelo.textContent = modeloLegivel(s.modelo) + (s.esforco ? ' · ' + s.esforco : '');

  c.atividade.textContent = s.ultimaAtividade
    ? 'última atividade ' + hora(s.ultimaAtividade) + ' (' + tempoRel(s.ultimaAtividade) + ')'
    : 'sem atividade registrada';
  c.meta.textContent = [s.nome, s.conta].filter(Boolean).join(' · ');
  c.meta.hidden = !c.meta.textContent;

  const dif = Math.abs((s.custoHoje || 0) - (s.custo || 0)) > 0.005;
  c.hoje.hidden = !dif;
  if (dif) c.hoje.textContent = 'hoje: ' + moeda(s.custoHoje);

  c.cab.setAttribute('aria-expanded', String(c.expandido));
  c.detalhe.hidden = !c.expandido;

  const parado = coletorParado() && estado.dados && estado.dados.retrato;
  c.avisoEstado.hidden = !parado;
  if (parado) c.avisoEstado.textContent = TEXTOS.estadoAntigo(hora(estado.dados.recebidoEm));
  const perdeuFoco = atualizarPermissoes(c);
  atualizarResposta(c);
  atualizarMensagem(c);
  const nota = devolverMensagens(c);
  atualizarMensagem(c);
  atualizarAndamento(c.and, comandoDe(c.chave), nota);
  const erroTxt = typeof s.erro === 'string' ? s.erro.trim() : '';
  if (c.erroSessaoTexto.textContent !== erroTxt) c.erroSessaoTexto.textContent = erroTxt;
  c.erroSessao.hidden = !erroTxt;
  atualizarAcoes(c);
  if (perdeuFoco) {
    // O pedido respondido sumiu com o foco dentro: vai para o título da última resposta ou para o cartão.
    if (c.expandido && !c.resp.raiz.hidden) c.resp.titulo.focus();
    else c.cab.focus();
  }
  if (c.expandido) montarDetalhe(c);
}

function renderLista() {
  const d = estado.dados;
  if (!d) return;
  $('carregando').hidden = true;

  const todas = (d.retrato && d.retrato.sessoes) || [];
  // Uma sessão encerrada pelo painel fica 5 min em "Abertas" para mostrar o resultado do pedido.
  const recemEncerrada = (s) => {
    const c = comandoDe(s.chave);
    return !!c && Date.now() - c.criadoEm < VISIVEL_MS;
  };
  const visiveis = estado.filtro === 'abertas' ? todas.filter((s) => !estaEncerrada(s) || recemEncerrada(s)) : todas;
  const ativo = document.activeElement;

  const vivos = new Set(visiveis.map((s) => s.chave));
  for (const [chave, c] of estado.cartoes) {
    if (!vivos.has(chave)) {
      c.li.remove();
      estado.cartoes.delete(chave);
    }
  }

  const ul = $('lista');
  visiveis.forEach((s, i) => {
    let c = estado.cartoes.get(s.chave);
    if (!c) {
      c = criarCartao(s);
      estado.cartoes.set(s.chave, c);
    }
    c.sessao = s;
    atualizarCartao(c);
    c.art.classList.toggle('destaque', i === 0);
    if (ul.children[i] !== c.li) ul.insertBefore(c.li, ul.children[i] || null);
  });

  if (ativo && ativo !== document.body && document.contains(ativo) && document.activeElement !== ativo) {
    ativo.focus();
  }

  const vazio = $('vazio');
  vazio.hidden = visiveis.length > 0;
  vazio.textContent = estado.filtro === 'abertas' ? 'Nenhuma sessão aberta agora' : 'Nenhuma sessão hoje';
}

/* ---------- Anúncios para leitor de tela ---------- */

let estadosAntes = null; // chave -> estado na consulta anterior (null antes da primeira carga)

function anunciarMudancas() {
  const sessoes = (estado.dados && estado.dados.retrato && estado.dados.retrato.sessoes) || [];
  const agora = new Map(sessoes.map((s) => [s.chave, s.estado]));
  if (estadosAntes) {
    const frases = [];
    for (const s of sessoes) {
      const antes = estadosAntes.get(s.chave);
      if (antes === undefined || antes === s.estado || !s.estado) continue;
      const nome = s.projeto || 'Sessão';
      if (s.estado === 'esperando_permissao') {
        const f = Array.isArray(s.permissoes) && s.permissoes[0] && s.permissoes[0].ferramenta;
        frases.push(nome + ': pedindo permissão para usar ' + (f || 'uma ferramenta') + '.');
      } else if (s.estado === 'esperando_mensagem') {
        frases.push(nome + (antes === 'trabalhando' ? ': terminou o trabalho.' : ': esperando você.'));
      } else if (s.estado === 'encerrada') {
        frases.push(nome + ': encerrada.');
      }
    }
    if (frases.length) $('anuncios').textContent = frases.join(' ');
  }
  estadosAntes = agora;
}

/* ---------- Nova sessão ---------- */

const nova = { enviando: false, dados: null }; // dados = o que o resumo mostrou e vai ser enviado
const andamentoAbrir = criarAndamento();
$('abrir-andamento').append(andamentoAbrir.raiz);

function motivoNovaSessao() {
  const d = estado.dados;
  if (!d || !d.retrato || coletorParado()) return { texto: motivoBloqueio() };
  const o = orquestracao();
  if (o && o.ativa !== true && o.motivo === 'sem_chave') return { texto: TEXTOS.novaSemAparelho };
  if (!o || o.ativa !== true) return { texto: TEXTOS.novaDesligada };
  if (!lista(o.projetos).length) return { texto: TEXTOS.novaProjetosVazio };
  if (Number.isFinite(o.maxSessoes) && Number.isFinite(o.abertas) && o.abertas >= o.maxSessoes) {
    return { texto: TEXTOS.novaLimite(o.maxSessoes) };
  }
  if (!criptoDisponivel()) return { texto: TEXTOS.desligadoCripto };
  return null;
}

function renderNovaSessao() {
  const m = motivoNovaSessao();
  const b = $('nova-sessao');
  b.disabled = !!m || nova.enviando;
  const p = $('nova-motivo');
  const texto = m ? m.texto : '';
  if (p.textContent !== texto) p.textContent = texto;
  atualizarAndamento(andamentoAbrir, comandoAbrir());
}

function preencherSelect(sel, opcoes) {
  const atual = sel.value;
  sel.replaceChildren(...opcoes.map(([valor, texto]) => new Option(texto, valor)));
  if (opcoes.some(([valor]) => valor === atual)) sel.value = atual;
}

function prepararFormNova() {
  const o = orquestracao() || {};
  preencherSelect($('nova-projeto'), [['', 'Escolha um projeto'], ...lista(o.projetos).map((p) => [p, p])]);
  const contas = lista(o.contas);
  $('nova-conta-grupo').hidden = contas.length <= 1;
  preencherSelect($('nova-conta'), contas.map((c) => [c, c]));
  if (contas.includes('principal') && !$('nova-conta').dataset.mexida) $('nova-conta').value = 'principal';
  const modelos = lista(o.modelos).length ? lista(o.modelos) : Object.keys(MODELOS);
  preencherSelect($('nova-modelo'), [['', 'Padrão da conta'], ...modelos.map((m) => [m, rotuloDe(MODELOS, m)])]);
  const esforcos = lista(o.esforcos).length ? lista(o.esforcos) : Object.keys(ESFORCOS);
  preencherSelect($('nova-esforco'), [['', 'Padrão'], ...esforcos.map((e) => [e, rotuloDe(ESFORCOS, e)])]);
  const modos = lista(o.modos);
  for (const linha of document.querySelectorAll('#nova-form .opcao[data-modo]')) {
    linha.hidden = modos.length > 0 && !modos.includes(linha.dataset.modo);
  }
}

const CAMPOS_NOVA = {
  projeto: { controle: 'nova-projeto', erro: 'nova-projeto-erro' },
  pedido: { controle: 'nova-pedido', erro: 'nova-pedido-erro' },
  nome: { controle: 'nova-nome', erro: 'nova-nome-erro' },
};

function validarCampoNova(nome) {
  const { controle, erro } = CAMPOS_NOVA[nome];
  const v = $(controle).value;
  let msg = '';
  if (nome === 'projeto' && !v) msg = TEXTOS.erroProjeto;
  if (nome === 'pedido') msg = !v.trim() ? TEXTOS.erroPedido : v.length > MAX_TEXTO ? TEXTOS.erroPedidoLongo : '';
  if (nome === 'nome' && v.trim() && !RE_NOME.test(v.trim())) msg = TEXTOS.erroNome;
  $(erro).textContent = msg;
  if (msg) $(controle).setAttribute('aria-invalid', 'true');
  else $(controle).removeAttribute('aria-invalid');
  return !msg;
}

for (const nome of Object.keys(CAMPOS_NOVA)) {
  $(CAMPOS_NOVA[nome].controle).addEventListener('blur', () => {
    if ($('dlg-nova').open && !$('nova-form').hidden) validarCampoNova(nome);
  });
}
$('nova-conta').addEventListener('change', () => { $('nova-conta').dataset.mexida = '1'; });

function limparFormNova() {
  $('nova-form').reset();
  delete $('nova-conta').dataset.mexida;
  for (const { controle, erro } of Object.values(CAMPOS_NOVA)) {
    $(erro).textContent = '';
    $(controle).removeAttribute('aria-invalid');
  }
  $('nova-erros').textContent = '';
  $('nova-envio-erro').textContent = '';
  mostrarEtapaNova('form');
}

function mostrarEtapaNova(etapa) {
  const resumo = etapa === 'resumo';
  $('nova-form').hidden = resumo;
  $('nova-resumo').hidden = !resumo;
  $('nova-titulo').textContent = resumo ? 'Confirmar nova sessão' : 'Nova sessão';
}

function dadosNova() {
  const d = { projeto: $('nova-projeto').value, pedido: $('nova-pedido').value };
  if (!$('nova-conta-grupo').hidden && $('nova-conta').value) d.conta = $('nova-conta').value;
  if ($('nova-modelo').value) d.modelo = $('nova-modelo').value;
  if ($('nova-esforco').value) d.esforco = $('nova-esforco').value;
  const modo = document.querySelector('#nova-form input[name="modo"]:checked');
  d.modoPermissao = modo ? modo.value : 'manual';
  if ($('nova-worktree').checked) d.worktree = true;
  const nome = $('nova-nome').value.trim();
  if (nome) d.nome = nome;
  return d;
}

function mostrarResumoNova(d) {
  const o = orquestracao() || {};
  const dl = $('nova-resumo-lista');
  const linhas = [];
  const linha = (k, v) => linhas.push(el('dt', null, k), v instanceof Node ? v : el('dd', null, v));
  linha('Projeto', d.projeto);
  if (d.conta) linha('Conta', d.conta);
  linha('Modelo', d.modelo ? rotuloDe(MODELOS, d.modelo) : 'Padrão da conta');
  linha('Esforço', d.esforco ? rotuloDe(ESFORCOS, d.esforco) : 'Padrão');
  const modo = MODOS[d.modoPermissao] || { rotulo: d.modoPermissao, ajuda: '' };
  const ddModo = el('dd');
  ddModo.append(el('span', 'grade-valor', modo.rotulo), el('span', 'meta grade-ajuda', modo.ajuda));
  linha('Modo de permissão', ddModo);
  linha('Cópia isolada', d.worktree ? 'Sim' : 'Não');
  linha('Nome', d.nome || 'automático');
  const ddPedido = el('dd', 'grade-longo', d.pedido);
  ddPedido.tabIndex = 0;
  linha('Pedido inicial', ddPedido);
  dl.replaceChildren(...linhas);
  const abertas = Number.isFinite(o.abertas) ? o.abertas : 0;
  const max = Number.isFinite(o.maxSessoes) ? o.maxSessoes : '—';
  $('nova-resumo-frase').textContent = TEXTOS.novaFrase(abertas, max);
  $('nova-envio-erro').textContent = '';
  mostrarEtapaNova('resumo');
  $('nova-titulo').focus();
}

$('nova-sessao').addEventListener('click', () => {
  if (motivoNovaSessao()) return;
  limparFormNova();
  prepararFormNova();
  $('dlg-nova').showModal();
  $('nova-projeto').focus();
});

$('nova-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const invalidos = Object.keys(CAMPOS_NOVA).filter((nome) => !validarCampoNova(nome));
  if (invalidos.length) {
    $('nova-erros').textContent = TEXTOS.novaErros(invalidos.length);
    $(CAMPOS_NOVA[invalidos[0]].controle).focus();
    return;
  }
  $('nova-erros').textContent = '';
  nova.dados = dadosNova();
  mostrarResumoNova(nova.dados);
});

$('nova-voltar').addEventListener('click', () => {
  mostrarEtapaNova('form');
  $('nova-projeto').focus();
});

$('nova-abrir').addEventListener('click', async () => {
  if (nova.enviando || !nova.dados) return;
  nova.enviando = true;
  const abrir = $('nova-abrir');
  abrir.disabled = true;
  $('nova-voltar').disabled = true;
  abrir.textContent = 'Enviando…';
  $('nova-envio-erro').textContent = '';
  const r = await enviarComando('abrir', null, nova.dados);
  nova.enviando = false;
  abrir.disabled = false;
  $('nova-voltar').disabled = false;
  abrir.textContent = 'Abrir sessão';
  if (r.ok) {
    $('dlg-nova').close();
    renderNovaSessao();
    $('nova-sessao').focus();
    return;
  }
  if (r.erro) $('nova-envio-erro').textContent = r.erro;
});

$('nova-fechar').addEventListener('click', () => {
  if (!nova.enviando) $('dlg-nova').close();
});
$('dlg-nova').addEventListener('cancel', (ev) => {
  if (nova.enviando) ev.preventDefault();
});
$('dlg-nova').addEventListener('close', () => {
  limparFormNova();
  nova.dados = null;
  if (!$('nova-sessao').disabled) $('nova-sessao').focus();
});

/* ---------- Autorizar este aparelho ---------- */

// O aparelho gera um par ECDSA P-256 (a chave privada não extraível fica no IndexedDB) e pede autorização
// mandando só a chave pública. O dono autoriza no computador, pelo terminal, conferindo a impressão digital que
// aparece aqui (achado A1). Nada secreto é digitado nesta página.

let etapaAparelho = null; // 'pedir' | 'aguardando' enquanto o diálogo está aberto
let origemAparelho = null; // controle que abriu o diálogo, para devolver o foco
let pedindo = false;

const rotuloValido = (r) => !!r && !INVISIVEL.test(r) && Array.from(r).length <= MAX_ROTULO;

function aparelhoAutorizado(kid) {
  const o = orquestracao();
  return !!(kid && o && Array.isArray(o.aparelhos) && o.aparelhos.some((a) => a && a.kid === kid));
}

// Guarda em `estado` só o que é público do aparelho deste navegador e redesenha o rodapé se mudou.
async function sincronizarAparelho(a) {
  let novo = null;
  if (a) {
    try {
      const id = await impressaoDaPublica(a.publica);
      // Registro cujo kid não é o da própria chave pública conta como sem chave.
      if (id.kid === a.kid) novo = { kid: a.kid, impressao: id.impressao };
    } catch { /* registro estranho: conta como sem chave */ }
  }
  const antes = estado.aparelho;
  estado.aparelho = novo;
  if ((antes && antes.kid) !== (novo && novo.kid)) atualizarRodape();
  return novo;
}

// Sem `etapa`: com chave ainda não autorizada, mostra a impressão digital e a instrução; senão, o pedido.
function abrirDialogoAparelho(etapa = null) {
  const dlg = $('dlg-aparelho');
  if (dlg.open) return;
  origemAparelho = document.activeElement;
  const ap = estado.aparelho;
  mostrarEtapaAparelho(etapa || (ap && !aparelhoAutorizado(ap.kid) ? 'aguardando' : 'pedir'));
  dlg.showModal();
  if (etapaAparelho === 'pedir') $('autorizar-rotulo').focus();
  else $('autorizar-titulo').focus();
}

function mostrarEtapaAparelho(etapa) {
  etapaAparelho = etapa;
  $('autorizar-pedir').hidden = etapa !== 'pedir';
  $('autorizar-aguardando').hidden = etapa !== 'aguardando';
  $('dlg-aparelho').setAttribute('aria-describedby', etapa === 'pedir' ? 'autorizar-texto' : 'autorizar-instrucao');
  $('autorizar-erro').textContent = '';
  $('autorizar-rotulo').removeAttribute('aria-invalid');
  if (etapa === 'aguardando') atualizarAguardando();
}

// Impressão digital em letras grandes, a instrução com os dois comandos e se o computador já autorizou.
function atualizarAguardando() {
  const ap = estado.aparelho;
  if (!ap) return;
  $('autorizar-impressao').textContent = ap.impressao;
  // O comando de autorizar leva o kid e a impressão deste aparelho: o computador só grava a chave se a
  // impressão for a do pedido que chegou lá (um pedido trocado no caminho não passa).
  const instrucao = $('autorizar-instrucao');
  if (instrucao.dataset.kid !== ap.kid) {
    instrucao.dataset.kid = ap.kid;
    instrucao.replaceChildren('No computador, rode ', el('code', null, 'node scripts/configurar-comandos.js --pedidos'),
      ', confira se a impressão digital é esta e autorize com:');
    $('autorizar-comando').textContent = 'node scripts/configurar-comandos.js --autorizar ' + ap.kid + ' ' + ap.impressao;
  }
  const texto = aparelhoAutorizado(ap.kid) ? TEXTOS.aparelhoAutorizado : TEXTOS.aguardandoAutorizacao;
  const status = $('autorizar-status');
  // Depois de "Pedido enviado", só troca quando o computador autorizar (para o leitor de tela não repetir).
  if (status.textContent !== texto && (texto === TEXTOS.aparelhoAutorizado || status.textContent !== TEXTOS.pedidoEnviado)) {
    status.textContent = texto;
  }
}

function fecharDialogoAparelho() {
  if (pedindo) return;
  etapaAparelho = null;
  if ($('dlg-aparelho').open) $('dlg-aparelho').close();
}

function ocupadoAparelho(sim) {
  pedindo = sim;
  const b = $('autorizar-pedir-btn');
  b.disabled = sim;
  b.textContent = sim ? 'Pedindo…' : 'Pedir autorização';
  $('autorizar-fechar').disabled = sim;
  if (sim) $('dlg-aparelho').setAttribute('aria-busy', 'true');
  else $('dlg-aparelho').removeAttribute('aria-busy');
}

// Cria (ou reaproveita) a chave deste aparelho e manda o pedido com a chave pública e o nome.
async function pedirAutorizacao() {
  if (pedindo) return;
  const campo = $('autorizar-rotulo');
  const erro = $('autorizar-erro');
  const rotulo = campo.value.trim();
  if (!rotuloValido(rotulo)) {
    erro.textContent = TEXTOS.rotuloInvalido;
    campo.setAttribute('aria-invalid', 'true');
    campo.focus();
    return;
  }
  if (!criptoDisponivel()) {
    erro.textContent = TEXTOS.semCripto;
    return;
  }
  ocupadoAparelho(true);
  erro.textContent = '';
  try {
    let ap = null;
    try { ap = await obter(); } catch { /* sem IndexedDB: guardar avisa logo abaixo */ }
    // A chave guardada vale enquanto o computador não a conhece (pedido de novo, ou revogada e pedida outra
    // vez). Se o computador conhece este kid e mesmo assim recusou a assinatura, é preciso uma chave nova.
    if (ap && (aparelhoAutorizado(ap.kid) || !(await sincronizarAparelho(ap)))) ap = null;
    if (!ap) {
      const novo = await gerarAparelho();
      try {
        await guardar(novo);
      } catch {
        erro.textContent = TEXTOS.semIndexedDB;
        return;
      }
      ap = novo;
      await sincronizarAparelho(ap);
    }
    let r;
    try {
      r = await api('/api/aparelho', jsonOpcoes('POST', { kid: ap.kid, publica: ap.publica, rotulo }));
    } catch (e) {
      if (!(e instanceof NaoAutorizado)) erro.textContent = TEXTOS.erroRede;
      return;
    }
    if (!r.ok) {
      erro.textContent = r.status === 429 ? TEXTOS.pedidosDemais : r.status === 400 ? TEXTOS.erro400 : TEXTOS.erroOutro;
      return;
    }
    campo.value = '';
    mostrarEtapaAparelho('aguardando');
    $('autorizar-status').textContent = TEXTOS.pedidoEnviado;
    $('autorizar-titulo').focus();
    atualizarRodape();
  } catch {
    erro.textContent = TEXTOS.erroChave;
  } finally {
    ocupadoAparelho(false);
  }
}

$('autorizar-pedir-btn').addEventListener('click', pedirAutorizacao);
$('autorizar-rotulo').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    pedirAutorizacao();
  }
});
$('autorizar-rotulo').addEventListener('input', () => {
  $('autorizar-rotulo').removeAttribute('aria-invalid');
  $('autorizar-erro').textContent = '';
});
$('autorizar-de-novo').addEventListener('click', () => {
  mostrarEtapaAparelho('pedir');
  $('autorizar-rotulo').focus();
});
$('autorizar-fechar').addEventListener('click', fecharDialogoAparelho);
$('dlg-aparelho').addEventListener('cancel', (ev) => {
  ev.preventDefault();
  fecharDialogoAparelho();
});
$('dlg-aparelho').addEventListener('close', () => {
  etapaAparelho = null;
  const o = origemAparelho;
  origemAparelho = null;
  if (o && o.isConnected && o !== document.body) o.focus();
});

// Chave para assinar: a guardada neste navegador, se o computador já a autorizou. Senão, abre o diálogo (o
// pedido ou a instrução de autorizar) e o comando não sai.
async function chaveDoAparelho() {
  let a = null;
  try { a = await obter(); } catch { /* sem IndexedDB: o diálogo avisa ao tentar guardar */ }
  const publico = await sincronizarAparelho(a);
  if (a && publico && aparelhoAutorizado(a.kid)) return a;
  abrirDialogoAparelho(publico ? 'aguardando' : 'pedir');
  return null;
}

/* ---------- Rodapé "Este aparelho" ---------- */

function atualizarRodape(status) {
  const texto = $('aparelho-texto');
  const ap = estado.aparelho;
  const o = orquestracao();
  const conhecido = ap && o && Array.isArray(o.aparelhos) ? o.aparelhos.find((a) => a && a.kid === ap.kid) : undefined;
  const aguardando = !!ap && !!o && Array.isArray(o.aparelhos) && !conhecido;
  if (ap) {
    const partes = ['Aparelho ', el('code', null, ap.kid)];
    if (conhecido && conhecido.rotulo) partes.push(' · ' + conhecido.rotulo);
    else if (aguardando) partes.push(', aguardando autorização no computador. Impressão digital ', el('code', null, ap.impressao), '.');
    texto.replaceChildren(...partes);
  } else {
    texto.textContent = 'Este aparelho ainda não está autorizado a mandar comandos.';
  }
  $('aparelho-sair').hidden = !ap;
  $('aparelho-autorizar').hidden = !!ap;
  $('aparelho-instrucoes').hidden = !aguardando;
  $('aparelho-esquecer').hidden = !ap;
  if (status !== undefined) $('aparelho-status').textContent = status || '';
  if (etapaAparelho === 'aguardando') atualizarAguardando();
}

$('aparelho-autorizar').addEventListener('click', () => abrirDialogoAparelho('pedir'));
$('aparelho-instrucoes').addEventListener('click', () => abrirDialogoAparelho('aguardando'));
$('aparelho-esquecer').addEventListener('click', () => {
  $('aparelho-botoes').hidden = true;
  $('aparelho-confirmar').hidden = false;
  $('aparelho-esquecer-nao').focus();
});
function fecharConfirmacaoAparelho() {
  $('aparelho-confirmar').hidden = true;
  $('aparelho-botoes').hidden = false;
}
$('aparelho-esquecer-nao').addEventListener('click', () => {
  fecharConfirmacaoAparelho();
  $('aparelho-esquecer').focus();
});
$('aparelho-confirmar').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    fecharConfirmacaoAparelho();
    $('aparelho-esquecer').focus();
  }
});
// Apaga a chave deste navegador. A autorização no computador continua até o dono revogar lá; sem a chave
// privada, ninguém mais assina com ela.
$('aparelho-esquecer-sim').addEventListener('click', async () => {
  const kid = estado.aparelho ? estado.aparelho.kid : null;
  try { await esquecer(); } catch { /* sem IndexedDB não há o que esquecer */ }
  estado.aparelho = null;
  fecharConfirmacaoAparelho();
  atualizarRodape(kid ? TEXTOS.aparelhoEsquecido(kid) : '');
  $('aparelho-autorizar').focus();
});

/* ---------- Desenho e carga ---------- */

function renderTudo() {
  renderResumo();
  renderNovaSessao();
  renderLista();
  atualizarRodape();
  anunciarMudancas();
}

let carregando = false;
let deNovo = false;
let timerConsulta = null;

function agendarConsulta(ms) {
  clearTimeout(timerConsulta);
  timerConsulta = setTimeout(() => {
    if (document.visibilityState === 'visible' && estado.aba === 'sessoes') carregarEstado();
    else agendarConsulta(ms);
  }, ms);
}

// Consulta o estado; a próxima vem em 2 s enquanto houver comando a caminho e em 15 s no resto do tempo.
async function carregarEstado() {
  if (carregando) {
    deNovo = true;
    return;
  }
  carregando = true;
  clearTimeout(timerConsulta);
  let proxima = INTERVALO_MS;
  try {
    const r = await api('/api/estado');
    if (!r.ok || !r.dados) throw new Error('resposta inválida');
    estado.dados = r.dados;
    $('banner-rede').hidden = true;
    // Erro ao desenhar não é falta de conexão: registra e mantém o que já está na tela.
    try {
      renderTudo();
    } catch (erroTela) {
      console.error('[painel] erro ao desenhar', erroTela);
    }
    if (haComandoEmAndamento()) proxima = INTERVALO_RAPIDO_MS;
  } catch (e) {
    if (e instanceof NaoAutorizado) return;
    $('banner-rede').hidden = false;
    renderResumo();
    proxima = RETRY_MS;
  } finally {
    carregando = false;
  }
  if (deNovo) {
    deNovo = false;
    carregarEstado();
    return;
  }
  agendarConsulta(proxima);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && estado.aba === 'sessoes') carregarEstado();
});

/* ---------- Filtro ---------- */

function definirFiltro(f) {
  estado.filtro = f;
  $('filtro-abertas').setAttribute('aria-pressed', String(f === 'abertas'));
  $('filtro-todas').setAttribute('aria-pressed', String(f === 'todas'));
  renderLista();
}
$('filtro-abertas').addEventListener('click', () => definirFiltro('abertas'));
$('filtro-todas').addEventListener('click', () => definirFiltro('todas'));

/* ---------- Abas ---------- */

function definirAba(nome) {
  estado.aba = nome;
  const sess = nome === 'sessoes';
  $('aba-sessoes').setAttribute('aria-selected', String(sess));
  $('aba-sessoes').tabIndex = sess ? 0 : -1;
  $('aba-historico').setAttribute('aria-selected', String(!sess));
  $('aba-historico').tabIndex = sess ? -1 : 0;
  $('painel-sessoes').hidden = !sess;
  $('painel-historico').hidden = sess;
  if (sess) carregarEstado();
  else carregarLogs();
}
$('aba-sessoes').addEventListener('click', () => definirAba('sessoes'));
$('aba-historico').addEventListener('click', () => definirAba('historico'));
for (const id of ['aba-sessoes', 'aba-historico']) {
  $(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const outro = id === 'aba-sessoes' ? 'historico' : 'sessoes';
      definirAba(outro);
      $('aba-' + outro).focus();
    }
  });
}

/* ---------- Histórico ---------- */

let seqLogs = 0;

async function carregarLogs() {
  const minha = ++seqLogs;
  const q = $('busca').value.trim();
  $('logs-erro').hidden = true;
  $('logs-vazio').hidden = true;
  if (!$('logs').children.length) $('logs-carregando').hidden = false;
  try {
    const r = await api('/api/logs' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (minha !== seqLogs) return;
    $('logs-carregando').hidden = true;
    if (!r.ok || !r.dados) throw new Error('resposta inválida');
    renderLogs(r.dados.logs || []);
  } catch (e) {
    if (e instanceof NaoAutorizado || minha !== seqLogs) return;
    $('logs-carregando').hidden = true;
    $('logs-erro').hidden = false;
  }
}

function renderLogs(logs) {
  const ul = $('logs');
  ul.replaceChildren(...logs.map(criarLog));
  const vazio = $('logs-vazio');
  vazio.textContent = $('busca').value.trim()
    ? 'Nenhum log encontrado para essa busca.'
    : 'Nenhuma sessão encerrada pelo painel ainda.';
  vazio.hidden = logs.length > 0;
}

function criarLog(l) {
  const li = el('li');
  const art = el('article', 'log');
  li.appendChild(art);

  const topo = el('div', 'log-linha');
  const nome = el('span', 'log-nome', l.nome || '(sem nome)');
  const renomear = el('button', 'btn btn-leve', 'Renomear');
  renomear.type = 'button';
  topo.append(nome, renomear);

  const meta = el('div', 'log-meta num');
  const partes = [
    l.encerradaEm ? dataHora(l.encerradaEm) : null,
    l.projeto,
    l.duracaoMs != null ? duracao(l.duracaoMs) : null,
    l.modelo ? modeloLegivel(l.modelo) + (l.esforco ? ' · ' + l.esforco : '') : null,
    moeda(l.custo),
  ].filter(Boolean);
  meta.textContent = partes.join(' · ');

  art.append(topo, meta);
  if (l.resumo) art.appendChild(el('p', 'log-resumo', l.resumo));

  renomear.addEventListener('click', () => {
    const form = el('form', 'log-linha');
    const campo = el('input', 'campo');
    campo.type = 'text';
    campo.maxLength = 140;
    campo.value = l.nome || '';
    campo.setAttribute('aria-label', 'Novo nome do log');
    const salvar = el('button', 'btn btn-primario', 'Salvar');
    salvar.type = 'submit';
    const cancelar = el('button', 'btn', 'Cancelar');
    cancelar.type = 'button';
    const aviso = el('p', 'acao-estado erro');
    aviso.hidden = true;
    form.append(campo, salvar, cancelar);
    topo.replaceWith(form);
    form.after(aviso);
    campo.focus();

    const voltar = () => {
      form.replaceWith(topo);
      aviso.remove();
      renomear.focus();
    };
    cancelar.addEventListener('click', voltar);
    form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') voltar(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const novo = campo.value.trim();
      if (!novo) { campo.focus(); return; }
      salvar.disabled = true;
      try {
        const r = await api('/api/logs', jsonOpcoes('PATCH', { id: l.id, nome: novo }));
        if (!r.ok) throw new Error('falhou');
        l.nome = novo;
        nome.textContent = novo;
        voltar();
      } catch (e) {
        if (e instanceof NaoAutorizado) return;
        salvar.disabled = false;
        aviso.textContent = 'Não foi possível salvar o nome.';
        aviso.hidden = false;
      }
    });
  });
  return li;
}

let timerBusca = null;
$('busca').addEventListener('input', () => {
  clearTimeout(timerBusca);
  timerBusca = setTimeout(carregarLogs, 300);
});

/* ---------- Sair ---------- */

// Sair também esquece o aparelho: a chave de comandos não fica num navegador sem login.
$('sair').addEventListener('click', async () => {
  try { await esquecer(); } catch { /* sem IndexedDB não há o que esquecer */ }
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* segue para o login mesmo assim */ }
  location.href = '/login.html';
});

/* ---------- Início ---------- */

obter()
  .then((a) => sincronizarAparelho(a))
  .catch(() => sincronizarAparelho(null))
  .finally(() => atualizarRodape());
carregarEstado();
