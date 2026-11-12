// Configuração de produção do coletor: lê o coletor.env e o ambiente e resolve caminhos, números e chaves de
// desligar. O laço (collector/index.js) e o script de pareamento (scripts/configurar-comandos.js) usam daqui.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FERRAMENTAS_PADRAO } from './orquestrador.js';

// Chaves de desligar (S28): valem no coletor.env e no ambiente, e basta uma das fontes dizer desligado.
const CHAVES_DE_DESLIGAR = ['MOISES_COMANDOS', 'MOISES_SUBIR_TEXTO', 'MOISES_ENCERRAR', 'MOISES_CONFERIR_PAINEL'];
const RE_FERRAMENTA = /^[A-Za-z]{1,30}$/;
// Chaves que o coletor lê do coletor.env. Outra MOISES_* no arquivo gera aviso: um erro de digitação numa
// chave de desligar não pode deixar tudo ligado em silêncio (S28).
const CHAVES_DO_ARQUIVO = new Set([
  'MOISES_URL', 'MOISES_TOKEN', 'MOISES_ESTADO', 'MOISES_CHAVES_ARQ', 'MOISES_PROJETOS', 'MOISES_INTERVALO_MS',
  'MOISES_INTERVALO_RAPIDO_MS', 'MOISES_MAX_SESSOES', 'MOISES_MAX_ABRIR_DIA', 'MOISES_TETO_SESSAO_USD', 'MOISES_FERRAMENTAS',
  'MOISES_PERMISSAO_EXPIRA_MIN', 'MOISES_SO_PREFIXO', 'MOISES_ENCERRAR_POR_HORA', ...CHAVES_DE_DESLIGAR,
]);
const VALORES_DESLIGADO = new Set(['0', 'false', 'off', 'nao', 'não', 'desligado']);
const VALORES_LIGADO = new Set(['1', 'true', 'on', 'sim', 'ligado']);
const RE_LINHA_CONF = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const avisarNoLog = (m) => console.error(m);

// Valor de uma linha do coletor.env: entre aspas (simples ou duplas), o que está dentro, e o resto da linha
// é ignorado; sem aspas, até um `#` precedido de espaço (comentário), aparado.
function valorDaLinha(bruto) {
  const aparado = bruto.trim();
  const aspas = aparado[0];
  if (aspas === '"' || aspas === "'") {
    const fim = aparado.indexOf(aspas, 1);
    if (fim > 0) return aparado.slice(1, fim);
  }
  const comentario = bruto.search(/\s#/);
  return (comentario >= 0 ? bruto.slice(0, comentario) : bruto).trim();
}

// Lê o coletor.env: { CHAVE: valor }. Linha que não se entende e chave MOISES_* desconhecida geram aviso com
// o número da linha ou o nome da chave, nunca o valor (pode ser o token). Arquivo ausente vale vazio.
function lerConf(arquivo, avisar = avisarNoLog) {
  const out = Object.create(null);
  let texto;
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') avisar(`[coletor] não foi possível ler ${arquivo} (${err?.code || 'erro'}); usando só o ambiente.`);
    return out;
  }
  texto.split(/\r?\n/).forEach((linha, i) => {
    if (!linha.trim() || linha.trim().startsWith('#')) return;
    const m = linha.match(RE_LINHA_CONF);
    if (!m) {
      avisar(`[coletor] linha ${i + 1} do coletor.env não foi entendida (esperado CHAVE=valor); ignorada.`);
      return;
    }
    const [, chave, bruto] = m;
    if (/^moises_/i.test(chave) && !CHAVES_DO_ARQUIVO.has(chave)) {
      avisar(`[coletor] chave desconhecida no coletor.env: ${chave} (ignorada; confira o nome).`);
      return;
    }
    out[chave] = valorDaLinha(bruto);
  });
  return out;
}

// Valor de uma chave de desligar: '0' (desligado), '1' (ligado), null (não reconhecido) ou undefined (ausente).
function valorDaChave(valor) {
  if (typeof valor !== 'string' || !valor.trim()) return undefined;
  const normal = valor.trim().normalize('NFC').toLowerCase();
  if (VALORES_DESLIGADO.has(normal)) return '0';
  if (VALORES_LIGADO.has(normal)) return '1';
  return null;
}

// Chaves em que desligar é o lado inseguro (S28-b): valor não reconhecido as mantém ligadas.
const DESLIGAR_E_INSEGURO = new Set(['MOISES_CONFERIR_PAINEL']);

// Junta o ambiente e o coletor.env de uma chave de desligar: basta uma fonte dizer desligado. Valor não
// reconhecido vale o lado seguro da chave (desligado; ligado para a conferência do painel), com aviso que
// cita a chave e não o valor. undefined se nenhuma fonte a define.
function chaveDeDesligar(nome, doAmbiente, doArquivo, avisar) {
  const valores = [doAmbiente, doArquivo].map(valorDaChave);
  if (valores.includes(null)) {
    const seguro = DESLIGAR_E_INSEGURO.has(nome) ? '1' : '0';
    avisar(`[coletor] valor não reconhecido em ${nome} (aceito: 0, false, off, nao, não, desligado ou 1, true, on, sim, ligado); vale ${seguro === '1' ? 'ligado' : 'desligado'}.`);
    // Ligado só se o lado seguro for ligado e a outra fonte não disser desligado.
    return seguro === '1' && !valores.includes('0') ? '1' : '0';
  }
  if (valores.includes('0')) return '0';
  if (valores.includes('1')) return '1';
  return undefined;
}

const numeroParaTexto = (n) => String(n).replace('.', ',');

// Número do ambiente ou do coletor.env, dentro dos limites; aceita vírgula decimal (0,50). Inválido ou fora
// da faixa: um teto vale o limite mais restritivo (o mínimo da faixa) e os demais o padrão, com um aviso que
// não repete o valor (SE-M7).
function numeroEntre(valor, nome, padrao, min, max, { inteiro = true, teto = false, avisar = avisarNoLog } = {}) {
  if (valor === undefined) return padrao;
  const texto = String(valor).trim();
  if (texto === '') return padrao;
  const n = /^[0-9]+(?:[.,][0-9]+)?$/.test(texto) ? Number(texto.replace(',', '.')) : NaN;
  if (Number.isFinite(n) && n >= min && n <= max && (!inteiro || Number.isInteger(n))) return n;
  const faixa = `aceito: ${numeroParaTexto(min)} a ${numeroParaTexto(max)}`;
  if (teto) {
    avisar(`[coletor] valor inválido em ${nome} (${faixa}); usando o limite mais restritivo, ${numeroParaTexto(min)}.`);
    return min;
  }
  avisar(`[coletor] valor inválido em ${nome} (${faixa}); usando o padrão ${numeroParaTexto(padrao)}.`);
  return padrao;
}

// MOISES_FERRAMENTAS só reduz a lista padrão (SE-M2): nome fora dela é ignorado, com aviso; lista que
// fica vazia volta à padrão, com aviso. A ordem é a da lista padrão.
function listaDeFerramentas(valor, avisar = avisarNoLog) {
  if (valor === undefined || !String(valor).trim()) return FERRAMENTAS_PADRAO;
  const pedidas = new Set(String(valor).split(',').map((f) => f.trim()).filter(Boolean));
  const fora = [...pedidas].filter((f) => !FERRAMENTAS_PADRAO.includes(f));
  if (fora.length) {
    const nomes = fora.filter((f) => RE_FERRAMENTA.test(f));
    const outros = fora.length - nomes.length;
    const citados = [...nomes, ...(outros ? [`${outros} nome(s) fora do formato`] : [])].join(', ');
    avisar(`[coletor] MOISES_FERRAMENTAS só pode reduzir a lista ${FERRAMENTAS_PADRAO.join(',')}; ignorados: ${citados}.`);
  }
  const lista = FERRAMENTAS_PADRAO.filter((f) => pedidas.has(f));
  if (lista.length) return lista;
  avisar(`[coletor] MOISES_FERRAMENTAS ficou sem nenhuma ferramenta da lista; usando o padrão ${FERRAMENTAS_PADRAO.join(',')}.`);
  return FERRAMENTAS_PADRAO;
}

// Caminho de arquivo ou pasta da configuração: absoluto, ou ~/ relativo à pasta pessoal. Relativo
// dependeria da pasta de onde se roda (coletor e script veriam arquivos diferentes): vale o padrão, com aviso.
function caminhoDaConf(valor, nome, padrao, home, avisar) {
  if (typeof valor !== 'string' || !valor.trim()) return padrao;
  const v = valor.trim();
  if (v === '~' || v.startsWith('~/')) return path.join(home, v.slice(1));
  if (path.isAbsolute(v)) return path.resolve(v);
  avisar(`[coletor] ${nome} precisa ser um caminho absoluto (ou começar com ~/); usando o padrão ${padrao}.`);
  return padrao;
}

// Lê o coletor.env (MOISES_CONF, ou coletor.env na pasta de configuração) e resolve os caminhos. A pasta de
// configuração é MOISES_PASTA_CONF (padrão ~/.config/moises). O ambiente vale por cima do arquivo.
function lerLocal({ env, home, avisar }) {
  const pastaConf = caminhoDaConf(env.MOISES_PASTA_CONF, 'MOISES_PASTA_CONF', path.join(home, '.config/moises'), home, avisar);
  const arquivo = caminhoDaConf(env.MOISES_CONF, 'MOISES_CONF', path.join(pastaConf, 'coletor.env'), home, avisar);
  const doArquivo = lerConf(arquivo, avisar);
  const v = (k) => env[k] || doArquivo[k] || undefined;
  const caminhos = {
    pastaEstado: caminhoDaConf(v('MOISES_ESTADO'), 'MOISES_ESTADO', path.join(home, '.local/state/moises'), home, avisar),
    chavesArq: caminhoDaConf(v('MOISES_CHAVES_ARQ'), 'MOISES_CHAVES_ARQ', path.join(pastaConf, 'chaves-comandos.json'), home, avisar),
    projetosArq: caminhoDaConf(v('MOISES_PROJETOS'), 'MOISES_PROJETOS', path.join(pastaConf, 'projetos.json'), home, avisar),
  };
  return { pastaConf, arquivo, doArquivo, v, caminhos };
}

// Onde o coletor procura cada arquivo, pela mesma regra que ele usa ao iniciar (SE-M4): o
// configurar-comandos.js usa esta função para autorizar e revogar no arquivo que o coletor lê. Devolve só
// caminhos absolutos e se a conferência do painel está ligada; nada do conteúdo do coletor.env.
export function caminhosDoColetor({ env = process.env, home = os.homedir(), avisar = avisarNoLog } = {}) {
  const { pastaConf, arquivo, doArquivo, caminhos } = lerLocal({ env, home, avisar });
  const conferir = chaveDeDesligar('MOISES_CONFERIR_PAINEL', env.MOISES_CONFERIR_PAINEL, doArquivo.MOISES_CONFERIR_PAINEL, avisar);
  return { arquivoConf: arquivo, pastaConf, ...caminhos, conferirPainel: conferir !== '0' };
}

// coletor.env (ou o ambiente, que tem precedência nos valores). A chave de comandos nunca vem daqui: só o
// caminho do arquivo dela. As chaves de desligar e o teto de encerramentos vão para `env` (process.env),
// na forma canônica, que é onde os módulos os leem.
export function configuracao({ env = process.env, home = os.homedir(), avisar = avisarNoLog } = {}) {
  const { arquivo, doArquivo, v, caminhos } = lerLocal({ env, home, avisar });
  for (const k of CHAVES_DE_DESLIGAR) {
    const valor = chaveDeDesligar(k, env[k], doArquivo[k], avisar);
    if (valor !== undefined) env[k] = valor;
  }
  const porHora = v('MOISES_ENCERRAR_POR_HORA');
  if (porHora !== undefined) env.MOISES_ENCERRAR_POR_HORA = String(numeroEntre(porHora, 'MOISES_ENCERRAR_POR_HORA', 5, 0, 1000, { teto: true, avisar }));
  const numero = (k, padrao, min, max, opcoes = {}) => numeroEntre(v(k), k, padrao, min, max, { avisar, ...opcoes });
  return {
    arquivo,
    url: v('MOISES_URL'),
    token: v('MOISES_TOKEN'),
    ...caminhos,
    intervaloMs: numero('MOISES_INTERVALO_MS', 20_000, 1000, 3_600_000),
    intervaloRapidoMs: numero('MOISES_INTERVALO_RAPIDO_MS', 3_000, 1000, 60_000),
    maxSessoes: numero('MOISES_MAX_SESSOES', 4, 0, 50, { teto: true }),
    maxAbrirPorDia: numero('MOISES_MAX_ABRIR_DIA', 20, 0, 1000, { teto: true }),
    tetoSessaoUsd: numero('MOISES_TETO_SESSAO_USD', 5, 0.01, 100, { inteiro: false, teto: true }),
    ferramentas: listaDeFerramentas(v('MOISES_FERRAMENTAS'), avisar),
    permissaoExpiraMs: numero('MOISES_PERMISSAO_EXPIRA_MIN', 30, 1, 1440, { teto: true }) * 60_000,
    soPrefixo: v('MOISES_SO_PREFIXO') || null,
    conferirPainel: env.MOISES_CONFERIR_PAINEL !== '0',
  };
}
