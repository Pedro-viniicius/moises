// Rodada de correção 2 (dev B): o coletor e a configuração protegidos das sessões comandadas (SE-M5b),
// sensível além da lista negra (SE-M5a), construtores validados (SE-B1), contadores que falham fechados
// (SE-B2), chaveiro amarrado ao kid da chave pública (SE-B3) e argsExtra sem as flags fixas (SE-B4).
// Tudo em pastas temporárias e com o claude falso: nada lê ~/.config/moises, ~/.local/state/moises nem .env*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orquestrador } from '../collector/orquestrador.js';
import { Coletor, inicioDoProcesso } from '../collector/sessoes.js';
import { Chaveiro, Porteiro } from '../collector/comandos.js';
import { executarEncerrar, reiniciarLimites } from '../collector/encerrar.js';
import { diaLocal } from '../collector/transcript.js';
import * as col from '../collector/assinatura.js';
import { aparelho, assinarCom, gravarChaves } from './fixtures/aparelho.js';

delete process.env.MOISES_COMANDOS;
delete process.env.MOISES_ENCERRAR;

const FALSO = fileURLToPath(new URL('./fixtures/claude-falso.js', import.meta.url));
// Só dígitos no nome: o caminho do registro vai em argsExtra, que o construtor filtra por palavras.
const BASE = path.join(os.tmpdir(), `moises-corr2b-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });
process.env.MOISES_LIMITES_ARQ = path.join(BASE, 'limites-encerrar.json');
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const HOME = os.homedir();
// A raiz real do repositório (a pasta acima de test/), a mesma que o orquestrador protege por padrão.
const RAIZ = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
// Forma da regra de permissão do Claude Code: `~/` para o que fica na pasta pessoal, `//` para caminho absoluto.
const formaDaRegra = (p) => (p.startsWith(HOME + path.sep) ? `~/${path.relative(HOME, p)}` : `/${p}`);
const ERRO_INICIAR = 'Não foi possível iniciar o Claude Code neste computador.';
const SESSAO = 'principal:0123abcd-4567-89ab-cdef-0123456789ab';
const T0 = 1_794_387_000_000;

let casos = 0;
const novaPasta = () => {
  const d = path.join(BASE, `caso-${++casos}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function ate(fn, descricao, ms = 5000) {
  const limite = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > limite) throw new Error(`esperou demais: ${descricao}`);
    await espera(20);
  }
}
const cmd = (tipo, chave = null) => ({ v: 1, kid: 'ab2cd3', id: `c_${crypto.randomBytes(8).toString('hex')}`, tipo, chave, criadoEm: Date.now(), idadeMs: 0 });
const textoDosLogs = (espiao) => espiao.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');

// Uma conta e um projeto; o binário do Claude Code é o falso (com registro) ou um caminho que não existe.
function montar(t, extra = {}, { comFalso = false } = {}) {
  const raiz = novaPasta();
  const principal = path.join(raiz, '.claude');
  for (const s of ['sessions', 'projects']) fs.mkdirSync(path.join(principal, s), { recursive: true });
  const proj = path.join(raiz, 'projeto-a');
  fs.mkdirSync(proj);
  const registro = path.join(raiz, 'registro.json');
  const pastaEstado = path.join(raiz, 'estado');
  const coletor = new Coletor({ dirs: [principal] });
  const orq = new Orquestrador({
    coletor,
    projetos: () => ({ 'projeto-a': proj }),
    pastaEstado,
    claudeBin: comFalso ? FALSO : path.join(raiz, 'nao-existe'),
    argsExtra: [`--system-prompt=registro:${registro}`],
    esperaAberturaMs: 5000,
    esperaRetomarMs: 200,
    ...extra,
  });
  t.after(() => orq.fechar());
  const arqContagem = path.join(pastaEstado, 'abrir.json');
  const abrir = () => orq.executar(cmd('abrir'), { projeto: 'projeto-a', pedido: 'oi' });
  const publicada = (chave) => orq.aplicar(coletor.retrato()).sessoes.find((s) => s.chave === chave);
  return { raiz, principal, proj, registro, pastaEstado, coletor, orq, arqContagem, abrir, publicada };
}

// Orquestrador sem processo nenhum, só para conferir a marcação `sensivel` de um pedido de Bash.
function orquestradorSolto(extra = {}) {
  return new Orquestrador({ coletor: new Coletor({ dirs: [] }), projetos: () => ({}), pastaEstado: path.join(BASE, 'solto'), ...extra });
}
function sensivelDe(orq, comando, ferramenta = 'Bash') {
  const rec = { pendentes: new Map(), initConferido: true, vivo: true, morto: false, filho: { stdin: null } };
  const input = ferramenta === 'Bash' ? { command: comando } : { file_path: comando, old_string: 'a', new_string: 'b' };
  orq.pedidoDeControle(rec, { type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool', tool_name: ferramenta, input } });
  const p = rec.pendentes.get('req_1');
  assert.ok(p, 'o pedido ficou pendente');
  orq.tirarPendente(rec, 'req_1');
  return p.sensivel;
}

// ---------------------------------------------------------------- CA1 (SE-M5b): caminhos protegidos

test('CA1: o --settings nega Read, Edit e Write na raiz do coletor, no systemd do usuário, nos padrões e nos protegidos', async (t) => {
  const extraProtegido = path.join(BASE, 'conf-extra');
  const m = montar(t, { protegidos: [extraProtegido] }, { comFalso: true });
  const r = await m.abrir();
  assert.equal(r.ok, true, r.erro);
  const { argv } = JSON.parse(fs.readFileSync(m.registro, 'utf8'));
  const settings = JSON.parse(argv.find((a) => a.startsWith('--settings=')).slice('--settings='.length));
  assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
  const deny = settings.permissions.deny;
  const caminhos = [
    path.join(HOME, '.config/moises'),
    path.join(HOME, '.ssh'),
    path.join(HOME, '.local/state/moises'),
    path.join(HOME, '.config/systemd/user'),
    RAIZ,
    extraProtegido,
  ];
  for (const p of caminhos) {
    for (const ferramenta of ['Read', 'Edit', 'Write']) assert.ok(deny.includes(`${ferramenta}(${formaDaRegra(p)}/**)`), `${ferramenta} de ${p}: ${JSON.stringify(deny)}`);
  }
  // Caminho absoluto fora da pasta pessoal usa `//` (uma barra só seria relativa ao arquivo de configuração).
  assert.ok(deny.includes(`Read(/${extraProtegido}/**)`));
  assert.ok(deny.every((regra) => /^(Read|Edit|Write)\((~\/|\/\/)[^()]+\/\*\*\)$/.test(regra)), JSON.stringify(deny));
});

test('CA1: Bash que cita a raiz do coletor (sed -i em collector/comandos.js) vem sensível, também com ~ e $HOME', () => {
  const orq = orquestradorSolto();
  assert.equal(sensivelDe(orq, `sed -i 's/JANELA_MS = 120_000/JANELA_MS = 1e12/' ${RAIZ}/collector/comandos.js`), true);
  assert.equal(sensivelDe(orq, `cd ${RAIZ} && git status`), true);
  if (RAIZ.startsWith(HOME + path.sep)) {
    const rel = path.relative(HOME, RAIZ);
    for (const forma of [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`]) {
      assert.equal(sensivelDe(orq, `sed -i 's/a/b/' ${forma}/collector/comandos.js`), true, forma);
    }
  }
  // Pasta vizinha com nome que só começa igual não é a raiz.
  assert.equal(sensivelDe(orq, `ls ${RAIZ}-copia/x`), false);
  assert.equal(sensivelDe(orq, 'ls -la'), false);
});

test('CA1: Bash que cita o systemd do usuário ou um protegido extra vem sensível, nas três formas', () => {
  // Nome que a lista fixa (SENSIVEL) não pega: só o protegido extra marca.
  const extra = path.join(HOME, '.config', 'outro-protegido-de-teste');
  const fora = path.join(BASE, 'fora-de-casa');
  const orq = orquestradorSolto({ protegidos: [extra, fora] });
  for (const c of [
    'cat ~/.config/systemd/user/coletor.service',
    'echo x > $HOME/.config/systemd/user/coletor.service',
    `cp x ${HOME}/.config/systemd/user/outro.service`,
    `rm ${extra}/arquivo`,
    'rm ~/.config/outro-protegido-de-teste/arquivo',
    'rm $HOME/.config/outro-protegido-de-teste/arquivo',
    'rm ${HOME}/.config/outro-protegido-de-teste/arquivo',
    `cat ${fora}/segredo`,
  ]) {
    assert.equal(sensivelDe(orq, c), true, c);
  }
  assert.equal(sensivelDe(orquestradorSolto(), 'rm ~/.config/outro-protegido-de-teste/arquivo'), false, 'sem o protegido extra');
  // Os mesmos caminhos num pedido de Edit também marcam (o Claude Code já nega pela regra deny).
  assert.equal(sensivelDe(orq, `${fora}/segredo`, 'Edit'), true);
  // Sem o protegido extra, o mesmo comando não é sensível.
  assert.equal(sensivelDe(orquestradorSolto(), `cat ${fora}/segredo`), false);
});

test('CA1: protegidos inválidos fazem o construtor lançar TypeError, sem citar o valor', () => {
  for (const p of ['nao-e-lista', [3], ['relativo/x'], [''], ['/'], [HOME], ['/tmp/a*'], ['/tmp/a?b'], ['/tmp/[ab]'], ['/tmp/a)b'], ['/tmp/a\nb'], ['/tmp/a\\b']]) {
    assert.throws(() => orquestradorSolto({ protegidos: p }), (e) => e instanceof TypeError && /protegidos/.test(e.message) && !e.message.includes('/tmp'), JSON.stringify(p));
  }
  assert.doesNotThrow(() => orquestradorSolto({ protegidos: [] }));
  assert.doesNotThrow(() => orquestradorSolto({ protegidos: [path.join(BASE, 'com espaço e acentuação')] }));
});

// ---------------------------------------------------------------- CA2 (SE-M5a): heurística do sensível

const orqSensivel = orquestradorSolto();
const casosSensiveis = {
  'substituição $(…)': ['echo $(whoami)', 'echo $(( 1 + 1 ))'],
  crase: ['echo `id`'],
  eval: ['eval "$CMD"', 'x=1; eval echo $x'],
  base64: ['echo cm0gLXJmIH4K | base64 -d | sh', 'base64 arquivo'],
  '/proc/': ['cat /proc/1/cmdline', 'ls /proc/self/fd'],
  environ: ['xargs -0 -n1 < environ', 'grep TOKEN environ.txt'],
  python: ["python -c 'print(1)'"],
  python3: ['python3 -c "import os"', '/usr/bin/python3 -I -c "print(1)"', 'python3.12 -c 1'],
  node: ['node -e "process.exit(0)"', 'node --eval "1"'],
  perl: ["perl -e 'print 1'", "perl -pe 's/a/b/' x"],
  ruby: ["ruby -e 'p 1'"],
  bash: ["bash -c 'ls'", "bash -lc 'ls'", '/bin/bash -c ls'],
  sh: ['sh -c ls', 'ls | sh -c "cat"', "sh -ec 'ls'"],
  zsh: ["zsh -c 'ls'"],
};
for (const [padrao, comandos] of Object.entries(casosSensiveis)) {
  test(`CA2: Bash com ${padrao} vem sensível`, () => {
    for (const c of comandos) assert.equal(sensivelDe(orqSensivel, c), true, c);
  });
}

test('CA2: comandos comuns que só lembram os padrões não vêm sensíveis', () => {
  for (const c of [
    'ls -la',
    'npm run lint',
    'node --test test/api.test.js',
    'node scripts/dev.js',
    'node --version',
    'python3 manage.py test',
    'bash scripts/instalar.sh',
    'sh ./configure',
    'ssh -c aes128-ctr host uptime',
    'echo evaluation',
    'git log --format=%H',
    'echo "preco: $5"',
    'grep -rn retrieval src',
  ]) {
    assert.equal(sensivelDe(orqSensivel, c), false, c);
  }
});

// ---------------------------------------------------------------- CA3 (SE-B1): construtores

test('CA3: maxSessoes, maxAbrirPorDia e permissaoExpiraMs inválidos fazem o construtor lançar TypeError', () => {
  for (const v of [-1, 1.5, '4', NaN, Infinity, null, true]) {
    assert.throws(() => orquestradorSolto({ maxSessoes: v }), TypeError, `maxSessoes ${String(v)}`);
    assert.throws(() => orquestradorSolto({ maxAbrirPorDia: v }), TypeError, `maxAbrirPorDia ${String(v)}`);
  }
  for (const v of [0, -1, '1000', NaN, Infinity, -Infinity, null]) {
    assert.throws(() => orquestradorSolto({ permissaoExpiraMs: v }), TypeError, `permissaoExpiraMs ${String(v)}`);
  }
  assert.doesNotThrow(() => orquestradorSolto({ maxSessoes: 0, maxAbrirPorDia: 0, permissaoExpiraMs: 0.5 }));
  assert.doesNotThrow(() => orquestradorSolto({ maxSessoes: 50, maxAbrirPorDia: 1000, permissaoExpiraMs: 86_400_000 }));
});

test('CA3: o Porteiro lança TypeError para maxPorMinuto que não é inteiro positivo', () => {
  const d = novaPasta();
  const chaveiro = new Chaveiro({ arquivo: path.join(d, 'chaves.json') });
  const novo = (maxPorMinuto) => new Porteiro({ chaveiro, pastaEstado: path.join(d, 'estado'), auditoria: null, maxPorMinuto });
  for (const v of [0, -1, 1.5, '30', NaN, Infinity, null]) assert.throws(() => novo(v), TypeError, String(v));
  assert.doesNotThrow(() => novo(1));
  assert.doesNotThrow(() => new Porteiro({ chaveiro, pastaEstado: path.join(d, 'estado'), auditoria: null }));
});

test('CA3: com maxSessoes = 0, abrir e retomar são recusados com mensagem clara e nada é iniciado', async (t) => {
  const m = montar(t, { maxSessoes: 0 }, { comFalso: true });
  const erro = 'Abrir e retomar sessões pelo painel estão desligados neste computador (máximo de 0 sessões comandadas).';
  assert.equal((await m.abrir()).erro, erro);
  // Uma sessão encerrada, na pasta do projeto, que seria retomável.
  const id = crypto.randomUUID();
  const pasta = path.join(m.principal, 'projects', '-sessao-de-teste');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${id}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: m.proj, message: { role: 'user', content: 'Primeiro pedido' } }) + '\n');
  m.coletor.reindexar();
  const chave = `principal:${id}`;
  const s = m.publicada(chave);
  assert.equal(s.estado, 'encerrada');
  assert.equal((await m.orq.executar(cmd('retomar', chave), { visto: { projeto: s.projeto, nome: s.nome ?? null } })).erro, erro);
  assert.equal(m.orq.abertas(), 0);
  assert.equal(fs.existsSync(m.registro), false, 'nenhum processo foi iniciado');
  assert.equal(fs.existsSync(m.arqContagem), false, 'nada foi contado');
});

// ---------------------------------------------------------------- CA4 (SE-B2): contadores diários

const TETO_DIA = 'Limite de 20 aberturas e retomadas pelo painel hoje atingido.';
const ONTEM = () => new Date(Date.now() - 2 * 86_400_000);

test('CA4: abrir.json ausente conta zero', async (t) => {
  const m = montar(t);
  assert.equal((await m.abrir()).erro, ERRO_INICIAR, 'passou pelo contador e só não achou o binário');
  assert.deepEqual(JSON.parse(fs.readFileSync(m.arqContagem, 'utf8')), { dia: diaLocal(Date.now()), n: 1 });
});

test('CA4: abrir.json corrompido hoje conta como teto atingido, com erro no log sem o conteúdo', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const conteudo of ['{lixo-CONTEUDO-SECRETO', '[]', 'null', '"x"', JSON.stringify({ dia: diaLocal(Date.now()), n: -2 }), JSON.stringify({ dia: diaLocal(Date.now()), n: 'CONTEUDO-SECRETO' }), JSON.stringify({ n: 1 })]) {
    const m = montar(t);
    fs.mkdirSync(m.pastaEstado, { recursive: true });
    fs.writeFileSync(m.arqContagem, conteudo, { mode: 0o600 });
    assert.equal((await m.abrir()).erro, TETO_DIA, conteudo);
    assert.equal(fs.readFileSync(m.arqContagem, 'utf8'), conteudo, 'o arquivo não é regravado (o teto continua)');
    assert.equal((await m.abrir()).erro, TETO_DIA, `${conteudo}, de novo`);
  }
  const texto = textoDosLogs(logs);
  assert.match(texto, /abrir\.json/);
  assert.ok(!texto.includes('CONTEUDO-SECRETO'), texto);
});

test('CA4: abrir.json corrompido num dia anterior não segura o dia de hoje', async (t) => {
  t.mock.method(console, 'error', () => {});
  const m = montar(t);
  fs.mkdirSync(m.pastaEstado, { recursive: true });
  fs.writeFileSync(m.arqContagem, '{lixo', { mode: 0o600 });
  fs.utimesSync(m.arqContagem, ONTEM(), ONTEM());
  assert.equal((await m.abrir()).erro, ERRO_INICIAR);
  assert.deepEqual(JSON.parse(fs.readFileSync(m.arqContagem, 'utf8')), { dia: diaLocal(Date.now()), n: 1 });
  // E o dia vira: o mesmo arquivo corrompido hoje deixa de segurar amanhã.
  const hoje = montar(t);
  fs.mkdirSync(hoje.pastaEstado, { recursive: true });
  fs.writeFileSync(hoje.arqContagem, '{lixo', { mode: 0o600 });
  assert.equal((await hoje.abrir()).erro, TETO_DIA);
  const amanha = montar(t, { agora: () => Date.now() + 86_400_000 });
  fs.mkdirSync(amanha.pastaEstado, { recursive: true });
  fs.writeFileSync(amanha.arqContagem, '{lixo', { mode: 0o600 });
  assert.equal((await amanha.abrir()).erro, ERRO_INICIAR);
});

test('CA4: abrir.json ilegível conta como teto atingido, com o código do erro no log', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root lê qualquer arquivo');
  const logs = t.mock.method(console, 'error', () => {});
  const m = montar(t);
  fs.mkdirSync(m.pastaEstado, { recursive: true });
  fs.writeFileSync(m.arqContagem, JSON.stringify({ dia: diaLocal(Date.now()), n: 0 }), { mode: 0o600 });
  fs.chmodSync(m.arqContagem, 0o000);
  t.after(() => fs.chmodSync(m.arqContagem, 0o600));
  assert.equal((await m.abrir()).erro, TETO_DIA);
  assert.match(textoDosLogs(logs), /EACCES/);
});

test('CA4: se não conseguir gravar abrir.json, abrir é recusado e o motivo vai para o log', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora a permissão da pasta');
  const logs = t.mock.method(console, 'error', () => {});
  const m = montar(t);
  fs.mkdirSync(m.pastaEstado, { recursive: true, mode: 0o700 });
  fs.chmodSync(m.pastaEstado, 0o500);
  t.after(() => fs.chmodSync(m.pastaEstado, 0o700));
  assert.equal((await m.abrir()).erro, 'Não foi possível registrar a abertura neste computador; nada foi aberto.');
  assert.equal(m.orq.abertas(), 0);
  assert.match(textoDosLogs(logs), /abrir\.json.*EACCES/);
});

// Aponta o arquivo de limites do encerrar para `arq`; no fim do teste, volta ao da pasta BASE.
const LIMITES_PADRAO = process.env.MOISES_LIMITES_ARQ;
function usarLimites(t, arq) {
  process.env.MOISES_LIMITES_ARQ = arq;
  reiniciarLimites();
  t.after(() => {
    process.env.MOISES_LIMITES_ARQ = LIMITES_PADRAO;
    reiniciarLimites();
  });
}
const TETO_ENCERRAR = 'Limite de 5 encerramentos por hora atingido.';

test('CA4: limites do encerrar ausentes contam zero', async (t) => {
  const arq = path.join(novaPasta(), 'limites.json');
  usarLimites(t, arq);
  assert.equal((await executarEncerrar({}, { id: 'e1', chave: null, idadeMs: 0 })).erro, 'Pedido sem sessão válida.');
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')).executados, ['e1']);
});

test('CA4: limites do encerrar corrompidos hoje contam como teto atingido, sem regravar o arquivo', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  for (const conteudo of ['{lixo-CONTEUDO-SECRETO', '[]', '7', JSON.stringify({ executados: 3, recentes: [] }), JSON.stringify({ executados: [], recentes: ['CONTEUDO-SECRETO'] })]) {
    const arq = path.join(novaPasta(), 'limites.json');
    fs.writeFileSync(arq, conteudo, { mode: 0o600 });
    usarLimites(t, arq);
    let chamou = false;
    const r = await executarEncerrar({}, { id: 'e2', chave: SESSAO, idadeMs: 0 }, { kill: () => (chamou = true) });
    assert.equal(r.erro, TETO_ENCERRAR, conteudo);
    assert.equal(chamou, false);
    assert.equal(fs.readFileSync(arq, 'utf8'), conteudo);
  }
  const texto = textoDosLogs(logs);
  assert.match(texto, /encerrar/);
  assert.ok(!texto.includes('CONTEUDO-SECRETO'), texto);
});

test('CA4: limites do encerrar corrompidos num dia anterior não seguram hoje; o dia virar libera', async (t) => {
  t.mock.method(console, 'error', () => {});
  const arq = path.join(novaPasta(), 'limites.json');
  fs.writeFileSync(arq, '{lixo', { mode: 0o600 });
  fs.utimesSync(arq, ONTEM(), ONTEM());
  usarLimites(t, arq);
  assert.equal((await executarEncerrar({}, { id: 'e3', chave: null, idadeMs: 0 })).erro, 'Pedido sem sessão válida.');
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')).executados, ['e3']);

  const hoje = path.join(novaPasta(), 'limites.json');
  fs.writeFileSync(hoje, '{lixo', { mode: 0o600 });
  usarLimites(t, hoje);
  assert.equal((await executarEncerrar({}, { id: 'e4', chave: null, idadeMs: 0 })).erro, TETO_ENCERRAR);
  // Sem reiniciar o coletor: no dia seguinte, o mesmo processo volta a encerrar.
  const amanha = () => Date.now() + 86_400_000;
  assert.equal((await executarEncerrar({}, { id: 'e5', chave: null, idadeMs: 0 }, { agora: amanha })).erro, 'Pedido sem sessão válida.');
  assert.deepEqual(JSON.parse(fs.readFileSync(hoje, 'utf8')).executados, ['e5']);
});

test('CA4: se não conseguir gravar os limites do encerrar, o encerrar é recusado (antes de registrar o id e antes do sinal)', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora a permissão da pasta');
  t.mock.method(console, 'error', () => {});
  const ERRO = 'Não foi possível registrar o pedido de encerrar neste computador; nada foi feito.';
  // 1) A pasta já é só de leitura: nem o id é registrado.
  const d1 = novaPasta();
  usarLimites(t, path.join(d1, 'limites.json'));
  fs.chmodSync(d1, 0o500);
  t.after(() => fs.chmodSync(d1, 0o700));
  assert.equal((await executarEncerrar({}, { id: 'e6', chave: SESSAO, idadeMs: 0 })).erro, ERRO);

  // 2) A pasta fica só de leitura logo antes de gravar o ritmo: o sinal não é mandado.
  const d2 = novaPasta();
  usarLimites(t, path.join(d2, 'limites.json'));
  t.after(() => fs.chmodSync(d2, 0o700));
  const bin = path.join(d2, 'claude');
  fs.symlinkSync(process.execPath, bin); // o nome do processo vira "claude"
  const filho = spawn(bin, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => filho.kill('SIGKILL'));
  await ate(() => inicioDoProcesso(filho.pid) != null, 'processo iniciar');
  await espera(100);
  const coletorFalso = {
    dirs: [path.join(d2, '.claude')],
    registroDe: () => ({ pid: filho.pid, sessionId: SESSAO.split(':')[1], procStart: inicioDoProcesso(filho.pid) }),
    sessaoDe: () => {
      fs.chmodSync(d2, 0o500);
      return null;
    },
  };
  const sinais = [];
  const r = await executarEncerrar(coletorFalso, { id: 'e7', chave: SESSAO, idadeMs: 0 }, { kill: (pid, s) => sinais.push([pid, s]) });
  assert.equal(r.erro, ERRO);
  assert.deepEqual(sinais, []);
});

// ---------------------------------------------------------------- CA5 (SE-B3): chaveiro amarrado

test('CA5: uma só regex de kid (6 hexadecimais minúsculos), exportada por collector/assinatura.js', () => {
  assert.ok(col.RE_KID instanceof RegExp);
  for (const ok of ['ab2cd3', '000000', 'ffffff']) assert.equal(col.RE_KID.test(ok), true, ok);
  for (const ruim of ['AB2CD3', 'zzzzzz', 'ab2cd', 'ab2cd30', 'ab2cdg', ' ab2cd3', 'ab2cd3\n']) assert.equal(col.RE_KID.test(ruim), false, JSON.stringify(ruim));
  const fonte = fs.readFileSync(fileURLToPath(new URL('../collector/comandos.js', import.meta.url)), 'utf8');
  assert.match(fonte, /import \{[^}]*\bRE_KID\b[^}]*\} from '\.\/assinatura\.js'/);
  assert.ok(!/const RE_KID\s*=/.test(fonte), 'comandos.js não tem regex de kid própria');
});

test('CA5: o porteiro recusa por formato o kid que não é hexadecimal', (t) => {
  const d = novaPasta();
  const ap = aparelho(null, 'celular');
  const chavesArq = path.join(d, 'chaves.json');
  gravarChaves(chavesArq, [ap]);
  const porteiro = new Porteiro({ chaveiro: new Chaveiro({ arquivo: chavesArq }), pastaEstado: path.join(d, 'estado'), auditoria: null, agora: () => T0 });
  const comando = (kid) => assinarCom(ap.privada, { v: 1, kid, id: `c_${crypto.randomBytes(8).toString('hex')}`, tipo: 'mensagem', chave: SESSAO, criadoEm: T0, dados: JSON.stringify({ texto: 'oi', visto: { projeto: 'p', nome: null } }) });
  assert.equal(porteiro.conferir(comando('zzzzzz')).motivo, 'formato');
  assert.equal(porteiro.conferir(comando('qqqqqq')).motivo, 'formato');
  assert.equal(porteiro.conferir(comando(ap.kid)).ok, true);
});

test('CA5: o chaveiro ignora a entrada cujo kid não é o derivado da chave pública, com aviso que cita só o kid', (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const d = novaPasta();
  const arq = path.join(d, 'chaves.json');
  const bom = aparelho(null, 'celular-bom');
  // Kid de seis hexadecimais que não é o do par (sorteia de novo na colisão improvável).
  let kidAlheio = 'abcdef';
  while (kidAlheio === bom.kid) kidAlheio = crypto.randomBytes(3).toString('hex');
  const mentiroso = { ...aparelho(null, 'ROTULO-DO-MENTIROSO'), kid: kidAlheio };
  // O mesmo par de outro aparelho autorizado, copiado para um kid diferente.
  const copiado = { ...bom, kid: kidAlheio === 'fedcba' ? '012345' : 'fedcba', rotulo: 'ROTULO-DA-COPIA' };
  gravarChaves(arq, [bom, mentiroso, copiado]);
  const chaveiro = new Chaveiro({ arquivo: arq });
  assert.deepEqual(chaveiro.aparelhos(), [{ kid: bom.kid, rotulo: 'celular-bom' }]);
  assert.equal(chaveiro.obter(mentiroso.kid), null);
  assert.equal(chaveiro.obter(copiado.kid), null);
  const texto = textoDosLogs(logs);
  assert.ok(texto.includes(mentiroso.kid) && texto.includes(copiado.kid), texto);
  for (const segredo of [mentiroso.publica, bom.publica, 'ROTULO-DO-MENTIROSO', 'ROTULO-DA-COPIA']) assert.ok(!texto.includes(segredo), texto);
  // E o comando assinado pelo mentiroso com o kid que ele diz ter não passa.
  const porteiro = new Porteiro({ chaveiro, pastaEstado: path.join(d, 'estado'), auditoria: null, agora: () => T0 });
  const c = assinarCom(mentiroso.privada, { v: 1, kid: mentiroso.kid, id: `c_${crypto.randomBytes(8).toString('hex')}`, tipo: 'interromper', chave: SESSAO, criadoEm: T0, dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  assert.equal(porteiro.conferir(c).motivo, 'aparelho');
});

// ---------------------------------------------------------------- CA6 (SE-B4): argsExtra

test('CA6: argsExtra não aceita nenhuma flag que o coletor já define nos argumentos fixos, nem opção curta', () => {
  const flags = [
    '--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--resume', '--continue', '--fork-session',
    '--session-id', '--permission-mode', '--model', '--fallback-model', '--effort', '--name', '--worktree', '--restricted', '--tools',
    '--strict-mcp-config', '--disable-slash-commands', '--settings', '--max-budget-usd', '--append-system-prompt', '--agents', '--agent',
    '--mcp-config', '--allowedTools', '--disallowedTools', '--add-dir',
  ];
  for (const f of flags) {
    for (const a of [f, `${f}=x`]) assert.throws(() => orquestradorSolto({ argsExtra: [a] }), /argsExtra/, a);
  }
  for (const a of ['-p', '-c', '-r', '-n', '-w', '-d', '-pc', '-rx']) assert.throws(() => orquestradorSolto({ argsExtra: [a] }), /argsExtra/, a);
  // Como valor solto depois de uma flag permitida também não passa.
  assert.throws(() => orquestradorSolto({ argsExtra: ['--system-prompt', '--model=opus'] }), /argsExtra/);
  // O que os testes e o e2e usam continua valendo.
  assert.doesNotThrow(() => orquestradorSolto({ argsExtra: ['--system-prompt=Você é um assistente de teste.'] }));
  assert.doesNotThrow(() => orquestradorSolto({ argsExtra: [`--system-prompt=registro:${path.join(BASE, 'r.json')}`] }));
});
