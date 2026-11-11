#!/usr/bin/env node
// Autoriza e revoga os aparelhos que podem mandar comandos ao coletor (PLANO, tarefas 7 e 15).
// Uso: node scripts/configurar-comandos.js --pedidos           lista os pedidos de autorização que chegaram
//      node scripts/configurar-comandos.js --autorizar <kid> <impressão>   autoriza o aparelho de um pedido
//      node scripts/configurar-comandos.js --listar            mostra os aparelhos autorizados
//      node scripts/configurar-comandos.js --revogar <kid>     tira um aparelho (vale sem reiniciar o coletor)
// O aparelho gera no navegador um par de chaves ECDSA P-256 cuja chave privada não sai dele; o painel manda só a
// chave pública, que o coletor deixa em <estado>/aparelhos-pedidos.json. Aqui o dono confere a impressão digital
// (a mesma que o aparelho mostra) e autoriza passando-a: só grava se ela for a do pedido, então um pedido trocado
// entre --pedidos e --autorizar não passa. A chave pública vai para chaves-comandos.json (600). Nada secreto é
// digitado nem impresso; a saída tem só kid, rótulo, impressão digital e horários (achado A1).
// Pastas: MOISES_PASTA_CONF (padrão ~/.config/moises) e MOISES_ESTADO (padrão ~/.local/state/moises, a do coletor).
// Não toca em coletor.env, vercel.env nem senha-painel.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { impressaoDaPublica, pedidoDeAparelho, chavePublica } from '../collector/assinatura.js';

const pasta = process.env.MOISES_PASTA_CONF || path.join(os.homedir(), '.config/moises');
const pastaEstado = process.env.MOISES_ESTADO || path.join(os.homedir(), '.local/state/moises');
const arqChaves = path.join(pasta, 'chaves-comandos.json');
const arqProjetos = path.join(pasta, 'projetos.json');
const arqPedidos = path.join(pastaEstado, 'aparelhos-pedidos.json');
const RE_KID = /^[a-z0-9]{6}$/;
const VALIDADE_PEDIDO_MS = 3_600_000; // a mesma do servidor
const INVISIVEIS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const RE_IMPRESSAO = /^[0-9a-f]{16}$/;
const USO = 'Uso: node scripts/configurar-comandos.js --pedidos | --autorizar <kid> <impressão> | --listar | --revogar <kid>';
const PECA_IMPRESSAO = 'Confira a impressão digital mostrada no aparelho e passe-a: --autorizar <kid> <impressão>';
const fmtHora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function sair(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const limpo = (texto) => (typeof texto === 'string' ? texto.replace(INVISIVEIS, '') : '');
const quando = (ms) => (Number.isFinite(ms) ? fmtHora.format(new Date(ms)).replace(',', '') : '?');

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
  const chaves = lerChaves();
  // Pedido de um aparelho já autorizado com a mesma chave não precisa de nada.
  const lista = lerPedidos().filter((p) => chaves[p.kid]?.publica !== p.publica);
  if (!lista.length) {
    console.log('Nenhum pedido de autorização. No aparelho, toque em "Autorizar este aparelho" e em "Pedir autorização";');
    console.log('o pedido chega aqui no ciclo seguinte do coletor e vale por 1 hora.');
    return;
  }
  console.log('Pedidos de autorização (kid, rótulo, impressão digital, pedido em):');
  for (const p of lista) {
    const { impressao } = impressaoDaPublica(p.publica);
    console.log(`${p.kid}  ${limpo(p.rotulo)}  ${impressao}  ${quando(p.criadoEm)}`);
  }
  console.log('Confira se a impressão digital é a que aparece no aparelho e autorize com --autorizar <kid> <impressão>.');
}

// Impressão digital digitada pelo dono: aceita maiúsculas, hífens e espaços; null se não forem 16 hexadecimais.
const normalizarImpressao = (texto) => {
  const normal = typeof texto === 'string' ? texto.toLowerCase().replace(/[\s-]/g, '') : '';
  return RE_IMPRESSAO.test(normal) ? normal : null;
};
const semHifens = (impressao) => impressao.replaceAll('-', '');

function autorizar(kid, impressaoDigitada) {
  if (typeof kid !== 'string' || !RE_KID.test(kid)) sair(`Informe o kid do aparelho (6 letras ou dígitos), como aparece em --pedidos.\n${USO}`);
  // A impressão digital é obrigatória: é ela que garante que a chave gravada é a que o aparelho mostra,
  // mesmo que o servidor troque o pedido (com o mesmo kid) entre --pedidos e --autorizar.
  const conferida = normalizarImpressao(impressaoDigitada);
  if (!conferida) sair(`${PECA_IMPRESSAO}. Nada foi gravado.`);
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
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
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
  if (typeof kid !== 'string' || !RE_KID.test(kid)) sair(`Informe o kid do aparelho (6 letras ou dígitos).\n${USO}`);
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
