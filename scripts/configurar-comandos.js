#!/usr/bin/env node
// Autoriza e revoga os aparelhos que podem mandar comandos ao coletor (PLANO, tarefas 7 e 15).
// Uso: node scripts/configurar-comandos.js --pedidos           lista os pedidos de autorização que chegaram
//      node scripts/configurar-comandos.js --autorizar <kid> <impressão>   autoriza o aparelho de um pedido
//      node scripts/configurar-comandos.js --listar            mostra os aparelhos autorizados
//      node scripts/configurar-comandos.js --revogar <kid>     tira um aparelho (vale sem reiniciar o coletor)
// O aparelho gera no navegador um par de chaves ECDSA P-256 cuja chave privada não sai dele; o painel manda só a
// chave pública, que o coletor deixa em <estado>/aparelhos-pedidos.json. --pedidos mostra kid, rótulo e horário,
// mas não a impressão digital (SE-M3): o dono a lê no aparelho e a digita em --autorizar, que só grava se ela for
// a do pedido, então um pedido trocado entre --pedidos e --autorizar não passa. --autorizar também recusa se a
// última conferência do painel publicado divergiu (A1-resto). A chave pública vai para o arquivo de chaves (600).
// Nada secreto é digitado nem impresso; a saída tem só kid, rótulo, impressão digital, horários e caminhos.
// Caminhos: os mesmos do coletor (caminhosDoColetor, SE-M4), inclusive MOISES_CHAVES_ARQ, MOISES_PROJETOS e
// MOISES_ESTADO escritos no coletor.env; pasta de configuração em MOISES_PASTA_CONF (padrão ~/.config/moises).
// Lê o coletor.env só para isso; não toca em coletor.env, vercel.env nem senha-painel.txt.
import fs from 'node:fs';
import path from 'node:path';
import { impressaoDaPublica, pedidoDeAparelho, chavePublica, RE_KID } from '../collector/assinatura.js';
import { caminhosDoColetor } from '../collector/index.js';

const local = caminhosDoColetor({ avisar: (m) => console.error(`Aviso: ${m.replace(/^\[coletor\] /, '')}`) });
const pastaEstado = local.pastaEstado;
const arqChaves = local.chavesArq;
const arqProjetos = local.projetosArq;
const arqPedidos = path.join(pastaEstado, 'aparelhos-pedidos.json');
const arqConferencia = path.join(pastaEstado, 'painel-conferencia.json');
const VALIDADE_PEDIDO_MS = 3_600_000; // a mesma do servidor
const CONFERENCIA_VELHA_MS = 3_600_000; // o coletor confere a cada 10 min: mais de 1 hora é coletor parado
const FOLGA_RELOGIO_MS = 5 * 60_000;
const INVISIVEIS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const RE_IMPRESSAO = /^[0-9a-f]{16}$/;
const USO = 'Uso: node scripts/configurar-comandos.js --pedidos | --autorizar <kid> <impressão> | --listar | --revogar <kid>';
const PECA_IMPRESSAO = 'Confira a impressão digital mostrada no aparelho e passe-a: --autorizar <kid> <impressão>';
const COMO_AUTORIZAR = 'Para autorizar, digite a impressão digital que aparece no aparelho: --autorizar <kid> <impressão>';
const PAINEL_DIVERGENTE = 'o painel publicado não confere com este computador; não autorize aparelhos até resolver (veja o log do coletor)';
const fmtHora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function sair(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const limpo = (texto) => (typeof texto === 'string' ? texto.replace(INVISIVEIS, '') : '');
const quando = (ms) => (Number.isFinite(ms) ? fmtHora.format(new Date(ms)).replace(',', '') : '?');
// Antes de tudo, o arquivo que vai ser lido ou alterado: o mesmo que o coletor carrega (SE-M4).
const mostrarArquivo = () => console.log(`Arquivo de chaves: ${arqChaves}`);

// Arquivo ausente é lista vazia. Arquivo ilegível ou inválido interrompe tudo: regravá-lo apagaria
// os aparelhos que já estão lá.
function lerChaves() {
  let bruto;
  try {
    bruto = fs.readFileSync(arqChaves, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    sair(`Não foi possível ler ${arqChaves} (${err?.code || 'erro'}); nada foi alterado.`);
  }
  let json;
  try {
    json = JSON.parse(bruto);
  } catch {
    json = null;
  }
  if (!objetoSimples(json)) sair(`${arqChaves} não é um objeto JSON válido; corrija ou apague o arquivo. Nada foi alterado.`);
  return json;
}

// Pedidos que o coletor gravou, conferidos de novo aqui (o servidor não é confiável): só os coerentes
// (kid da própria chave pública, ponto na curva, rótulo visível) e ainda na validade.
function lerPedidos(agora = Date.now()) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(arqPedidos, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    if (err instanceof SyntaxError) sair(`${arqPedidos} não é um JSON válido; espere o coletor gravá-lo de novo.`);
    sair(`Não foi possível ler ${arqPedidos} (${err?.code || 'erro'}).`);
  }
  if (!Array.isArray(json)) return [];
  return json.map(pedidoDeAparelho).filter((p) => p && agora - p.criadoEm < VALIDADE_PEDIDO_MS);
}

// Cria um arquivo novo com permissão 600; falha se ele já existir.
function criar600(arquivo, texto) {
  const fd = fs.openSync(arquivo, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, texto);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Grava por arquivo temporário e rename: quem lê (o coletor) nunca vê o arquivo pela metade.
function gravarChaves(json) {
  const tmp = `${arqChaves}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    criar600(tmp, `${JSON.stringify(json, null, 2)}\n`);
    fs.renameSync(tmp, arqChaves);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function pedidos() {
  mostrarArquivo();
  const chaves = lerChaves();
  // Pedido de um aparelho já autorizado com a mesma chave não precisa de nada.
  const lista = lerPedidos().filter((p) => chaves[p.kid]?.publica !== p.publica);
  if (!lista.length) {
    console.log('Nenhum pedido de autorização. No aparelho, toque em "Autorizar este aparelho" e em "Pedir autorização";');
    console.log('o pedido chega aqui no ciclo seguinte do coletor e vale por 1 hora.');
    return;
  }
  // Sem a impressão digital (SE-M3): copiá-la daqui pularia a conferência com o que o aparelho mostra.
  console.log('Pedidos de autorização (kid, rótulo, pedido em):');
  for (const p of lista) console.log(`${p.kid}  ${limpo(p.rotulo)}  ${quando(p.criadoEm)}`);
  console.log(COMO_AUTORIZAR);
  const porRotulo = new Map();
  for (const p of lista) porRotulo.set(limpo(p.rotulo), [...(porRotulo.get(limpo(p.rotulo)) ?? []), p.kid]);
  for (const [rotulo, kids] of porRotulo) {
    if (kids.length > 1) {
      console.log(`Aviso: ${kids.length} pedidos com o mesmo rótulo "${rotulo}" (${kids.join(', ')}). Só um pode ser o seu aparelho: autorize só aquele cuja impressão digital você lê no aparelho.`);
    }
  }
}

// A última conferência do painel publicado (A1-resto): com o painel divergente, a página que pede o pareamento
// pode ser a de um invasor, então não se autoriza nada. Sem registro, ou antigo (coletor parado), avisa e segue.
// Com a conferência desligada (MOISES_CONFERIR_PAINEL=0), não há o que consultar.
function conferirPainelAntes() {
  if (!local.conferirPainel) {
    console.error('Aviso: a conferência do painel publicado está desligada (MOISES_CONFERIR_PAINEL=0); nada foi conferido.');
    return;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(arqConferencia, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error('Aviso: não há registro da conferência do painel publicado (o coletor está rodando?); seguindo sem ela.');
      return;
    }
    // Na dúvida, não autoriza: o coletor regrava o arquivo na próxima conferência.
    sair(`Não foi possível ler ${arqConferencia} (${err instanceof SyntaxError ? 'JSON inválido' : err?.code || 'erro'}); espere a próxima conferência do coletor. Nada foi gravado.`);
  }
  if (!objetoSimples(json) || typeof json.ok !== 'boolean' || !Number.isFinite(json.em)) {
    sair(`${arqConferencia} está fora do formato; espere a próxima conferência do coletor. Nada foi gravado.`);
  }
  // Divergência recusa mesmo antiga: é a última coisa que se sabe do painel.
  if (!json.ok) sair(`Não autorizado: ${PAINEL_DIVERGENTE}. Nada foi gravado.`);
  const idade = Date.now() - json.em;
  if (idade > CONFERENCIA_VELHA_MS) {
    console.error('Aviso: a última conferência do painel publicado tem mais de 1 hora (o coletor está rodando?); seguindo sem ela.');
  } else if (idade < -FOLGA_RELOGIO_MS) {
    console.error('Aviso: a última conferência do painel publicado tem data no futuro (relógio do computador?); seguindo sem ela.');
  }
}

// Impressão digital digitada pelo dono: aceita maiúsculas, hífens e espaços; null se não forem 16 hexadecimais.
const normalizarImpressao = (texto) => {
  const normal = typeof texto === 'string' ? texto.toLowerCase().replace(/[\s-]/g, '') : '';
  return RE_IMPRESSAO.test(normal) ? normal : null;
};
const semHifens = (impressao) => impressao.replaceAll('-', '');

function autorizar(kid, impressaoDigitada) {
  mostrarArquivo();
  if (typeof kid !== 'string' || !RE_KID.test(kid)) sair(`Informe o kid do aparelho (6 hexadecimais), como aparece em --pedidos.\n${USO}`);
  // A impressão digital é obrigatória: é ela que garante que a chave gravada é a que o aparelho mostra,
  // mesmo que o servidor troque o pedido (com o mesmo kid) entre --pedidos e --autorizar.
  const conferida = normalizarImpressao(impressaoDigitada);
  if (!conferida) sair(`${PECA_IMPRESSAO}. Nada foi gravado.`);
  conferirPainelAntes();
  const chaves = lerChaves();
  const doKid = lerPedidos().filter((p) => p.kid === kid);
  if (!doKid.length) sair(`Nenhum pedido válido com o kid ${kid}; rode --pedidos. Pedidos valem por 1 hora; se passou, peça de novo no aparelho.`);
  const candidatos = doKid.filter((p) => semHifens(impressaoDaPublica(p.publica).impressao) === conferida);
  if (!candidatos.length) {
    sair(`A impressão digital não é a do pedido ${kid}; nada foi gravado. ${PECA_IMPRESSAO}. Se ela confere no aparelho e não aqui, o pedido foi trocado no caminho: não autorize.`);
  }
  if (new Set(candidatos.map((p) => p.publica)).size > 1) {
    sair(`Há mais de um pedido com o kid ${kid} e a mesma impressão digital; nada foi gravado. No aparelho, toque em "Esquecer este aparelho" e peça de novo.`);
  }
  const pedido = candidatos.at(-1);
  // Confere de novo que a chave é uma pública P-256 válida (pedidoDeAparelho já conferiu).
  if (!chavePublica(pedido.publica)) sair(`O pedido ${kid} tem chave pública inválida; nada foi autorizado.`);
  const { impressao } = impressaoDaPublica(pedido.publica);
  const rotulo = limpo(pedido.rotulo);
  const existente = chaves[kid];
  if (existente) {
    if (existente.publica === pedido.publica) {
      console.log(`O aparelho ${kid} (${limpo(existente.rotulo)}) já está autorizado, impressão digital ${impressao}. Nada mudou.`);
      return;
    }
    sair(`Já existe um aparelho autorizado com o kid ${kid}; nada foi alterado. Se ele não vale mais, revogue antes com --revogar ${kid}.`);
  }
  const mesmoRotulo = Object.entries(chaves).filter(([k, e]) => RE_KID.test(k) && objetoSimples(e) && limpo(e.rotulo) === rotulo).map(([k]) => k);
  fs.mkdirSync(path.dirname(arqChaves), { recursive: true, mode: 0o700 });
  try {
    chaves[kid] = { rotulo: pedido.rotulo, publica: pedido.publica, criadaEm: new Date().toISOString() };
    gravarChaves(chaves);
  } catch (err) {
    sair(`Não foi possível gravar ${arqChaves} (${err?.code || 'erro'}); nada foi alterado.`);
  }
  try {
    criar600(arqProjetos, '{}\n');
  } catch (err) {
    if (err?.code !== 'EEXIST') console.error(`Aviso: não foi possível criar ${arqProjetos} (${err?.code || 'erro'}).`);
  }
  console.log(`Aparelho ${kid} autorizado: ${rotulo}, impressão digital ${impressao}.`);
  console.log(`Confira: a impressão digital tem de ser a mesma que aparece no aparelho. Se não for, revogue já com --revogar ${kid}.`);
  console.log('Vale no próximo comando, sem reiniciar o coletor.');
  if (mesmoRotulo.length) {
    console.log(`Aviso: já existe aparelho com o mesmo rótulo (${mesmoRotulo.join(', ')}). Se for este mesmo aparelho de antes, revogue o antigo com --revogar <kid>.`);
  }
}

function listar() {
  mostrarArquivo();
  const chaves = lerChaves();
  const kids = Object.keys(chaves).filter((k) => RE_KID.test(k));
  if (!kids.length) {
    console.log('Nenhum aparelho autorizado.');
    return;
  }
  for (const kid of kids) {
    const e = objetoSimples(chaves[kid]) ? chaves[kid] : {};
    const id = impressaoDaPublica(e.publica);
    const criada = Date.parse(e.criadaEm);
    if (id && chavePublica(e.publica)) {
      console.log(`${kid}  ${limpo(e.rotulo)}  ${id.impressao}  autorizado em ${quando(criada)}`);
    } else {
      // Entrada do formato antigo (chave do código do aparelho) ou com chave inválida: o coletor a ignora.
      console.log(`${kid}  ${limpo(e.rotulo)}  formato antigo ou chave inválida: não vale mais; revogue e autorize de novo`);
    }
  }
}

function revogar(kid) {
  mostrarArquivo();
  if (typeof kid !== 'string' || !RE_KID.test(kid)) sair(`Informe o kid do aparelho (6 hexadecimais).\n${USO}`);
  const chaves = lerChaves();
  if (!Object.hasOwn(chaves, kid)) sair(`Aparelho ${kid} não encontrado; nada foi alterado.`);
  delete chaves[kid];
  try {
    gravarChaves(chaves);
  } catch (err) {
    sair(`Não foi possível gravar ${arqChaves} (${err?.code || 'erro'}); o aparelho continua autorizado.`);
  }
  console.log(`Aparelho ${kid} revogado. Vale no próximo comando, sem reiniciar o coletor.`);
}

const [primeiro, segundo, ...resto] = process.argv.slice(2);
if (primeiro === '--pedidos') pedidos();
// A impressão pode vir num argumento só (a1b2-c3d4-e5f6-0718) ou em grupos separados por espaço.
else if (primeiro === '--autorizar') autorizar(segundo, resto.length ? resto.join('') : undefined);
else if (primeiro === '--listar') listar();
else if (primeiro === '--revogar') revogar(segundo);
else sair(USO);
