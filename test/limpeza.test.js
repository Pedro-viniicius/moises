// Limpeza do /simplify (refatoração sem mudar comportamento): a gravação atômica com permissão 600 numa
// função só, as constantes do contrato com uma fonte só no coletor (e iguais às do servidor e do painel),
// a chave `conta:id` separada num lugar só, o retrato do orquestrador sem E/S repetida no laço e a
// configuração do coletor em collector/config.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escreverAtomico } from '../collector/auditoria.js';
import * as contrato from '../collector/contrato.js';
import * as orquestrador from '../collector/orquestrador.js';
import * as assinatura from '../collector/assinatura.js';
import * as comandos from '../collector/comandos.js';
import * as encerrar from '../collector/encerrar.js';
import * as config from '../collector/config.js';
import * as indice from '../collector/index.js';
import * as lib from '../api/_lib.js';
import { Coletor, partirChave, dirDaConta } from '../collector/sessoes.js';

// Subpasta própria: pastaSoDoDono nunca pode receber o próprio TMPDIR.
const BASE = path.join(os.tmpdir(), `moises-limpeza-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

let casos = 0;
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const modo = (p) => fs.statSync(p).mode & 0o777;
const temporarios = (pasta) => fs.readdirSync(pasta).filter((n) => n.endsWith('.tmp'));
const fonte = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Troca fs[nome] durante `fn`, contando as chamadas cujo primeiro argumento passa em `filtro`.
function contando(nome, filtro, fn) {
  const original = fs[nome];
  let n = 0;
  fs[nome] = function (...args) {
    if (filtro(args[0])) n++;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    fs[nome] = original;
  }
  return n;
}

// ---------------------------------------------------------------- CA1: escreverAtomico

test('CA1: escreverAtomico cria a pasta (700) que não existe e grava o arquivo com permissão 600', () => {
  const pasta = path.join(novaPasta(), 'a', 'b');
  const arq = path.join(pasta, 'dados.json');
  escreverAtomico(arq, '{"n":1}');
  assert.equal(fs.readFileSync(arq, 'utf8'), '{"n":1}');
  assert.equal(modo(arq), 0o600);
  assert.equal(modo(pasta), 0o700);
  assert.deepEqual(temporarios(pasta), []);
});

test('CA1: escreverAtomico substitui o conteúdo, fecha a pasta aberta demais e deixa 600 num arquivo antes mais aberto', () => {
  const pasta = novaPasta();
  fs.chmodSync(pasta, 0o755);
  const arq = path.join(pasta, 'dados.json');
  fs.writeFileSync(arq, 'antigo e mais comprido', { mode: 0o644 });
  escreverAtomico(arq, 'novo');
  assert.equal(fs.readFileSync(arq, 'utf8'), 'novo');
  assert.equal(modo(arq), 0o600);
  assert.equal(modo(pasta), 0o700, 'pastaSoDoDono fecha a pasta do usuário');
  assert.deepEqual(temporarios(pasta), []);
});

test('CA1: escreverAtomico faz fsync só quando pedido', () => {
  const arq = path.join(novaPasta(), 'vistos.json');
  assert.equal(contando('fsyncSync', () => true, () => escreverAtomico(arq, '{}')), 0);
  assert.equal(contando('fsyncSync', () => true, () => escreverAtomico(arq, '{}', { fsync: true })), 1);
});

test('CA1: no erro, escreverAtomico apaga o temporário e relança o erro original', () => {
  const pasta = novaPasta();
  const arq = path.join(pasta, 'alvo');
  fs.mkdirSync(arq); // rename de arquivo sobre uma pasta falha
  assert.throws(() => escreverAtomico(arq, 'x'), (err) => err.code === 'EISDIR' && err.syscall === 'rename');
  assert.deepEqual(temporarios(pasta), [], 'nenhum temporário ficou para trás');
  assert.ok(fs.statSync(arq).isDirectory(), 'o destino ficou como estava');
});

test('CA1: escreverAtomico não escreve através de um link deixado no lugar do temporário', () => {
  const pasta = novaPasta();
  const arq = path.join(pasta, 'chaves.json');
  const alheio = path.join(pasta, 'alheio.txt');
  fs.writeFileSync(alheio, 'intacto');
  fs.symlinkSync(alheio, `${arq}.${process.pid}.tmp`);
  escreverAtomico(arq, 'novo', { fsync: true });
  assert.equal(fs.readFileSync(alheio, 'utf8'), 'intacto');
  assert.equal(fs.readFileSync(arq, 'utf8'), 'novo');
  assert.equal(fs.lstatSync(arq).isFile(), true);
});

test('CA1: as cinco gravações do coletor e a do script usam escreverAtomico', () => {
  const usos = {
    'collector/index.js': 1,
    'collector/comandos.js': 1,
    'collector/orquestrador.js': 1,
    'collector/encerrar.js': 1,
    'collector/ideias.js': 1,
    'scripts/configurar-comandos.js': 1,
  };
  for (const [arquivo, n] of Object.entries(usos)) {
    const src = fonte(arquivo);
    assert.equal((src.match(/\bescreverAtomico\(/g) ?? []).length, n, arquivo);
    assert.doesNotMatch(src, /renameSync\(/, `${arquivo} não renomeia por conta própria`);
  }
  assert.match(fonte('collector/comandos.js'), /escreverAtomico\(.*\{ fsync: true \}\);/, 'vistos com fsync');
  assert.match(fonte('scripts/configurar-comandos.js'), /escreverAtomico\(.*\{ fsync: true \}\);/, 'chaves com fsync');
});

// ---------------------------------------------------------------- CA2: contrato com uma fonte só

test('CA2: collector/contrato.js tem os seis verbos, as listas e as regex do contrato', () => {
  assert.deepEqual(contrato.TIPOS, ['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar']);
  assert.ok(Object.isFrozen(contrato.TIPOS));
  assert.deepEqual(contrato.MODELOS, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual(contrato.ESFORCOS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(contrato.MODOS, ['manual', 'acceptEdits', 'plan']);
  assert.equal(contrato.RE_KID.source, '^[0-9a-f]{6}$');
  assert.equal(contrato.RE_ASSINATURA.source, '^[A-Za-z0-9_-]{86}$');
  const m = contrato.RE_CHAVE.exec('principal:4e00abb1-1234-4abc-8def-0123456789ab');
  assert.deepEqual(m && [...m], ['principal:4e00abb1-1234-4abc-8def-0123456789ab', 'principal', '4e00abb1-1234-4abc-8def-0123456789ab']);
  const casos = [[{}, true], [Object.create(null), true], [null, false], [[], false], ['x', false], [1, false], [undefined, false]];
  casos.forEach(([v, esperado], i) => assert.equal(contrato.objetoSimples(v), esperado, `caso ${i}`));
});

test('CA2: os módulos que exportavam as constantes reexportam as do contrato (o mesmo objeto)', () => {
  for (const nome of ['MODELOS', 'ESFORCOS', 'MODOS', 'RE_CHAVE']) assert.equal(orquestrador[nome], contrato[nome], `orquestrador.${nome}`);
  for (const nome of ['RE_KID', 'RE_ASSINATURA']) assert.equal(assinatura[nome], contrato[nome], `assinatura.${nome}`);
  assert.equal(comandos.TIPOS, contrato.TIPOS);
});

test('CA2: nenhuma cópia local das constantes do contrato no coletor nem no script', () => {
  const arquivos = ['collector/orquestrador.js', 'collector/comandos.js', 'collector/assinatura.js', 'collector/index.js', 'scripts/configurar-comandos.js'];
  for (const arquivo of arquivos) {
    const src = fonte(arquivo);
    for (const nome of ['TIPOS', 'MODELOS', 'ESFORCOS', 'MODOS', 'RE_CHAVE', 'RE_SESSAO', 'RE_KID', 'RE_ASSINATURA', 'objetoSimples', 'ehObjeto']) {
      assert.doesNotMatch(src, new RegExp(`^(?:export )?const ${nome}\\s*=`, 'm'), `${arquivo}: ${nome}`);
    }
    assert.doesNotMatch(src, /\behObjeto\b|\bRE_SESSAO\b/, arquivo);
  }
  // A lista de verbos do orquestrador é a do contrato, não uma lista escrita no meio do código.
  assert.doesNotMatch(fonte('collector/orquestrador.js'), /\['mensagem', 'permissao'/);
});

test('CA2: o servidor (api/_lib.js) tem os mesmos verbos e regex do coletor', () => {
  assert.deepEqual(lib.TIPOS_CMD, [...contrato.TIPOS]);
  assert.equal(lib.RE_KID.source, contrato.RE_KID.source);
  assert.equal(lib.RE_KID.flags, contrato.RE_KID.flags);
  assert.equal(lib.RE_ASSINATURA.source, contrato.RE_ASSINATURA.source);
  // A do servidor não tem os grupos que o orquestrador usa; fora os parênteses, é a mesma.
  assert.equal(lib.RE_CHAVE.source, contrato.RE_CHAVE.source.replace(/[()]/g, ''));
  assert.equal(lib.RE_CHAVE.flags, contrato.RE_CHAVE.flags);
  const uuid = '4e00abb1-1234-4abc-8def-0123456789ab';
  const amostras = [`principal:${uuid}`, `trabalho2:${uuid}`, `${'a'.repeat(20)}:${uuid}`, `${'a'.repeat(21)}:${uuid}`, `Principal:${uuid}`,
    `:${uuid}`, `principal:${uuid.toUpperCase()}`, `principal:${uuid}x`, 'principal', ''];
  for (const a of amostras) assert.equal(lib.RE_CHAVE.test(a), contrato.RE_CHAVE.test(a), a);
  for (const a of ['ab2cd3', '000000', 'AB2CD3', 'zzzzzz', 'ab2cd', 'ab2cd30']) assert.equal(lib.RE_KID.test(a), contrato.RE_KID.test(a), a);
});

test('CA2: o RE_KID do painel (public/cofre.js) é o do coletor', () => {
  const m = fonte('public/cofre.js').match(/^const RE_KID = \/(.+)\/([a-z]*);$/m);
  assert.ok(m, 'public/cofre.js define RE_KID');
  assert.equal(m[1], contrato.RE_KID.source);
  assert.equal(m[2], contrato.RE_KID.flags);
});

test('CA2: a API e o painel não importam collector/', () => {
  const pastas = ['api', 'public'];
  for (const pasta of pastas) {
    const dir = fileURLToPath(new URL(`../${pasta}/`, import.meta.url));
    for (const nome of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(dir, nome), 'utf8'), /from\s+['"][^'"]*collector\//, `${pasta}/${nome}`);
    }
  }
});

// ---------------------------------------------------------------- CA3: conta:id

test('CA3: partirChave separa no primeiro ":" e recusa o que não tem conta', () => {
  assert.deepEqual(partirChave('principal:abc'), { conta: 'principal', id: 'abc' });
  assert.deepEqual(partirChave('a:b:c'), { conta: 'a', id: 'b:c' });
  assert.deepEqual(partirChave('a:'), { conta: 'a', id: '' });
  for (const ruim of [':abc', 'semdoispontos', '', null, undefined, 3, { toString: () => 'a:b' }]) assert.equal(partirChave(ruim), null, String(ruim));
});

test('CA3: dirDaConta acha o diretório pelo nome da conta', () => {
  const dirs = ['/home/x/.claude', '/home/x/.claude-trabalho'];
  assert.equal(dirDaConta(dirs, 'principal'), '/home/x/.claude');
  assert.equal(dirDaConta(dirs, 'trabalho'), '/home/x/.claude-trabalho');
  assert.equal(dirDaConta(dirs, 'outra'), undefined);
  assert.equal(dirDaConta([], 'principal'), undefined);
});

test('CA3: sessaoDe e cwdDe devolvem null para chave sem conta, sem ":" ou que não é texto', () => {
  const dir = path.join(novaPasta(), '.claude');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const coletor = new Coletor({ dirs: [dir] });
  for (const ruim of [':abc', 'principa', 'semdoispontos', null, 3]) {
    assert.equal(coletor.sessaoDe(ruim), null, String(ruim));
    assert.equal(coletor.cwdDe(ruim), null, String(ruim));
  }
  assert.equal(coletor.sessaoDe('outra:abc'), null, 'conta desconhecida');
});

test('CA3: encerrar recusa chave sem conta como antes, e a que não é texto sem lançar', async () => {
  encerrar.reiniciarLimites();
  const coletor = { dirs: ['/home/x/.claude'], registroDe: () => assert.fail('não chega ao registro'), sessaoDe: () => null };
  let n = 0;
  const pedido = (chave) => ({ id: `c_${String(++n).padStart(16, '0')}`, chave, nome: null, idadeMs: 0 });
  for (const ruim of [null, '', ':abc', 'semdoispontos', 5, { toString: () => 'principal:abc' }]) {
    assert.deepEqual(await encerrar.executarEncerrar(coletor, pedido(ruim)), { ok: false, erro: 'Pedido sem sessão válida.' }, String(ruim));
  }
  assert.deepEqual(await encerrar.executarEncerrar(coletor, pedido('outra:abc')), { ok: false, erro: 'Conta desconhecida neste computador.' });
});

// ---------------------------------------------------------------- CA4: aplicar sem E/S repetida

test('CA4: lerProjetos lê o arquivo uma vez enquanto ele não muda e entrega cópias', () => {
  const d = novaPasta();
  const arq = path.join(d, 'projetos.json');
  fs.writeFileSync(arq, JSON.stringify({ moises: '/home/x/moises' }));
  let listas;
  const leituras = contando('readFileSync', (a) => a === arq, () => {
    listas = [indice.lerProjetos(arq), indice.lerProjetos(arq), indice.lerProjetos(arq)];
  });
  assert.equal(leituras, 1);
  for (const l of listas) assert.deepEqual(Object.entries(l), [['moises', '/home/x/moises']]);
  listas[0].intruso = '/tmp';
  assert.equal(Object.hasOwn(indice.lerProjetos(arq), 'intruso'), false, 'mexer numa cópia não muda a próxima');

  // Arquivo novo no lugar (rename, como um editor faz): relido.
  fs.writeFileSync(`${arq}.novo`, JSON.stringify({ outro: '/srv/outro' }));
  fs.renameSync(`${arq}.novo`, arq);
  assert.deepEqual(Object.entries(indice.lerProjetos(arq)), [['outro', '/srv/outro']]);
  // Regravado no lugar com outro tamanho: relido.
  fs.writeFileSync(arq, JSON.stringify({ outro: '/srv/outro', mais: '/srv/mais' }));
  assert.deepEqual(Object.keys(indice.lerProjetos(arq)), ['outro', 'mais']);
  // Regravado no lugar com o mesmo tamanho e outra data: relido.
  fs.writeFileSync(arq, JSON.stringify({ outro: '/srv/OUTRO', mais: '/srv/mais' }));
  fs.utimesSync(arq, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(indice.lerProjetos(arq).outro, '/srv/OUTRO');
  // Apagado: lista vazia; recriado: lido de novo.
  fs.rmSync(arq);
  assert.deepEqual(Object.entries(indice.lerProjetos(arq)), []);
  fs.writeFileSync(arq, JSON.stringify({ moises: '/home/x/moises' }));
  assert.deepEqual(Object.entries(indice.lerProjetos(arq)), [['moises', '/home/x/moises']]);
});

// Orquestrador com um coletor de mentira: só `dirs` e `cwdDe` (aplicar não abre processo).
function orquestradorFalso(projetos, pastas) {
  const chamadasCwd = [];
  const coletor = {
    dirs: [],
    cwdDe: (chave) => {
      chamadasCwd.push(chave);
      return pastas[chave] ?? null;
    },
  };
  const orq = new orquestrador.Orquestrador({ coletor, projetos: () => projetos, pastaEstado: path.join(novaPasta(), 'estado') });
  return { orq, chamadasCwd };
}

test('CA4: aplicar resolve a pasta real de cada projeto uma vez por ciclo, não uma vez por sessão encerrada', () => {
  const d = novaPasta();
  const bases = ['a', 'b', 'c'].map((n) => path.join(d, n));
  for (const b of bases) fs.mkdirSync(path.join(b, '.claude', 'worktrees', 'w1'), { recursive: true });
  const projetos = { a: bases[0], b: bases[1], c: bases[2] };
  // Quatro sessões encerradas na worktree do último projeto: a busca passa pelas três bases.
  const pastas = {};
  const sessoes = [];
  for (let i = 0; i < 4; i++) {
    const chave = `principal:0000000${i}-0000-4000-8000-000000000000`;
    pastas[chave] = path.join(bases[2], '.claude', 'worktrees', 'w1');
    sessoes.push({ chave, estado: 'encerrada' });
  }
  const { orq } = orquestradorFalso(projetos, pastas);
  let retrato;
  const resolucoes = contando('realpathSync', (a) => bases.includes(a), () => {
    retrato = orq.aplicar({ sessoes: sessoes.map((s) => ({ ...s })) });
  });
  assert.equal(resolucoes, 3, 'uma por projeto');
  assert.deepEqual(retrato.sessoes.map((s) => s.retomavel), [true, true, true, true]);
  // Sem sessão encerrada, nem a lista de projetos é lida.
  let lidas = 0;
  const { orq: orq2 } = orquestradorFalso(projetos, {});
  orq2.projetos = () => (lidas++, projetos);
  orq2.aplicar({ sessoes: [{ chave: 'principal:x', estado: 'trabalhando' }] });
  assert.equal(lidas, 0);
});

test('CA4: o cache de pastas guarda só as encerradas que seguem no retrato (vale a primeira ocorrência da chave)', () => {
  const d = novaPasta();
  fs.mkdirSync(path.join(d, 'proj'));
  const projetos = { proj: path.join(d, 'proj') };
  const [k1, k2, k3] = ['1', '2', '3'].map((n) => `principal:0000000${n}-0000-4000-8000-000000000000`);
  const pastas = { [k1]: projetos.proj, [k2]: projetos.proj, [k3]: path.join(d, 'fora') };
  const { orq, chamadasCwd } = orquestradorFalso(projetos, pastas);
  const aplicar = (sessoes) => orq.aplicar({ sessoes: sessoes.map((s) => ({ ...s })) }).sessoes;

  let r = aplicar([{ chave: k1, estado: 'encerrada' }, { chave: k2, estado: 'encerrada' }, { chave: k3, estado: 'encerrada' }]);
  assert.deepEqual(r.map((s) => s.retomavel), [true, true, false]);
  assert.deepEqual([...orq.cwdCache.keys()].sort(), [k1, k2, k3]);
  assert.equal(chamadasCwd.length, 3);

  // Mesmo retrato: nada é relido.
  aplicar([{ chave: k1, estado: 'encerrada' }, { chave: k2, estado: 'encerrada' }, { chave: k3, estado: 'encerrada' }]);
  assert.equal(chamadasCwd.length, 3);

  // k1 voltou a trabalhar, k2 saiu do retrato, k3 repetida com a primeira ocorrência não encerrada.
  aplicar([{ chave: k1, estado: 'trabalhando' }, { chave: k3, estado: 'trabalhando' }, { chave: k3, estado: 'encerrada' }]);
  assert.deepEqual([...orq.cwdCache.keys()], [], 'só fica a encerrada cuja primeira ocorrência é encerrada');

  // De volta encerrada: a pasta é consultada de novo.
  r = aplicar([{ chave: k1, estado: 'encerrada' }]);
  assert.equal(r[0].retomavel, true);
  assert.deepEqual([...orq.cwdCache.keys()], [k1]);
  assert.equal(chamadasCwd.filter((k) => k === k1).length, 2);
});

// ---------------------------------------------------------------- CA5, CA6 e CA7

test('CA5: a configuração mora em collector/config.js; index.js a reexporta e o script importa de lá', () => {
  assert.equal(indice.configuracao, config.configuracao);
  assert.equal(indice.caminhosDoColetor, config.caminhosDoColetor);
  const src = fonte('collector/index.js');
  for (const nome of ['valorDaLinha', 'lerConf', 'valorDaChave', 'chaveDeDesligar', 'numeroEntre', 'listaDeFerramentas', 'caminhoDaConf', 'lerLocal']) {
    assert.doesNotMatch(src, new RegExp(`function ${nome}\\(`), `index.js: ${nome}`);
  }
  assert.match(fonte('scripts/configurar-comandos.js'), /import \{ caminhosDoColetor \} from '\.\.\/collector\/config\.js'/);
});

test('CA6: chave de desligar com valor não reconhecido, combinada com cada valor da outra fonte', () => {
  const ler = (nome, ambiente, arquivo) => {
    const d = novaPasta();
    fs.writeFileSync(path.join(d, 'coletor.env'), arquivo === undefined ? '' : `${nome}=${arquivo}\n`, { mode: 0o600 });
    const env = { MOISES_CONF: path.join(d, 'coletor.env') };
    if (ambiente !== undefined) env[nome] = ambiente;
    config.configuracao({ env, home: d, avisar: () => {} });
    return env[nome];
  };
  for (const outro of [undefined, '0', '1', 'talvez']) {
    // Conferência do painel: o lado seguro é ligado, mas uma fonte que desliga de forma reconhecida vale.
    assert.equal(ler('MOISES_CONFERIR_PAINEL', 'talvez', outro), outro === '0' ? '0' : '1', `conferir, arquivo=${outro}`);
    assert.equal(ler('MOISES_CONFERIR_PAINEL', outro, 'talvez'), outro === '0' ? '0' : '1', `conferir, ambiente=${outro}`);
    // As demais: o lado seguro é desligado.
    assert.equal(ler('MOISES_COMANDOS', 'talvez', outro), '0', `comandos, arquivo=${outro}`);
  }
});

test('CA7: as constantes sem uso fora do próprio módulo deixaram de ser exportadas', () => {
  assert.equal('EXPIRA_MS' in encerrar, false);
  assert.equal('EXPIRA_CMD_MS' in lib, false);
  assert.equal('VALIDADE_PEDIDO_APARELHO_MS' in lib, false);
  assert.doesNotMatch(fonte('public/cofre.js'), /export class CofreIndisponivel/);
  assert.match(fonte('public/cofre.js'), /^class CofreIndisponivel extends Error/m);
});
