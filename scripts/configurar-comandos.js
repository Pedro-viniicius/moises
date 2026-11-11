#!/usr/bin/env node
// Autoriza e revoga os aparelhos que podem mandar comandos ao coletor (PLANO, tarefa 7).
// Uso: node scripts/configurar-comandos.js <rótulo do aparelho>   gera o código de um aparelho novo
//      node scripts/configurar-comandos.js --listar               mostra kid e rótulo dos autorizados
//      node scripts/configurar-comandos.js --revogar <kid>        tira um aparelho (vale sem reiniciar o coletor)
// O código nunca é impresso nem recebido por argumento: vai para codigo-<kid>.txt (permissão 600), para
// você digitar no aparelho e apagar. O coletor guarda só a chave derivada, em chaves-comandos.json (600).
// Pasta: MOISES_PASTA_CONF (padrão ~/.config/moises). Não toca em coletor.env, vercel.env nem senha-painel.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gerarCodigo, derivarChave } from '../collector/assinatura.js';

const pasta = process.env.MOISES_PASTA_CONF || path.join(os.homedir(), '.config/moises');
const arqChaves = path.join(pasta, 'chaves-comandos.json');
const arqProjetos = path.join(pasta, 'projetos.json');
const arqCodigo = (kid) => path.join(pasta, `codigo-${kid}.txt`);
const RE_KID = /^[a-z0-9]{6}$/;
const INVISIVEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const INVISIVEIS = new RegExp(INVISIVEL.source, 'gu');
const MAX_ROTULO = 40;
const USO = 'Uso: node scripts/configurar-comandos.js <rótulo do aparelho> | --listar | --revogar <kid>';

function sair(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

function novo(rotuloBruto) {
  const rotulo = String(rotuloBruto ?? '').trim();
  if (!rotulo || rotulo.startsWith('-') || Array.from(rotulo).length > MAX_ROTULO || INVISIVEL.test(rotulo)) {
    sair(`Rótulo inválido: de 1 a ${MAX_ROTULO} caracteres visíveis, sem começar com "-".\n${USO}`);
  }
  const chaves = lerChaves();
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  let codigo;
  let derivada;
  do {
    codigo = gerarCodigo();
    derivada = derivarChave(codigo);
  } while (Object.hasOwn(chaves, derivada.kid) || fs.existsSync(arqCodigo(derivada.kid)));
  const { kid } = derivada;
  // O código vai primeiro para o arquivo dele; se a chave não puder ser gravada, o arquivo sai.
  try {
    criar600(arqCodigo(kid), `${codigo}\n`);
  } catch (err) {
    sair(`Não foi possível gravar ${arqCodigo(kid)} (${err?.code || 'erro'}); nada foi alterado.`);
  }
  try {
    chaves[kid] = { rotulo, chave: derivada.chave.toString('hex'), criadaEm: new Date().toISOString() };
    gravarChaves(chaves);
  } catch (err) {
    fs.rmSync(arqCodigo(kid), { force: true });
    sair(`Não foi possível gravar ${arqChaves} (${err?.code || 'erro'}); nada foi alterado.`);
  }
  try {
    criar600(arqProjetos, '{}\n');
  } catch (err) {
    if (err?.code !== 'EEXIST') console.error(`Aviso: não foi possível criar ${arqProjetos} (${err?.code || 'erro'}).`);
  }
  console.log(`Aparelho autorizado: kid ${kid}.`);
  console.log(`Chaves dos aparelhos: ${arqChaves}`);
  console.log(`Código do aparelho: ${arqCodigo(kid)}`);
  console.log(`Lista de projetos: ${arqProjetos}`);
  console.log('Digite o código no aparelho e apague o arquivo.');
}

function listar() {
  const chaves = lerChaves();
  const kids = Object.keys(chaves).filter((k) => RE_KID.test(k));
  if (!kids.length) {
    console.log('Nenhum aparelho autorizado.');
    return;
  }
  for (const kid of kids) {
    const rotulo = typeof chaves[kid]?.rotulo === 'string' ? chaves[kid].rotulo.replace(INVISIVEIS, '') : '';
    console.log(`${kid}  ${rotulo}`);
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
  fs.rmSync(arqCodigo(kid), { force: true });
  console.log(`Aparelho ${kid} revogado. Vale no próximo comando, sem reiniciar o coletor.`);
}

const [primeiro, segundo] = process.argv.slice(2);
if (primeiro === '--listar') listar();
else if (primeiro === '--revogar') revogar(segundo);
else if (primeiro === undefined || primeiro.startsWith('-')) sair(USO);
else novo(primeiro);
