// Canal de comandos no coletor: chaveiro (chaves por aparelho), porteiro (decide se um comando
// vindo do painel é aceito) e auditoria local. Tudo em pastas temporárias, com segredos sorteados
// aqui e relógio injetado: nada lê ~/.config/moises, ~/.local/state/moises nem .env*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auditoria } from '../collector/auditoria.js';
import { Chaveiro, Porteiro, TIPOS, JANELA_MS, FOLGA_FUTURO_MS, GUARDA_IDS_MS } from '../collector/comandos.js';
import { Ideias } from '../collector/ideias.js';
import { executarEncerrar, reiniciarLimites } from '../collector/encerrar.js';
import * as col from '../collector/assinatura.js';
import * as nav from '../public/assinatura.js';
import { aparelho as novoAparelho, assinarCom } from './fixtures/aparelho.js';

// O ambiente de quem roda os testes não pode desligar o canal por acidente.
delete process.env.MOISES_COMANDOS;

const T0 = 1_794_387_000_000; // início exato de um minuto
const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
const VISTO = { projeto: 'moises', nome: 'sessão de teste' };
const MSG_SECRETA = 'TEXTO-DA-MENSAGEM-que-nao-pode-ir-para-a-auditoria';
const HASH = 'a'.repeat(64);

// Um aparelho do navegador (par ECDSA P-256 gerado por public/assinatura.js), uma vez só.
const doNavegador = await nav.gerarAparelho();

let seq = 0;
const novoId = () => `c_${(++seq).toString(16).padStart(16, '0')}`;

// Aparelho com par de chaves gerado no Node; o kid fixo é o que o arquivo de chaves diz.
const aparelho = (kid, rotulo) => novoAparelho(kid, rotulo);

// chaves-comandos.json no formato que `configurar-comandos.js --autorizar` grava.
function gravarChaves(arquivo, aparelhos, modo = 0o600) {
  const json = {};
  for (const a of aparelhos) json[a.kid] = { rotulo: a.rotulo, publica: a.publica, criadaEm: new Date(T0).toISOString() };
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json), { mode: modo });
  fs.chmodSync(tmp, modo);
  fs.renameSync(tmp, arquivo);
}

// Grava o objeto como está (para entradas fora do formato), também por temporário e rename.
function gravarChavesBrutas(arquivo, json) {
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json), { mode: 0o600 });
  fs.renameSync(tmp, arquivo);
}

const assinar = (privada, cmd) => assinarCom(privada, cmd);
// Assinatura que tem o formato certo (86 caracteres base64url canônicos) mas não confere.
const ASSINATURA_ERRADA = 'A'.repeat(86);

// Monta chaveiro, auditoria e porteiro numa pasta temporária apagada no fim do teste.
function montar(t, { aparelhos, maxPorMinuto, maxRecusasPorMinuto, auditoriaArq, semChaves = false } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const conf = path.join(raiz, 'conf');
  const estado = path.join(raiz, 'estado');
  fs.mkdirSync(conf, { mode: 0o700 });
  fs.mkdirSync(estado, { mode: 0o700 });
  const chavesArq = path.join(conf, 'chaves-comandos.json');
  const aps = aparelhos ?? [aparelho('ab2cd3', 'celular'), aparelho('xy7zw8', 'tablet')];
  if (!semChaves) gravarChaves(chavesArq, aps);
  const relogio = { agora: T0 };
  const agora = () => relogio.agora;
  const audArq = auditoriaArq ?? path.join(estado, 'auditoria.jsonl');
  // As recusas vão para um arquivo ao lado, com o mesmo nome e o sufixo -recusas (achado S21).
  const recusasArq = path.join(path.dirname(audArq), `${path.basename(audArq, '.jsonl')}-recusas.jsonl`);
  const chaveiro = new Chaveiro({ arquivo: chavesArq });
  const auditoria = new Auditoria({ arquivo: audArq, agora, maxRecusasPorMinuto });
  const novoPorteiro = () => new Porteiro({ chaveiro, pastaEstado: estado, auditoria, agora, maxPorMinuto });
  const porteiro = novoPorteiro();
  // Comando de mensagem válido, assinado pelo primeiro aparelho; `campos` substitui antes de assinar.
  const comando = (campos = {}, ap = aps[0]) =>
    assinar(ap.privada, {
      v: 1, kid: ap.kid, id: novoId(), tipo: 'mensagem', chave: SESSAO, criadoEm: relogio.agora,
      dados: JSON.stringify({ texto: MSG_SECRETA, visto: VISTO }), ...campos,
    });
  // `linhas`: aceito, feito e falhou; `recusas`: o arquivo das recusas.
  const linhas = () => lerJsonl(audArq);
  const recusas = () => lerJsonl(recusasArq);
  return { raiz, conf, estado, chavesArq, audArq, recusasArq, aps, relogio, chaveiro, auditoria, porteiro, novoPorteiro, comando, linhas, recusas };
}

const lerJsonl = (arq) =>
  fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const motivo = (r) => (r.ok ? 'aceito' : r.motivo);
const vistosEm = (estado) => JSON.parse(fs.readFileSync(path.join(estado, 'comandos-vistos.json'), 'utf8'));
const semProto = (o) => Object.assign(Object.create(null), o);

test('constantes do contrato', () => {
  assert.deepEqual([...TIPOS], ['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar']);
  assert.equal(JANELA_MS, 120_000);
  assert.equal(FOLGA_FUTURO_MS, 30_000);
  assert.equal(GUARDA_IDS_MS, 600_000);
});

test('recusa comando sem credencial', (t) => {
  const m = montar(t);
  const { assinatura, ...sem } = m.comando();
  for (const cmd of [sem, { ...sem, assinatura: '' }, { ...sem, assinatura: null }, null, undefined, 'texto']) {
    const r = m.porteiro.conferir(cmd);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'sem_credencial');
    assert.equal(typeof r.erro, 'string');
  }
  assert.equal(assinatura.length, 86);
  // Sem credencial, o id nem entra no conjunto de vistos.
  assert.equal(fs.existsSync(path.join(m.estado, 'comandos-vistos.json')), false);
});

test('recusa assinatura feita com outra chave', (t) => {
  const m = montar(t);
  const outra = aparelho().privada;
  const cmd = assinar(outra, { ...m.comando(), assinatura: undefined });
  const r = m.porteiro.conferir(cmd);
  assert.deepEqual([r.ok, r.motivo], [false, 'assinatura']);
  // Assinatura do aparelho certo, mas de outro texto (dados trocados depois de assinar).
  const trocado = { ...m.comando(), dados: JSON.stringify({ texto: 'outro', visto: VISTO }) };
  assert.equal(motivo(m.porteiro.conferir(trocado)), 'assinatura');
  // Assinatura de um aparelho válido, mas com o kid de outro aparelho autorizado.
  const cruzado = { ...m.comando({}, m.aps[1]), kid: m.aps[0].kid };
  assert.equal(motivo(m.porteiro.conferir(cruzado)), 'assinatura');
});

test('recusa aparelho desconhecido', (t) => {
  const m = montar(t);
  const estranho = aparelho('zzzzzz', 'estranho');
  const r = m.porteiro.conferir(m.comando({}, estranho));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'aparelho');
  assert.equal(r.erro, 'Este aparelho não está autorizado neste computador.');
});

test('recusa a assinatura HMAC antiga e a assinatura ECDSA não canônica ou em DER (achado A1)', (t) => {
  const m = montar(t);
  const base = m.comando();
  // HMAC-SHA256 do mesmo texto com uma chave de 32 bytes, como no código do aparelho: 43 caracteres.
  const hmac = crypto.createHmac('sha256', crypto.randomBytes(32)).update(col.textoDoComando(base), 'utf8').digest('base64url');
  assert.equal(motivo(m.porteiro.conferir({ ...base, assinatura: hmac })), 'formato');
  // A assinatura válida, com os bits de enchimento do último caractere trocados: decodifica igual, mas é recusada.
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const outro = m.comando();
  const naoCanonica = outro.assinatura.slice(0, 85) + B64URL[B64URL.indexOf(outro.assinatura[85]) ^ 1];
  assert.equal(motivo(m.porteiro.conferir({ ...outro, assinatura: naoCanonica })), 'assinatura');
  // A mesma assinatura em DER (tamanho variável) nem tem o formato.
  const der = crypto.sign('sha256', Buffer.from(col.textoDoComando(base), 'utf8'), m.aps[0].privada).toString('base64url');
  assert.equal(motivo(m.porteiro.conferir({ ...base, assinatura: der })), 'formato');
  // Nenhuma dessas queimou o id: o comando certo ainda passa.
  assert.equal(motivo(m.porteiro.conferir(outro)), 'aceito');
  assert.equal(motivo(m.porteiro.conferir(base)), 'aceito');
});

test('aparelho com chave pública inválida no arquivo não existe para o porteiro', (t) => {
  t.mock.method(console, 'error', () => {});
  const m = montar(t);
  const json = JSON.parse(fs.readFileSync(m.chavesArq, 'utf8'));
  const bytes = Buffer.from(json.xy7zw8.publica, 'base64url');
  bytes[64] ^= 1; // ponto fora da curva
  json.xy7zw8.publica = bytes.toString('base64url');
  json.qqqqqq = { rotulo: 'formato antigo', chave: 'a'.repeat(64), criadaEm: new Date(T0).toISOString() };
  gravarChavesBrutas(m.chavesArq, json);
  assert.deepEqual(m.chaveiro.aparelhos(), [{ kid: 'ab2cd3', rotulo: 'celular' }]);
  assert.equal(motivo(m.porteiro.conferir(m.comando({}, m.aps[1]))), 'aparelho');
  assert.equal(motivo(m.porteiro.conferir(m.comando({ kid: 'qqqqqq' }))), 'aparelho');
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  // O chaveiro devolve a chave pública como KeyObject, nunca o texto do arquivo.
  const { chave } = m.chaveiro.obter('ab2cd3');
  assert.equal(chave.type, 'public');
  assert.equal(chave.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('recusa versão desconhecida', (t) => {
  const m = montar(t);
  for (const v of [2, 0, '1', null, undefined, 1.5]) {
    assert.equal(motivo(m.porteiro.conferir(m.comando({ v }))), 'formato', `v = ${String(v)}`);
  }
  const { v, ...semV } = m.comando();
  assert.equal(v, 1);
  assert.equal(motivo(m.porteiro.conferir(semV)), 'formato');
});

test('recusa comando expirado (criado há 120 s)', (t) => {
  const m = montar(t);
  const velho = m.comando({ criadoEm: T0 - JANELA_MS });
  const r = m.porteiro.conferir(velho);
  assert.deepEqual([r.ok, r.motivo], [false, 'expirado']);
  // Um milissegundo antes do limite ainda vale.
  assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: T0 - JANELA_MS + 1 }))), 'aceito');
  // O mesmo comando, avaliado mais tarde pelo relógio do coletor, também expira.
  const agoraValido = m.comando();
  m.relogio.agora = T0 + JANELA_MS;
  assert.equal(motivo(m.porteiro.conferir(agoraValido)), 'expirado');
});

test('relógio do aparelho atrasado: com a idade do servidor recente, a recusa manda acertar a hora', (t) => {
  const m = montar(t);
  const ATRASADO = 'O relógio do aparelho está atrasado; acerte a hora e tente de novo.';
  // Datado 5 minutos no passado, mas o servidor diz que chegou há 2 s.
  const atrasado = { ...m.comando({ criadoEm: T0 - 5 * 60_000 }), idadeMs: 2_000 };
  assert.deepEqual(m.porteiro.conferir(atrasado), { ok: false, motivo: 'relogio', erro: ATRASADO });
  // Sem idade, ou com idade que não é número finito, ou já velha: continua expirado.
  for (const idadeMs of [undefined, null, '2000', NaN, Infinity, JANELA_MS, 10 * 60_000]) {
    const r = m.porteiro.conferir({ ...m.comando({ criadoEm: T0 - 5 * 60_000 }), idadeMs });
    assert.deepEqual([r.motivo, r.erro], ['expirado', 'O comando demorou mais de 2 minutos para chegar e não foi executado.'], String(idadeMs));
  }
  assert.equal(m.porteiro.conferir({ ...m.comando({ criadoEm: T0 - 5 * 60_000 }), idadeMs: JANELA_MS - 1 }).erro, ATRASADO);
  // A idade não é assinada: só escolhe a mensagem. Com idade pequena, um comando válido continua
  // aceito e um adiantado continua com o texto de adiantado.
  assert.equal(motivo(m.porteiro.conferir({ ...m.comando(), idadeMs: 1 })), 'aceito');
  const adiantado = m.porteiro.conferir({ ...m.comando({ criadoEm: T0 + 31_000 }), idadeMs: 1 });
  assert.deepEqual([adiantado.motivo, adiantado.erro], ['relogio', 'O relógio do aparelho está adiantado; acerte a hora e tente de novo.']);
  // O recusado por atraso não queima o id nem gasta o teto (nunca volta a valer) e fica na auditoria.
  assert.ok(!(atrasado.id in vistosEm(m.estado)));
  assert.deepEqual(m.recusas()[0], {
    em: new Date(T0).toISOString(), id: atrasado.id, tipo: 'mensagem', sessao: SESSAO, quem: 'ab2cd3 (celular)',
    kidInformado: 'ab2cd3', decisao: 'recusado', motivo: 'relogio', resultado: null,
  });
});

test('porteiro e auditoria fecham para 700 a pasta de estado que já existia aberta', (t) => {
  const m = montar(t);
  fs.chmodSync(m.estado, 0o775);
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  assert.equal(fs.statSync(m.estado).mode & 0o777, 0o700);
  // Só a auditoria, numa pasta própria.
  const outra = path.join(m.raiz, 'aberta');
  fs.mkdirSync(outra);
  fs.chmodSync(outra, 0o755);
  new Auditoria({ arquivo: path.join(outra, 'auditoria.jsonl'), agora: () => T0 }).registrar({ id: 'c_1', decisao: 'recusado', motivo: 'formato' });
  assert.equal(fs.statSync(outra).mode & 0o777, 0o700);
  // Pasta criada do zero com umask frouxa nasce 700.
  const antiga = process.umask(0o002);
  try {
    const nova = path.join(m.raiz, 'nova', 'estado');
    const p = new Porteiro({ chaveiro: m.chaveiro, pastaEstado: nova, auditoria: null, agora: () => m.relogio.agora });
    assert.equal(motivo(p.conferir(m.comando())), 'aceito');
    assert.equal(fs.statSync(nova).mode & 0o777, 0o700);
  } finally {
    process.umask(antiga);
  }
});

test('ideias e limites do encerrar criam pasta 700 e arquivo 600, mesmo com umask frouxa', async (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const antiga = process.umask(0o002);
  const limitesAntes = process.env.MOISES_LIMITES_ARQ;
  try {
    const estado = path.join(raiz, 'estado');
    const ideias = new Ideias({ pastaEstado: estado, chamar: async () => ({ erro: 'não usado' }), tetoDia: 0 });
    assert.equal(fs.statSync(estado).mode & 0o777, 0o700);
    ideias.salvar();
    assert.equal(fs.statSync(path.join(estado, 'ideias.json')).mode & 0o777, 0o600);
    // Limites do encerrar: um pedido antigo demais já é gravado como executado antes de ser recusado.
    const arqLimites = path.join(raiz, 'outro', 'encerrar.json');
    process.env.MOISES_LIMITES_ARQ = arqLimites;
    reiniciarLimites();
    const r = await executarEncerrar(null, { id: 'c_0000000000000001', idadeMs: -1 });
    assert.equal(r.ok, false);
    assert.equal(fs.statSync(path.dirname(arqLimites)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(arqLimites).mode & 0o777, 0o600);
  } finally {
    process.umask(antiga);
    if (limitesAntes === undefined) delete process.env.MOISES_LIMITES_ARQ;
    else process.env.MOISES_LIMITES_ARQ = limitesAntes;
    reiniciarLimites();
  }
});

test('recusa comando com data 31 s no futuro e diz que é o relógio', (t) => {
  const m = montar(t);
  const adiantado = m.comando({ criadoEm: T0 + 31_000 });
  const r = m.porteiro.conferir(adiantado);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'relogio');
  assert.equal(r.erro, 'O relógio do aparelho está adiantado; acerte a hora e tente de novo.');
  // 30 s no futuro ainda é tolerado.
  assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: T0 + FOLGA_FUTURO_MS }))), 'aceito');
  // O comando recusado pelo relógio não pode ser reenviado mais tarde, quando já caberia na folga.
  m.relogio.agora = T0 + 5_000;
  assert.equal(motivo(m.porteiro.conferir(adiantado)), 'repetido');
});

test('o 31º comando com data no futuro é recusado por ritmo', (t) => {
  const m = montar(t);
  for (let i = 0; i < 30; i++) {
    m.relogio.agora = T0 + i * 1_000;
    assert.equal(motivo(m.porteiro.conferir(m.comando({ criadoEm: m.relogio.agora + 31_000 }))), 'relogio', `nº ${i + 1}`);
  }
  m.relogio.agora = T0 + 59_000;
  const r = m.porteiro.conferir(m.comando({ criadoEm: T0 + 10 * 365 * 86_400_000 }));
  assert.deepEqual([r.ok, r.motivo], [false, 'ritmo']);
  // As recusas por relógio gastaram o teto: um comando válido no mesmo minuto também espera.
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'ritmo');
  // Um minuto depois do primeiro, abre uma vaga.
  m.relogio.agora = T0 + 60_000;
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
});

const HORIZONTE_MS = 24 * 3_600_000; // guarda máxima de um id com data no futuro, além de GUARDA_IDS_MS

test('id com data muito no futuro não faz o arquivo de vistos crescer sem limite', (t) => {
  const m = montar(t, { maxPorMinuto: 10_000 });
  const longe = T0 + 100 * 365 * 86_400_000; // cem anos à frente
  const adiantados = [];
  for (let i = 0; i < 50; i++) {
    const c = m.comando({ criadoEm: longe + i });
    adiantados.push(c);
    assert.equal(motivo(m.porteiro.conferir(c)), 'relogio');
  }
  // Guardado até o horizonte de 24 h depois da chegada, não até a data do comando.
  const vistos = vistosEm(m.estado);
  assert.equal(Object.keys(vistos).length, 50);
  for (const c of adiantados) assert.equal(vistos[c.id], T0 + HORIZONTE_MS);
  // Passada só a guarda, eles continuam.
  m.relogio.agora = T0 + GUARDA_IDS_MS + 1;
  const meio = m.comando();
  assert.equal(motivo(m.porteiro.conferir(meio)), 'aceito');
  assert.equal(Object.keys(vistosEm(m.estado)).length, 51);
  // Passados o horizonte e a guarda, a próxima gravação poda todos eles.
  m.relogio.agora = T0 + HORIZONTE_MS + GUARDA_IDS_MS + 1;
  const novo = m.comando();
  assert.equal(motivo(m.porteiro.conferir(novo)), 'aceito');
  assert.deepEqual(Object.keys(vistosEm(m.estado)), [novo.id]);
  // Reenviado depois da poda, continua recusado pelo relógio e volta a ser guardado pelo horizonte.
  assert.equal(motivo(m.novoPorteiro().conferir(adiantados[0])), 'relogio');
  assert.deepEqual(vistosEm(m.estado), { [novo.id]: novo.criadoEm, [adiantados[0].id]: m.relogio.agora + HORIZONTE_MS });
});

test('comando datado 10 min no futuro, recusado, não é aceito quando o relógio alcança a data', (t) => {
  const m = montar(t);
  const adiantado = m.comando({ criadoEm: T0 + 10 * 60_000 });
  assert.equal(motivo(m.porteiro.conferir(adiantado)), 'relogio');
  // Guardado pela própria data, que está dentro do horizonte.
  assert.equal(vistosEm(m.estado)[adiantado.id], T0 + 10 * 60_000);
  // O relógio avança minuto a minuto; a cada passo um comando novo regrava (e poda) o arquivo.
  for (let min = 1; min <= 10; min++) {
    m.relogio.agora = T0 + min * 60_000 + 1;
    assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito', `minuto ${min}`);
  }
  // A data chegou: o comando cabe na validade, mas já tinha sido visto.
  assert.ok(adiantado.id in vistosEm(m.estado));
  assert.equal(motivo(m.porteiro.conferir(adiantado)), 'repetido');
  // Também depois de reiniciar o porteiro, até o fim da validade dele.
  for (const passo of [0, 60_000, JANELA_MS - 2]) {
    m.relogio.agora = T0 + 10 * 60_000 + passo;
    assert.equal(motivo(m.novoPorteiro().conferir(adiantado)), 'repetido', `passo ${passo}`);
  }
  m.relogio.agora = T0 + 10 * 60_000 + JANELA_MS;
  assert.equal(motivo(m.novoPorteiro().conferir(adiantado)), 'expirado');
});

test('arquivo de vistos antigo com data além do horizonte é trazido para o teto', (t) => {
  const m = montar(t);
  const arq = path.join(m.estado, 'comandos-vistos.json');
  const longe = 'c_00000000000000aa';
  const perto = 'c_00000000000000bb';
  // Formato anterior: o id recusado pelo relógio ficava guardado com a data do comando (cem anos).
  fs.writeFileSync(arq, JSON.stringify({ [longe]: T0 + 100 * 365 * 86_400_000, [perto]: T0 + 3_600_000 }), { mode: 0o600 });
  const p = m.novoPorteiro();
  assert.equal(motivo(p.conferir(m.comando())), 'aceito');
  const vistos = vistosEm(m.estado);
  assert.equal(vistos[longe], T0 + HORIZONTE_MS);
  assert.equal(vistos[perto], T0 + 3_600_000, 'dentro do horizonte fica como está');
  m.relogio.agora = T0 + HORIZONTE_MS + GUARDA_IDS_MS + 1;
  assert.equal(motivo(p.conferir(m.comando())), 'aceito');
  assert.ok(!(longe in vistosEm(m.estado)));
});

test('id já visto com data no futuro não regrava o arquivo de vistos nem gasta o teto', (t) => {
  const m = montar(t, { maxPorMinuto: 2 });
  const adiantado = m.comando({ criadoEm: T0 + 31_000 });
  assert.equal(motivo(m.porteiro.conferir(adiantado)), 'relogio');
  const arq = path.join(m.estado, 'comandos-vistos.json');
  const antes = fs.statSync(arq, { bigint: true });
  for (let i = 0; i < 5; i++) {
    m.relogio.agora = T0 + i * 100;
    assert.equal(motivo(m.porteiro.conferir(structuredClone(adiantado))), 'relogio');
  }
  const depois = fs.statSync(arq, { bigint: true });
  // A gravação é por temporário e rename: arquivo regravado teria outro inode.
  assert.equal(depois.ino, antes.ino);
  assert.equal(depois.mtimeNs, antes.mtimeNs);
  assert.deepEqual(vistosEm(m.estado), { [adiantado.id]: T0 + 31_000 });
  // As cinco repetições não gastaram o teto de 2: ainda cabe um comando válido.
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'ritmo');
});

test('aceita uma vez e recusa o mesmo comando repetido', async (t) => {
  const m = montar(t, { aparelhos: [{ kid: doNavegador.kid, rotulo: 'celular do dono', publica: doNavegador.publica }] });
  // Comando assinado de verdade pelo módulo do navegador, com a chave privada não extraível do aparelho.
  const cmd = await nav.assinarComando(doNavegador, { tipo: 'mensagem', chave: SESSAO, dados: { texto: 'oi', visto: VISTO } }, T0);
  const r = m.porteiro.conferir(cmd);
  assert.equal(r.ok, true);
  assert.equal(r.quem, `${doNavegador.kid} (celular do dono)`);
  assert.deepEqual(r.dados, semProto({ texto: 'oi', visto: semProto(VISTO) }));
  // O id foi gravado em disco antes de conferir devolver ok.
  assert.deepEqual(vistosEm(m.estado), { [cmd.id]: T0 });
  const st = fs.statSync(path.join(m.estado, 'comandos-vistos.json'));
  assert.equal(st.mode & 0o777, 0o600);

  const de_novo = m.porteiro.conferir(cmd);
  assert.deepEqual([de_novo.ok, de_novo.motivo], [false, 'repetido']);
  // Uma cópia idêntica, chegando segundos depois, também.
  m.relogio.agora = T0 + 10_000;
  assert.equal(motivo(m.porteiro.conferir(structuredClone(cmd))), 'repetido');
});

test('a repetição é recusada mesmo depois de reiniciar o porteiro', (t) => {
  const m = montar(t);
  const cmd = m.comando();
  assert.equal(motivo(m.porteiro.conferir(cmd)), 'aceito');
  const reiniciado = m.novoPorteiro();
  m.relogio.agora = T0 + 1_000;
  assert.equal(motivo(reiniciado.conferir(cmd)), 'repetido');
  // Também com chaveiro e auditoria novos, como num reinício do serviço.
  const chaveiro = new Chaveiro({ arquivo: m.chavesArq });
  const auditoria = new Auditoria({ arquivo: m.audArq, agora: () => m.relogio.agora });
  const outro = new Porteiro({ chaveiro, pastaEstado: m.estado, auditoria, agora: () => m.relogio.agora });
  assert.equal(motivo(outro.conferir(cmd)), 'repetido');
});

test('300 comandos lixo sem assinatura válida não fazem um comando já executado ser aceito de novo', (t) => {
  t.mock.method(console, 'error', () => {});
  const m = montar(t);
  const executado = m.comando();
  assert.equal(motivo(m.porteiro.conferir(executado)), 'aceito');
  const lixo = [];
  for (let i = 0; i < 300; i++) {
    const base = m.comando();
    const variantes = [
      { ...base, assinatura: ASSINATURA_ERRADA }, // assinatura que não confere, id novo
      { ...base, id: executado.id, assinatura: 'B'.repeat(86) }, // o mesmo id do executado, assinatura errada
      { ...base, kid: 'qqqqqq' }, // aparelho desconhecido
      { ...base, id: `x_${i}` }, // id fora do formato
      (({ assinatura, ...s }) => s)(base), // sem assinatura
    ];
    lixo.push(variantes[i % variantes.length]);
  }
  for (const c of lixo) {
    const r = m.porteiro.conferir(c);
    assert.equal(r.ok, false);
    assert.notEqual(r.motivo, 'ritmo', 'lixo não gasta o limite por minuto');
  }
  // Só o comando executado está guardado: o lixo não entra nem empurra ninguém para fora.
  assert.deepEqual(Object.keys(vistosEm(m.estado)), [executado.id]);
  assert.equal(motivo(m.porteiro.conferir(executado)), 'repetido');
  m.relogio.agora = T0 + 60_000;
  assert.equal(motivo(m.novoPorteiro().conferir(executado)), 'repetido');
});

test('se o arquivo de vistos não puder ser gravado, o comando é recusado', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora a permissão da pasta');
  t.mock.method(console, 'error', () => {});
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-aud-'));
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }));
  const m = montar(t, { auditoriaArq: path.join(fora, 'auditoria.jsonl') });
  fs.chmodSync(m.estado, 0o500);
  try {
    const cmd = m.comando();
    const r = m.porteiro.conferir(cmd);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'interno');
    assert.equal(fs.existsSync(path.join(m.estado, 'comandos-vistos.json')), false);
    // Falha fechada: o mesmo comando não passa nem na segunda tentativa.
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'repetido');
    const [ultima] = m.recusas().slice(-2);
    assert.equal(ultima.decisao, 'recusado');
    assert.equal(ultima.motivo, 'interno');
  } finally {
    fs.chmodSync(m.estado, 0o700);
  }
  // Com a pasta gravável de novo, um comando novo passa.
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
});

test('recusa verbo desconhecido mesmo com assinatura válida', (t) => {
  const m = montar(t);
  for (const tipo of ['apagar', 'executar', 'Mensagem', 'constructor', '__proto__']) {
    const cmd = m.comando({ tipo });
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'verbo', tipo);
  }
  for (const tipo of [undefined, null, 7, '', 'x'.repeat(200)]) {
    assert.equal(motivo(m.porteiro.conferir(m.comando({ tipo }))), 'formato', String(tipo));
  }
});

test('recusa tudo sem chave configurada', (t) => {
  t.mock.method(console, 'error', () => {});
  const m = montar(t, { semChaves: true });
  const estranho = aparelho('ab2cd3', 'x');
  const valido = m.comando({}, estranho);
  // Arquivo ausente.
  assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'sem_chave' });
  assert.deepEqual(m.chaveiro.aparelhos(), []);
  assert.equal(motivo(m.porteiro.conferir(valido)), 'sem_chave');
  assert.equal(motivo(m.porteiro.conferir({})), 'sem_chave');
  // JSON inválido, objeto vazio, lista e entradas fora do formato: nenhuma chave. Inclui a entrada do
  // formato antigo (chave HMAC derivada do código), que não vale mais (achado A1), e chave pública
  // inválida: fora do tamanho, comprimida, não canônica, com prefixo errado ou ponto fora da curva.
  const bytes = Buffer.from(estranho.publica, 'base64url');
  const comPrefixo = (p) => Buffer.concat([Buffer.from([p]), bytes.subarray(1)]).toString('base64url');
  const foraDaCurva = Buffer.from(bytes);
  foraDaCurva[64] ^= 1;
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const naoCanonica = estranho.publica.slice(0, 86) + B64URL[B64URL.indexOf(estranho.publica.at(-1)) ^ 1];
  const comPublica = (publica, kid = 'ab2cd3') => JSON.stringify({ [kid]: { rotulo: 'x', publica, criadaEm: new Date(T0).toISOString() } });
  const conteudos = [
    '{nao é json',
    '{}',
    '[]',
    JSON.stringify({ ab2cd3: { rotulo: 'formato antigo', chave: 'a'.repeat(64) } }),
    comPublica(estranho.publica, 'AB2CD3'),
    comPublica(estranho.publica, 'ab2cd'),
    comPublica(estranho.publica.slice(1)),
    comPublica(`${estranho.publica}A`),
    comPublica(naoCanonica),
    comPublica(comPrefixo(2)),
    comPublica(Buffer.concat([Buffer.from([2]), bytes.subarray(1, 33)]).toString('base64url')),
    comPublica(foraDaCurva.toString('base64url')),
    comPublica(Buffer.alloc(65).toString('base64url')),
    comPublica(7),
    JSON.stringify({ ab2cd3: { rotulo: 'as duas', chave: 'a'.repeat(64), publica: 'x' } }),
    JSON.stringify({ ab2cd3: 'sem objeto' }),
    JSON.stringify({ __proto__: null, ab2cd3: null }),
  ];
  for (const c of conteudos) {
    fs.writeFileSync(m.chavesArq, c, { mode: 0o600 });
    assert.deepEqual(m.chaveiro.aparelhos(), [], c);
    assert.equal(motivo(m.porteiro.conferir(m.comando({}, estranho))), 'sem_chave', c);
  }
  assert.equal(fs.existsSync(path.join(m.estado, 'comandos-vistos.json')), false);
});

test('ignora arquivo de chaves com permissão 644', (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const m = montar(t);
  fs.chmodSync(m.chavesArq, 0o644);
  assert.deepEqual(m.chaveiro.aparelhos(), []);
  assert.equal(m.chaveiro.obter(m.aps[0].kid), null);
  assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'sem_chave' });
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'sem_chave');
  // Um aviso, sem conteúdo do arquivo.
  assert.ok(avisos.mock.callCount() >= 1);
  const texto = avisos.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
  for (const a of m.aps) {
    assert.ok(!texto.includes(a.publica));
    assert.ok(!texto.includes(a.rotulo));
  }
  // Permissão 640 também é aberta demais.
  fs.chmodSync(m.chavesArq, 0o640);
  assert.deepEqual(m.chaveiro.aparelhos(), []);
  // Voltando a 600, as chaves valem sem reiniciar.
  fs.chmodSync(m.chavesArq, 0o600);
  assert.deepEqual(m.chaveiro.aparelhos(), [{ kid: 'ab2cd3', rotulo: 'celular' }, { kid: 'xy7zw8', rotulo: 'tablet' }]);
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
});

test('recusa tudo com MOISES_COMANDOS=0', (t) => {
  const m = montar(t);
  process.env.MOISES_COMANDOS = '0';
  try {
    assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'desligado' });
    const cmd = m.comando();
    const r = m.porteiro.conferir(cmd);
    assert.deepEqual([r.ok, r.motivo], [false, 'desligado']);
    assert.equal(motivo(m.porteiro.conferir({})), 'desligado');
    assert.equal(fs.existsSync(path.join(m.estado, 'comandos-vistos.json')), false);
    // Religado, o mesmo comando passa: a recusa por desligado não o queimou.
    process.env.MOISES_COMANDOS = '1';
    assert.deepEqual(m.porteiro.ativo(), { ativa: true, motivo: null });
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'aceito');
  } finally {
    delete process.env.MOISES_COMANDOS;
  }
});

test('recusa dados fora da tabela do verbo', (t) => {
  const m = montar(t, { maxPorMinuto: 1000 });
  const abrir = { projeto: 'moises', pedido: 'faça a tarefa' };
  const casos = [
    ['abrir', null, { ...abrir, extra: 1 }, 'campo extra'],
    ['abrir', null, { ...abrir, pedido: '' }, 'pedido vazio'],
    ['abrir', null, { ...abrir, modoPermissao: 'bypassPermissions' }, 'modo bypass'],
    ['abrir', null, { ...abrir, nome: '-x' }, 'nome começando com -'],
    ['abrir', null, { ...abrir, worktree: 'x' }, 'worktree não booleano'],
    ['mensagem', SESSAO, { texto: 'oi' }, 'mensagem sem visto'],
    ['permissao', SESSAO, { pedido: 'req_1', decisao: 'aprovar', visto: VISTO }, 'aprovar sem vistoHash'],
    ['mensagem', SESSAO, '{"__proto__":{"admin":true},"texto":"oi","visto":{"projeto":"moises","nome":null}}', 'dados com __proto__'],
    ['mensagem', SESSAO, '{"texto":"oi","visto":{"__proto__":{},"projeto":"moises","nome":null}}', 'visto com __proto__'],
    // Outros cantos da tabela.
    ['abrir', null, { pedido: 'x' }, 'abrir sem projeto'],
    ['abrir', null, { ...abrir, projeto: '../etc' }, 'projeto com barra'],
    ['abrir', null, { ...abrir, pedido: 'x'.repeat(6001) }, 'pedido longo'],
    ['abrir', null, { ...abrir, modelo: 'gpt' }, 'modelo fora da lista'],
    ['abrir', null, { ...abrir, esforco: 'ultra' }, 'esforço fora da lista'],
    ['abrir', null, { ...abrir, conta: '../x' }, 'conta fora do formato'],
    ['abrir', null, { ...abrir, nome: 'a'.repeat(61) }, 'nome longo'],
    ['mensagem', SESSAO, { texto: '', visto: VISTO }, 'texto vazio'],
    ['mensagem', SESSAO, { texto: 'x'.repeat(6001), visto: VISTO }, 'texto longo'],
    ['mensagem', SESSAO, { texto: 7, visto: VISTO }, 'texto não string'],
    ['mensagem', SESSAO, { texto: 'oi', visto: { ...VISTO, extra: 1 } }, 'visto com campo extra'],
    ['mensagem', SESSAO, { texto: 'oi', visto: { projeto: 'moises' } }, 'visto sem nome'],
    ['mensagem', SESSAO, { texto: 'oi', visto: { projeto: 'moises', nome: 3 } }, 'visto.nome número'],
    ['mensagem', SESSAO, { texto: 'oi', visto: { projeto: 'x'.repeat(201), nome: null } }, 'visto.projeto longo'],
    ['mensagem', SESSAO, { texto: 'oi', visto: [] }, 'visto lista'],
    ['mensagem', SESSAO, { texto: 'oi', visto: null }, 'visto nulo'],
    ['permissao', SESSAO, { pedido: 'req 1', decisao: 'negar', visto: VISTO }, 'pedido com espaço'],
    ['permissao', SESSAO, { pedido: 'req_1', decisao: 'talvez', visto: VISTO }, 'decisão desconhecida'],
    ['permissao', SESSAO, { pedido: 'req_1', decisao: 'aprovar', vistoHash: 'A'.repeat(64), visto: VISTO }, 'vistoHash maiúsculo'],
    ['permissao', SESSAO, { pedido: 'req_1', decisao: 'aprovar', vistoHash: HASH.slice(1), visto: VISTO }, 'vistoHash curto'],
    ['interromper', SESSAO, {}, 'interromper sem visto'],
    ['interromper', SESSAO, { visto: VISTO, texto: 'x' }, 'interromper com campo extra'],
    ['encerrar', SESSAO, { nome: 'x'.repeat(141), visto: VISTO }, 'nome do log longo'],
    ['retomar', SESSAO, { modoPermissao: 'bypassPermissions', visto: VISTO }, 'retomar com bypass'],
    ['retomar', SESSAO, { visto: VISTO, pedido: 'x' }, 'retomar com campo extra'],
    ['mensagem', SESSAO, 'não é json', 'dados não JSON'],
    ['mensagem', SESSAO, '[]', 'dados lista'],
    ['mensagem', SESSAO, 'null', 'dados nulo'],
    ['mensagem', SESSAO, '"texto"', 'dados string'],
  ];
  for (const [tipo, chave, dados, rotulo] of casos) {
    const cmd = m.comando({ tipo, chave, dados: typeof dados === 'string' ? dados : JSON.stringify(dados) });
    const r = m.porteiro.conferir(cmd);
    assert.deepEqual([r.ok, r.motivo], [false, 'formato'], rotulo);
  }
  // `dados` grande demais é recusado antes da assinatura.
  const grande = m.comando({ dados: JSON.stringify({ texto: 'x'.repeat(8000), visto: VISTO }) });
  assert.equal(motivo(m.porteiro.conferir(grande)), 'formato');
  assert.equal(motivo(m.porteiro.conferir(m.comando({ dados: { texto: 'oi', visto: VISTO } }))), 'formato');
});

test('aceita dados válidos de cada verbo e devolve um objeto novo, sem protótipo, só com os campos da tabela', (t) => {
  const m = montar(t);
  const casos = [
    ['abrir', null, { projeto: 'moises', pedido: 'faça a tarefa' }],
    ['abrir', null, { projeto: 'm.o-i_s3', pedido: 'p', conta: 'trabalho', modelo: 'opus', esforco: 'xhigh', modoPermissao: 'plan', worktree: true, nome: 'moises-teste-1' }],
    ['mensagem', SESSAO, { texto: 'oi\ncom quebra', visto: { projeto: 'moises', nome: null } }],
    ['permissao', SESSAO, { pedido: 'req_1:a.b-c', decisao: 'aprovar', vistoHash: HASH, visto: VISTO }],
    ['permissao', SESSAO, { pedido: 'req_2', decisao: 'negar', visto: VISTO }],
    ['interromper', SESSAO, { visto: VISTO }],
    ['encerrar', SESSAO, { visto: VISTO }],
    ['encerrar', SESSAO, { nome: 'log do dia', visto: VISTO }],
    ['retomar', SESSAO, { visto: VISTO }],
    ['retomar', SESSAO, { modoPermissao: 'acceptEdits', modelo: 'sonnet', esforco: 'low', visto: VISTO }],
  ];
  for (const [tipo, chave, dados] of casos) {
    const r = m.porteiro.conferir(m.comando({ tipo, chave, dados: JSON.stringify(dados) }));
    assert.equal(r.ok, true, `${tipo} ${JSON.stringify(dados)}`);
    assert.equal(Object.getPrototypeOf(r.dados), null);
    if (dados.visto) assert.equal(Object.getPrototypeOf(r.dados.visto), null);
    assert.deepEqual(JSON.parse(JSON.stringify(r.dados)), dados);
  }
});

test('formato é conferido antes da assinatura, inclusive a chave de sessão de cada verbo', (t) => {
  const m = montar(t);
  // chave '' e null assinam igual: a regra por verbo tem de recusar antes.
  const casos = [
    { tipo: 'abrir', chave: '', dados: JSON.stringify({ projeto: 'moises', pedido: 'x' }) },
    { tipo: 'abrir', chave: SESSAO, dados: JSON.stringify({ projeto: 'moises', pedido: 'x' }) },
    { tipo: 'mensagem', chave: null },
    { tipo: 'mensagem', chave: '' },
    { tipo: 'mensagem', chave: undefined },
    { tipo: 'mensagem', chave: 'principal:nao-e-uuid' },
    { tipo: 'mensagem', chave: 'Principal:0123abcd-4567-89ab-cdef-0123456789ab' },
    { id: 'c_0123' },
    { id: 'c_0123456789ABCDEF' },
    { kid: 'AB2CD3' },
    { criadoEm: 1.5 },
    { criadoEm: String(T0) },
    { dados: { texto: 'oi' } },
  ];
  for (const campos of casos) {
    const cmd = m.comando(campos);
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'formato', JSON.stringify(campos));
    // Com assinatura errada, continua sendo formato: a ordem não depende da chave.
    assert.equal(motivo(m.porteiro.conferir({ ...cmd, assinatura: ASSINATURA_ERRADA })), 'formato');
  }
  assert.equal(motivo(m.porteiro.conferir({ ...m.comando(), assinatura: 'curta' })), 'formato');
  assert.equal(motivo(m.porteiro.conferir({ ...m.comando(), assinatura: 42 })), 'formato');
});

test('o limite por minuto conta só comandos com assinatura válida', (t) => {
  t.mock.method(console, 'error', () => {});
  const m = montar(t);
  for (let i = 0; i < 100; i++) {
    const cmd = { ...m.comando(), assinatura: crypto.randomBytes(64).toString('base64url') };
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'assinatura');
  }
  for (let i = 0; i < 20; i++) assert.equal(motivo(m.porteiro.conferir(m.comando({ v: 2 }))), 'formato');
  for (let i = 0; i < 30; i++) assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito', `válido nº ${i + 1}`);
});

test('recusa o 31º comando válido no mesmo minuto', (t) => {
  const m = montar(t);
  for (let i = 0; i < 30; i++) {
    m.relogio.agora = T0 + i * 1_000;
    assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  }
  m.relogio.agora = T0 + 59_000;
  const trigesimoPrimeiro = m.comando();
  const r = m.porteiro.conferir(trigesimoPrimeiro);
  assert.deepEqual([r.ok, r.motivo], [false, 'ritmo']);
  // Um minuto depois do primeiro, abre uma vaga.
  m.relogio.agora = T0 + 60_000;
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'ritmo');
  // O comando recusado pelo ritmo não pode ser reenviado depois por quem guardou a cópia.
  m.relogio.agora = T0 + 90_000;
  assert.equal(motivo(m.porteiro.conferir(trigesimoPrimeiro)), 'repetido');
  // Com o limite configurado menor, vale o configurado.
  const n = montar(t, { maxPorMinuto: 2 });
  assert.equal(motivo(n.porteiro.conferir(n.comando())), 'aceito');
  assert.equal(motivo(n.porteiro.conferir(n.comando())), 'aceito');
  assert.equal(motivo(n.porteiro.conferir(n.comando())), 'ritmo');
});

test('revogar um aparelho no arquivo passa a valer sem reiniciar', (t) => {
  const m = montar(t);
  assert.equal(motivo(m.porteiro.conferir(m.comando({}, m.aps[1]))), 'aceito');
  assert.equal(m.chaveiro.obter('xy7zw8').rotulo, 'tablet');
  // Revoga o tablet, como o configurar-comandos faz (temporário e rename).
  gravarChaves(m.chavesArq, [m.aps[0]]);
  assert.equal(m.chaveiro.obter('xy7zw8'), null);
  assert.deepEqual(m.chaveiro.aparelhos(), [{ kid: 'ab2cd3', rotulo: 'celular' }]);
  assert.equal(motivo(m.porteiro.conferir(m.comando({}, m.aps[1]))), 'aparelho');
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  // Trocar a chave de um aparelho sem mudar o tamanho do arquivo também vale (gravação no mesmo arquivo).
  const nova = aparelho('ab2cd3', 'celular');
  const json = JSON.parse(fs.readFileSync(m.chavesArq, 'utf8'));
  json.ab2cd3.publica = nova.publica;
  fs.writeFileSync(m.chavesArq, JSON.stringify(json));
  // Data explícita: em kernel sem carimbo de tempo fino, duas gravações seguidas podem ter o mesmo mtime.
  fs.utimesSync(m.chavesArq, new Date(T0 + 1_000), new Date(T0 + 1_000));
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'assinatura');
  assert.equal(motivo(m.porteiro.conferir(m.comando({}, nova))), 'aceito');
  // Apagar o arquivo desliga tudo.
  fs.rmSync(m.chavesArq);
  assert.equal(motivo(m.porteiro.conferir(m.comando({}, nova))), 'sem_chave');
});

test('cada comando aceito fica na auditoria com quem, quando, sessão, verbo e decisão', (t) => {
  const m = montar(t);
  m.relogio.agora = T0 + 1_234;
  const cmd = m.comando();
  assert.equal(m.porteiro.conferir(cmd).ok, true);
  const abrir = m.comando({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: MSG_SECRETA }) }, m.aps[1]);
  assert.equal(m.porteiro.conferir(abrir).ok, true);
  const [l1, l2] = m.linhas();
  assert.deepEqual(l1, {
    em: new Date(T0 + 1_234).toISOString(), id: cmd.id, tipo: 'mensagem', sessao: SESSAO,
    quem: 'ab2cd3 (celular)', decisao: 'aceito', motivo: null, resultado: null,
  });
  assert.deepEqual(l2, {
    em: new Date(T0 + 1_234).toISOString(), id: abrir.id, tipo: 'abrir', sessao: null,
    quem: 'xy7zw8 (tablet)', decisao: 'aceito', motivo: null, resultado: null,
  });
});

test('cada recusa fica na auditoria com o motivo', (t) => {
  const m = montar(t);
  const casos = [
    [(({ assinatura, ...s }) => s)(m.comando()), 'sem_credencial'],
    [m.comando({ v: 2 }), 'formato'],
    [m.comando({ tipo: 'apagar' }), 'verbo'],
    [m.comando({}, aparelho('qqqqqq', 'x')), 'aparelho'],
    [{ ...m.comando(), assinatura: ASSINATURA_ERRADA }, 'assinatura'],
    [m.comando({ criadoEm: T0 - JANELA_MS }), 'expirado'],
    [m.comando({ criadoEm: T0 + 31_000 }), 'relogio'],
    [m.comando({ dados: '[]' }), 'formato'],
  ];
  for (const [cmd, esperado] of casos) assert.equal(motivo(m.porteiro.conferir(cmd)), esperado);
  // As recusas ficam no arquivo próprio; o dos aceitos nem é criado.
  assert.deepEqual(m.linhas(), []);
  const linhas = m.recusas();
  assert.equal(linhas.length, casos.length);
  linhas.forEach((l, i) => {
    assert.equal(l.decisao, 'recusado');
    assert.equal(l.motivo, casos[i][1]);
    assert.equal(l.id, casos[i][0].id);
    assert.equal(l.tipo, casos[i][0].tipo);
    assert.equal(l.em, new Date(T0).toISOString());
    assert.deepEqual(Object.keys(l), ['em', 'id', 'tipo', 'sessao', 'quem', 'kidInformado', 'decisao', 'motivo', 'resultado']);
  });
  // Antes da assinatura conferir, `quem` é nulo e o kid que o comando diz ter vai em `kidInformado`;
  // depois, `quem` é kid e rótulo.
  for (const i of [0, 1, 2, 3, 4]) assert.equal(linhas[i].quem, null, casos[i][1]);
  assert.equal(linhas[3].kidInformado, 'qqqqqq');
  assert.equal(linhas[4].kidInformado, 'ab2cd3');
  assert.equal(linhas[6].quem, 'ab2cd3 (celular)');
  assert.equal(linhas[6].kidInformado, 'ab2cd3');
  // kid fora do formato não vai nem para `kidInformado`.
  m.porteiro.conferir(m.comando({ kid: 'AB2CD3' }));
  m.porteiro.conferir({ ...m.comando(), kid: `ab\n${'x'.repeat(100)}`, assinatura: undefined });
  assert.deepEqual(m.recusas().slice(-2).map((l) => [l.motivo, l.quem, l.kidInformado]), [['formato', null, null], ['sem_credencial', null, null]]);
  // Comando que nem é objeto também deixa linha, sem lançar.
  m.porteiro.conferir(null);
  assert.deepEqual(
    (({ em, ...resto }) => resto)(m.recusas().at(-1)),
    { id: null, tipo: null, sessao: null, quem: null, kidInformado: null, decisao: 'recusado', motivo: 'sem_credencial', resultado: null },
  );
  // Repetido e ritmo também.
  const n = montar(t, { maxPorMinuto: 1 });
  const um = n.comando();
  n.porteiro.conferir(um);
  n.porteiro.conferir(um);
  n.porteiro.conferir(n.comando());
  assert.deepEqual(n.linhas().map((l) => l.decisao), ['aceito']);
  assert.deepEqual(n.recusas().map((l) => [l.motivo, l.quem]), [['repetido', 'ab2cd3 (celular)'], ['ritmo', 'ab2cd3 (celular)']]);
});

test('recusas em massa não empurram os aceitos para fora da auditoria', (t) => {
  t.mock.method(console, 'error', () => {});
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const m = montar(t);
  // Auditoria com arquivos pequenos e sem teto de recusas, para girar logo.
  const arq = path.join(raiz, 'auditoria.jsonl');
  const aud = new Auditoria({ arquivo: arq, agora: () => m.relogio.agora, maxBytes: 2_000, maxRecusasPorMinuto: 10_000 });
  const p = new Porteiro({ chaveiro: m.chaveiro, pastaEstado: m.estado, auditoria: aud, agora: () => m.relogio.agora });
  const aceito = m.comando();
  assert.equal(motivo(p.conferir(aceito)), 'aceito');
  for (let i = 0; i < 200; i++) p.conferir({ ...m.comando(), assinatura: ASSINATURA_ERRADA });
  const recusasArq = path.join(raiz, 'auditoria-recusas.jsonl');
  // O arquivo das recusas girou sozinho; o dos aceitos continua com o aceito.
  assert.ok(fs.existsSync(`${recusasArq}.1`));
  assert.ok(!fs.existsSync(`${arq}.1`));
  assert.deepEqual(lerJsonl(arq).map((l) => [l.id, l.decisao]), [[aceito.id, 'aceito']]);
  assert.ok(lerJsonl(recusasArq).every((l) => l.decisao === 'recusado'));
  for (const a of [arq, recusasArq, `${recusasArq}.1`]) assert.equal(fs.statSync(a).mode & 0o777, 0o600, a);
  // O arquivo de recusas pode ser dado explicitamente.
  const outro = path.join(raiz, 'outro', 'r.jsonl');
  const aud2 = new Auditoria({ arquivo: path.join(raiz, 'outro', 'a.jsonl'), arquivoRecusas: outro, agora: () => T0 });
  aud2.registrar({ id: 'c_1', decisao: 'recusado', motivo: 'formato' });
  assert.equal(lerJsonl(outro).length, 1);
});

test('desligar e religar o porteiro', (t) => {
  const m = montar(t);
  assert.deepEqual(m.porteiro.ativo(), { ativa: true, motivo: null });
  m.porteiro.desligar('painel_alterado');
  assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'painel_alterado' });
  const cmd = m.comando();
  const r = m.porteiro.conferir(cmd);
  assert.deepEqual(r, { ok: false, motivo: 'painel_alterado', erro: 'O painel publicado é diferente do código deste computador; comandos desligados.' });
  // Auditado, e o id não foi queimado.
  assert.deepEqual(m.recusas().map((l) => [l.id, l.motivo]), [[cmd.id, 'painel_alterado']]);
  assert.equal(fs.existsSync(path.join(m.estado, 'comandos-vistos.json')), false);
  // MOISES_COMANDOS=0 vem antes do motivo de desligar.
  process.env.MOISES_COMANDOS = '0';
  try {
    assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'desligado' });
    assert.equal(motivo(m.porteiro.conferir(cmd)), 'desligado');
  } finally {
    delete process.env.MOISES_COMANDOS;
  }
  // Desligado vale antes de sem_chave.
  fs.renameSync(m.chavesArq, `${m.chavesArq}.fora`);
  assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'painel_alterado' });
  fs.renameSync(`${m.chavesArq}.fora`, m.chavesArq);
  // Motivo fora do formato ainda desliga (falha fechada), com o motivo genérico.
  for (const ruim of ['Painel', 'x'.repeat(21), '', null, 7, 'a b']) {
    m.porteiro.religar();
    m.porteiro.desligar(ruim);
    assert.deepEqual(m.porteiro.ativo(), { ativa: false, motivo: 'desligado' }, String(ruim));
  }
  // Motivo válido sem texto próprio usa o texto de desligado (inclusive nomes do protótipo).
  for (const m2 of ['outro_motivo', '__proto__', 'constructor']) {
    m.porteiro.desligar(m2);
    assert.deepEqual(m.porteiro.conferir(m.comando()), { ok: false, motivo: m2, erro: 'Os comandos pelo painel estão desligados neste computador.' });
  }
  // Religado, o mesmo comando passa.
  m.porteiro.religar();
  assert.deepEqual(m.porteiro.ativo(), { ativa: true, motivo: null });
  assert.equal(motivo(m.porteiro.conferir(cmd)), 'aceito');
});

test('a auditoria não contém o texto da mensagem', (t) => {
  const m = montar(t);
  const aceito = m.comando();
  m.porteiro.conferir(aceito);
  m.porteiro.concluir(aceito, { ok: true });
  m.porteiro.conferir(m.comando({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: MSG_SECRETA }) }));
  m.porteiro.conferir(m.comando({ dados: JSON.stringify({ texto: MSG_SECRETA, visto: VISTO, extra: 1 }) }));
  m.porteiro.conferir({ ...m.comando(), assinatura: ASSINATURA_ERRADA });
  const bruto = fs.readFileSync(m.audArq, 'utf8') + fs.readFileSync(m.recusasArq, 'utf8');
  assert.equal(m.linhas().length, 3);
  assert.equal(m.recusas().length, 2);
  assert.ok(!bruto.includes(MSG_SECRETA));
  assert.ok(!bruto.includes('"dados"'));
  assert.ok(!bruto.includes(aceito.assinatura));
  for (const a of m.aps) assert.ok(!bruto.includes(a.publica));
  for (const l of m.linhas()) {
    assert.deepEqual(Object.keys(l), ['em', 'id', 'tipo', 'sessao', 'quem', 'decisao', 'motivo', 'resultado']);
  }
  // Texto que vai para a auditoria perde controles e é cortado em 80 caracteres.
  m.auditoria.registrar({ id: `c_\u0000\u001b[31m${'x'.repeat(200)}`, tipo: 'men\nsagem' + String.fromCodePoint(0x202e), chave: 7, quem: 'kid (rótulo\r\n falso)', decisao: 'falhou', resultado: 'y'.repeat(300) });
  const l = m.linhas().at(-1);
  assert.equal(l.id.length, 80);
  assert.ok(l.id.startsWith('c_[31mxxx'));
  assert.equal(l.tipo, 'mensagem');
  assert.equal(l.sessao, '7');
  assert.equal(l.quem, 'kid (rótulo falso)');
  assert.equal(l.resultado, 'y'.repeat(80));
  assert.equal(fs.readFileSync(m.audArq, 'utf8').split('\n').filter(Boolean).length, 4);
});

test('o arquivo de auditoria tem permissão 600', (t) => {
  const m = montar(t);
  m.porteiro.conferir(m.comando());
  m.porteiro.conferir(m.comando({ v: 2 }));
  assert.equal(fs.statSync(m.audArq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(m.recusasArq).mode & 0o777, 0o600);
  // Mesmo com umask permissiva e com um arquivo antigo aberto demais.
  const antiga = process.umask(0);
  try {
    const arq = path.join(m.raiz, 'outra', 'auditoria.jsonl');
    const aud = new Auditoria({ arquivo: arq, agora: () => T0 });
    aud.registrar({ id: 'c_1', tipo: 'mensagem', chave: null, quem: 'k', decisao: 'aceito' });
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(arq)).mode & 0o077, 0);
    fs.chmodSync(arq, 0o644);
    aud.registrar({ id: 'c_2', tipo: 'mensagem', chave: null, quem: 'k', decisao: 'aceito' });
    assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  } finally {
    process.umask(antiga);
  }
});

test('concluir registra feito ou falhou', (t) => {
  const m = montar(t);
  const a = m.comando();
  const b = m.comando({ tipo: 'interromper', dados: JSON.stringify({ visto: VISTO }) }, m.aps[1]);
  m.porteiro.conferir(a);
  m.porteiro.conferir(b);
  m.relogio.agora = T0 + 5_000;
  m.porteiro.concluir(a, { ok: true });
  m.porteiro.concluir(b, { ok: false, erro: 'A sessão mudou desde que você abriu o painel; atualize e tente de novo.' });
  const [, , feito, falhou] = m.linhas();
  assert.deepEqual(feito, {
    em: new Date(T0 + 5_000).toISOString(), id: a.id, tipo: 'mensagem', sessao: SESSAO,
    quem: 'ab2cd3 (celular)', decisao: 'feito', motivo: null, resultado: null,
  });
  assert.equal(falhou.decisao, 'falhou');
  assert.equal(falhou.id, b.id);
  assert.equal(falhou.tipo, 'interromper');
  assert.equal(falhou.quem, 'xy7zw8 (tablet)');
  // Só a primeira frase do erro (até o primeiro ponto, dois-pontos ou quebra de linha).
  assert.equal(falhou.resultado, 'A sessão mudou desde que você abriu o painel; atualize e tente de novo');
  // Fim do stderr de um processo: nada depois da primeira frase vai para a auditoria.
  const casos = [
    ['O Claude Code parou com erro: /home/dono/projeto/segredo.txt não encontrado', 'O Claude Code parou com erro'],
    ['Falha ao abrir\nTraceback em /home/dono/.ssh/id_ed25519', 'Falha ao abrir'],
    [`${'palavra '.repeat(30)}. resto`, 'palavra '.repeat(10)],
    ['. começa com ponto', null],
    ['  espaços antes: resto', 'espaços antes'],
  ];
  for (const [erro, esperado] of casos) {
    m.porteiro.concluir(a, { ok: false, erro });
    const r = m.linhas().at(-1).resultado;
    assert.equal(r, esperado === null ? null : esperado.slice(0, 80).trimEnd(), erro);
    if (r) assert.ok(r.length <= 80);
  }
  // Falhou sem erro e entradas estranhas não lançam.
  m.porteiro.concluir(a, { ok: false });
  assert.equal(m.linhas().at(-1).decisao, 'falhou');
  assert.doesNotThrow(() => m.porteiro.concluir(null, null));
  assert.doesNotThrow(() => m.porteiro.concluir(undefined));
  const ultimas = m.linhas().slice(-2);
  assert.deepEqual(ultimas.map((l) => l.decisao), ['falhou', 'falhou']);
  assert.ok(!fs.readFileSync(m.audArq, 'utf8').includes(MSG_SECRETA));
});

test('concluir de um abrir bem-sucedido registra a sessão criada', (t) => {
  const m = montar(t);
  const NOVA = 'principal:0f0e0d0c-0b0a-4908-8706-050403020100';
  const abrir = m.comando({ tipo: 'abrir', chave: null, dados: JSON.stringify({ projeto: 'moises', pedido: 'p' }) });
  assert.equal(m.porteiro.conferir(abrir).ok, true);
  m.porteiro.concluir(abrir, { ok: true, chaveNova: NOVA });
  assert.deepEqual(m.linhas().map((l) => [l.decisao, l.sessao]), [['aceito', null], ['feito', NOVA]]);
  // Falhou não tem sessão criada; chave fora do formato não entra; outros verbos mantêm a própria chave.
  m.porteiro.concluir(abrir, { ok: false, erro: 'x', chaveNova: NOVA });
  m.porteiro.concluir(abrir, { ok: true, chaveNova: 'principal:nao-e-uuid\n' });
  m.porteiro.concluir(abrir, { ok: true });
  const msg = m.comando();
  m.porteiro.concluir(msg, { ok: true, chaveNova: NOVA });
  assert.deepEqual(m.linhas().slice(2).map((l) => [l.decisao, l.sessao]), [['falhou', null], ['feito', null], ['feito', null], ['feito', SESSAO]]);
});

test('auditoria gira o arquivo ao passar do limite', (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const arq = path.join(raiz, 'auditoria.jsonl');
  const aud = new Auditoria({ arquivo: arq, agora: () => T0, maxBytes: 600 });
  const registrar = (i) => aud.registrar({ id: `c_${String(i).padStart(16, '0')}`, tipo: 'mensagem', chave: SESSAO, quem: 'ab2cd3 (celular)', decisao: 'aceito' });
  for (let i = 0; i < 30; i++) registrar(i);
  // Uma recusa vai para o próprio arquivo e não gira o dos aceitos.
  aud.registrar({ id: 'c_r', decisao: 'recusado', motivo: 'formato' });
  assert.ok(!fs.existsSync(path.join(raiz, 'auditoria-recusas.jsonl.1')));
  assert.equal(fs.readFileSync(path.join(raiz, 'auditoria-recusas.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  const ids = (a) => fs.readFileSync(a, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.ok(fs.existsSync(`${arq}.1`));
  assert.ok(fs.statSync(arq).size <= 600);
  assert.ok(fs.statSync(`${arq}.1`).size <= 600);
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${arq}.1`).mode & 0o777, 0o600);
  // O atual tem as linhas mais novas; o .1, as imediatamente anteriores; as mais velhas foram substituídas.
  const atual = ids(arq);
  const anterior = ids(`${arq}.1`);
  assert.equal(atual.at(-1), 'c_0000000000000029');
  assert.equal(Number(anterior.at(-1).slice(2)) + 1, Number(atual[0].slice(2)));
  assert.ok(!anterior.includes('c_0000000000000000'));
  assert.ok(!fs.existsSync(`${arq}.2`));
});

test('recusas em excesso viram uma linha de resumo', (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const arq = path.join(raiz, 'auditoria.jsonl');
  const arqRecusas = path.join(raiz, 'auditoria-recusas.jsonl');
  let agora = T0;
  const aud = new Auditoria({ arquivo: arq, agora: () => agora });
  const recusar = (i, mot = 'assinatura') => aud.registrar({ id: `c_${i}`, tipo: 'mensagem', chave: null, quem: null, decisao: 'recusado', motivo: mot });
  for (let i = 0; i < 25; i++) {
    agora = T0 + i * 1_000;
    recusar(i, i < 22 ? 'assinatura' : 'formato');
  }
  // Aceitos nunca são suprimidos.
  aud.registrar({ id: 'c_ok', tipo: 'mensagem', chave: null, quem: 'k', decisao: 'aceito' });
  assert.deepEqual(lerJsonl(arq).map((l) => l.id), ['c_ok']);
  assert.equal(lerJsonl(arqRecusas).length, 20);
  // Na primeira chamada do minuto seguinte sai o resumo, com a contagem por motivo, e depois a linha nova.
  agora = T0 + 61_000;
  recusar(99);
  const fim = lerJsonl(arqRecusas).slice(-2);
  assert.deepEqual(fim[0], {
    em: new Date(T0 + 61_000).toISOString(), decisao: 'recusado', motivo: 'suprimidas', resultado: '5 recusas',
    porMotivo: { assinatura: 2, formato: 3 },
  });
  assert.equal(fim[1].id, 'c_99');
  // O limite é por minuto e configurável; motivo fora do formato conta como "outro".
  const arq2 = path.join(raiz, 'outra.jsonl');
  const aud2 = new Auditoria({ arquivo: arq2, agora: () => agora, maxRecusasPorMinuto: 2 });
  for (let i = 0; i < 5; i++) aud2.registrar({ id: `c_${i}`, decisao: 'recusado', motivo: i === 4 ? 'Motivo\nestranho' : 'formato' });
  agora += 60_000;
  aud2.registrar({ id: 'c_x', decisao: 'aceito' });
  const l2 = lerJsonl(path.join(raiz, 'outra-recusas.jsonl'));
  assert.deepEqual(l2.map((l) => l.motivo), ['formato', 'formato', 'suprimidas']);
  assert.equal(l2[2].resultado, '3 recusas');
  assert.deepEqual(l2[2].porMotivo, { formato: 2, outro: 1 });
  assert.deepEqual(lerJsonl(arq2).map((l) => l.id), ['c_x']);
});

test('auditoria nunca lança, nem quando não consegue gravar', (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  // O "arquivo" é uma pasta: a gravação falha.
  const pasta = path.join(raiz, 'sou-pasta');
  fs.mkdirSync(pasta);
  const aud = new Auditoria({ arquivo: pasta, arquivoRecusas: pasta, agora: () => T0 });
  assert.doesNotThrow(() => aud.registrar({ id: 'c_1', decisao: 'aceito', quem: MSG_SECRETA }));
  assert.doesNotThrow(() => aud.registrar({ id: 'c_1', decisao: 'recusado', motivo: 'formato', quem: MSG_SECRETA }));
  assert.doesNotThrow(() => aud.registrar(null));
  assert.doesNotThrow(() => aud.registrar());
  const quebrado = new Auditoria({ arquivo: path.join(raiz, 'a.jsonl'), agora: () => { throw new Error('relógio'); } });
  assert.doesNotThrow(() => quebrado.registrar({ id: 'c_1', decisao: 'aceito' }));
  const texto = avisos.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
  assert.ok(!texto.includes(MSG_SECRETA));
});

test('o conjunto de vistos é podado por tempo, nunca por contagem', (t) => {
  const m = montar(t, { maxPorMinuto: 10_000 });
  const antigos = [];
  for (let i = 0; i < 500; i++) {
    const c = m.comando();
    antigos.push(c);
    assert.equal(motivo(m.porteiro.conferir(c)), 'aceito');
  }
  assert.equal(Object.keys(vistosEm(m.estado)).length, 500);
  m.relogio.agora = T0 + GUARDA_IDS_MS;
  assert.equal(motivo(m.porteiro.conferir(m.comando())), 'aceito');
  assert.equal(Object.keys(vistosEm(m.estado)).length, 501, 'exatamente no limite ainda fica');
  m.relogio.agora = T0 + GUARDA_IDS_MS + 1;
  const novo = m.comando();
  assert.equal(motivo(m.porteiro.conferir(novo)), 'aceito');
  const vistos = vistosEm(m.estado);
  assert.equal(Object.keys(vistos).length, 2);
  assert.ok(novo.id in vistos);
  // O podado já estava expirado, então continua sem valer.
  assert.equal(motivo(m.porteiro.conferir(antigos[0])), 'expirado');
  // Arquivo de vistos inválido ou com entradas fora do formato não derruba o porteiro.
  t.mock.method(console, 'error', () => {});
  const arq = path.join(m.estado, 'comandos-vistos.json');
  fs.writeFileSync(arq, JSON.stringify({ [novo.id]: novo.criadoEm, lixo: 'x', c_0000000000000bad: 'texto' }));
  assert.equal(motivo(m.novoPorteiro().conferir(novo)), 'repetido');
  fs.writeFileSync(arq, '{quebrado');
  assert.doesNotThrow(() => m.novoPorteiro());
});

test('descarregar grava na hora o resumo das recusas suprimidas', (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-canal-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const arq = path.join(raiz, 'auditoria.jsonl');
  const aud = new Auditoria({ arquivo: arq, agora: () => T0 + 5_000, maxRecusasPorMinuto: 2 });
  const linhas = () => lerJsonl(path.join(raiz, 'auditoria-recusas.jsonl'));
  for (let i = 0; i < 6; i++) aud.registrar({ id: `c_${i}`, decisao: 'recusado', motivo: 'assinatura' });
  assert.equal(linhas().length, 2);
  // Sem esperar a virada do minuto (é o que parar() faz ao encerrar o coletor).
  aud.descarregar();
  assert.deepEqual(linhas().at(-1), {
    em: new Date(T0 + 5_000).toISOString(), decisao: 'recusado', motivo: 'suprimidas', resultado: '4 recusas', porMotivo: { assinatura: 4 },
  });
  // Chamar de novo sem nada suprimido não grava outra linha, e o resumo não sai duas vezes.
  aud.descarregar();
  aud.registrar({ id: 'c_ok', decisao: 'aceito' });
  assert.equal(linhas().length, 3);
  assert.equal(linhas().filter((l) => l.motivo === 'suprimidas').length, 1);
  assert.deepEqual(lerJsonl(arq).map((l) => l.id), ['c_ok']);
  // Nunca lança, nem sem conseguir gravar (o "arquivo" é uma pasta).
  t.mock.method(console, 'error', () => {});
  const pasta = path.join(raiz, 'sou-pasta');
  fs.mkdirSync(pasta);
  const quebrada = new Auditoria({ arquivo: pasta, arquivoRecusas: pasta, agora: () => T0, maxRecusasPorMinuto: 0 });
  quebrada.registrar({ id: 'c_1', decisao: 'recusado', motivo: 'formato' });
  assert.doesNotThrow(() => quebrada.descarregar());
});

test('arquivo de vistos corrompido: recusa com interno o comando criado antes do reinício', (t) => {
  const avisos = t.mock.method(console, 'error', () => {});
  const m = montar(t);
  const antigo = m.comando();
  assert.equal(motivo(m.porteiro.conferir(antigo)), 'aceito');
  const arq = path.join(m.estado, 'comandos-vistos.json');
  fs.writeFileSync(arq, '{quebrado');
  // O serviço reinicia 5 s depois: o comando antigo ainda está na validade, mas o registro dele se perdeu.
  m.relogio.agora = T0 + 5_000;
  const reiniciado = m.novoPorteiro();
  const r = reiniciado.conferir(antigo);
  assert.deepEqual([r.ok, r.motivo], [false, 'interno']);
  assert.equal(r.erro, 'Erro interno do coletor; o comando não foi executado.');
  // Qualquer comando criado antes da construção também, mesmo um que nunca foi visto.
  assert.equal(motivo(reiniciado.conferir(m.comando({ criadoEm: T0 + 4_999 }))), 'interno');
  // Um comando novo passa e regrava o arquivo; o antigo continua recusado.
  m.relogio.agora = T0 + 6_000;
  const novo = m.comando();
  assert.equal(motivo(reiniciado.conferir(novo)), 'aceito');
  assert.ok(novo.id in vistosEm(m.estado));
  assert.equal(motivo(reiniciado.conferir(antigo)), 'interno');
  // JSON válido que não é objeto também conta como corrompido.
  fs.writeFileSync(arq, '[1,2]');
  m.relogio.agora = T0 + 7_000;
  assert.equal(motivo(m.novoPorteiro().conferir(m.comando({ criadoEm: T0 + 6_500 }))), 'interno');
  const texto = avisos.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
  assert.ok(!texto.includes('quebrado'));
});

test('arquivo de vistos ilegível: recusa com interno o comando criado antes do reinício', (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora a permissão do arquivo');
  t.mock.method(console, 'error', () => {});
  const m = montar(t);
  const antigo = m.comando();
  assert.equal(motivo(m.porteiro.conferir(antigo)), 'aceito');
  const arq = path.join(m.estado, 'comandos-vistos.json');
  fs.chmodSync(arq, 0o000);
  m.relogio.agora = T0 + 5_000;
  let reiniciado;
  try {
    reiniciado = m.novoPorteiro();
  } finally {
    fs.chmodSync(arq, 0o600);
  }
  assert.equal(motivo(reiniciado.conferir(antigo)), 'interno');
  assert.equal(motivo(reiniciado.conferir(m.comando())), 'aceito');
});

test('arquivo de vistos ausente continua sendo começo limpo', (t) => {
  const m = montar(t);
  m.relogio.agora = T0 + 5_000;
  const p = m.novoPorteiro();
  // Criado antes da construção, mas sem arquivo nenhum: não há registro perdido.
  assert.equal(motivo(p.conferir(m.comando({ criadoEm: T0 }))), 'aceito');
});
