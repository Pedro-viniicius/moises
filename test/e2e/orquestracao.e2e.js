#!/usr/bin/env node
// Prova de ponta a ponta da orquestração, com o Claude Code de verdade.
// Sobe o painel (scripts/dev.js, Redis em memória) como processo filho e o coletor dentro deste processo,
// cria UMA sessão `moises-teste-…` na pasta sandbox e prova as cinco capacidades do MVP, uma a uma.
// Uso: npm run e2e        (gasta alguns centésimos de dólar com o Haiku)
// Nada daqui lê ~/.config/moises nem fala com o painel publicado: segredos e chave do aparelho são gerados na hora.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX = fs.realpathSync(process.env.MOISES_E2E_SANDBOX || path.join(os.homedir(), 'moises-sandbox'));
const PREFIXO = 'moises-teste-';
const NOME = `${PREFIXO}e2e-${Date.now().toString(36)}`;
const TEMPO_TOTAL_MS = 7 * 60_000;
const VERBOSO = Boolean(process.env.MOISES_E2E_VERBOSO);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const log = (...a) => console.log(...a);

// Trava: a sandbox tem de ser um repositório git próprio, fora dos projetos do dono.
if (!fs.existsSync(path.join(SANDBOX, '.git')) || SANDBOX.startsWith(path.join(os.homedir(), 'Documentos'))) {
  console.error(`Pasta sandbox inválida: ${SANDBOX}. Crie com: mkdir ~/moises-sandbox && cd ~/moises-sandbox && git init`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moises-e2e-'));
const pastaEstado = path.join(tmp, 'estado');
fs.mkdirSync(pastaEstado, { recursive: true });

// O coletor roda neste processo: tira do ambiente tudo o que é do Moisés de produção ou desta sessão do Claude
// e aponta para a pasta temporária o que os módulos do coletor leem do ambiente, antes de importá-los.
for (const k of Object.keys(process.env)) if (/^(CLAUDE|MOISES_|PANEL_|SESSION_SECRET|KV_|UPSTASH_)/.test(k) && k !== 'MOISES_E2E_VERBOSO') delete process.env[k];
Object.assign(process.env, {
  MOISES_CONF: path.join(tmp, 'nao-existe.env'),
  MOISES_ESTADO: pastaEstado,
  MOISES_LIMITES_ARQ: path.join(tmp, 'encerrar.json'),
  MOISES_CONFIG_DIRS: path.join(os.homedir(), '.claude'),
  MOISES_IDEIAS_TETO_DIA: '0',
});

const { gerarAparelho, assinarComando, hashVisto } = await import('../../public/assinatura.js');
const { gerarHashSenha } = await import('../../api/_lib.js');
const { rodar } = await import('../../collector/index.js');

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let painel = null;
const saidaPainel = [];
let coletor = null;
const arquivosDeTeste = [];
const resultados = [];
let custo = null;
let falhouAlgum = false;
let idDaSessao = null;

async function parar() {
  try {
    await coletor?.parar();
  } catch (err) {
    console.error(`erro ao parar o coletor: ${err.message}`);
  }
  if (painel && painel.exitCode == null) painel.kill('SIGTERM');
  const limite = Date.now() + 10_000;
  while (painel && Date.now() < limite && painel.exitCode == null && painel.signalCode == null) await espera(200);
  if (painel && painel.exitCode == null && painel.signalCode == null) painel.kill('SIGKILL');
}

function sessoesVivasDoClaude() {
  return JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
}

async function main() {
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const senha = hex(12);
  const token = crypto.randomBytes(32).toString('base64url');

  // Este "aparelho" gera o par ECDSA P-256 como o navegador (a privada não extraível fica só na memória) e a
  // chave pública vai para o arquivo 600 no formato que `configurar-comandos.js --autorizar` grava.
  const aparelho = await gerarAparelho();
  const chavesArq = path.join(tmp, 'chaves-comandos.json');
  fs.writeFileSync(chavesArq, JSON.stringify({ [aparelho.kid]: { rotulo: 'e2e', publica: aparelho.publica, criadaEm: new Date().toISOString() } }), { mode: 0o600 });
  const projetosArq = path.join(tmp, 'projetos.json');
  fs.writeFileSync(projetosArq, JSON.stringify({ 'moises-sandbox': SANDBOX }));

  const envPainel = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR']) if (process.env[k]) envPainel[k] = process.env[k];
  painel = spawn(process.execPath, ['scripts/dev.js'], {
    cwd: raiz,
    env: { ...envPainel, PORT: String(porta), PANEL_PASSWORD_HASH: gerarHashSenha(senha), SESSION_SECRET: crypto.randomBytes(48).toString('base64url'), MOISES_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const guardaSaida = (d) => {
    saidaPainel.push(String(d));
    if (saidaPainel.length > 200) saidaPainel.shift();
    if (VERBOSO) process.stderr.write(`[painel] ${d}`);
  };
  painel.stdout.on('data', guardaSaida);
  painel.stderr.on('data', guardaSaida);

  // ---------- cliente HTTP, como o navegador ----------
  let cookie = '';
  async function http(metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(corpo ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* resposta sem JSON */ }
    return { status: r.status, j, cabecalhos: r.headers };
  }
  const estado = async () => (await http('GET', '/api/estado')).j;

  // `nota` (opcional) diz o que foi visto por último; vai na mensagem de tempo esgotado, com o último erro.
  async function ate(descricao, fn, ms = 60_000, nota = () => null) {
    const limite = Date.now() + ms;
    let ultimoErro = null;
    while (Date.now() < limite) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (err) {
        ultimoErro = err?.message ?? String(err); // tenta de novo
      }
      await espera(500);
    }
    const extra = [nota(), ultimoErro && `último erro: ${ultimoErro}`].filter(Boolean).join('; ');
    throw new Error(`tempo esgotado esperando: ${descricao}${extra ? ` (${extra})` : ''}`);
  }

  let chave = null;
  const sessao = async () => (await estado()).retrato?.sessoes.find((s) => s.chave === chave) || null;
  const sessaoEm = (pred, descricao, ms) => {
    let visto = 'sessão ausente do painel';
    return ate(descricao, async () => {
      const s = await sessao();
      if (s) {
        const pedidos = (s.permissoes || []).map((p) => `${p.ferramenta}${p.sensivel ? ' sensível' : ''}${p.completo ? '' : ' incompleto'}: ${JSON.stringify(String(p.entrada).slice(0, 80))}`);
        visto = `último estado visto: ${s.estado}; pedidos: ${pedidos.length ? pedidos.join(' | ') : 'nenhum'}`;
      }
      return s && pred(s) ? s : null;
    }, ms, () => visto);
  };
  // O que o cartão mostra agora: vai assinado em todo comando sobre a sessão.
  const visto = async () => {
    const s = await sessao();
    if (!s) throw new Error('a sessão não está no painel');
    return { projeto: s.projeto, nome: s.nome ?? null };
  };

  async function enviar(cmd) {
    const r = await http('POST', '/api/comando', cmd);
    if (r.status !== 200) throw new Error(`POST /api/comando (${cmd.tipo}) respondeu ${r.status}: ${r.j?.erro}`);
    if (VERBOSO) console.error(new Date().toISOString().slice(11, 23), '[e2e] enviado', cmd.tipo, cmd.id);
    return cmd.id;
  }
  const comando = async (tipo, sessaoAlvo, dados) => enviar(await assinarComando(aparelho, { tipo, chave: sessaoAlvo, dados }));
  const comandoTerminou = (id, ms = 60_000) => {
    let visto = 'nenhuma leitura do estado';
    return ate(`comando ${id} terminar`, async () => {
      const cmd = (await estado()).comandos.find((x) => x.id === id);
      const agora = cmd ? `último estado visto: ${cmd.estado}` : 'comando ausente da lista';
      if (VERBOSO && agora !== visto) console.error(new Date().toISOString().slice(11, 23), '[e2e]', id, agora);
      visto = agora;
      return cmd && ['feito', 'falhou', 'recusado', 'expirado'].includes(cmd.estado) ? cmd : null;
    }, ms, () => visto);
  };
  async function comandoFeito(id, ms) {
    const c = await comandoTerminou(id, ms);
    if (c.estado !== 'feito') throw new Error(`comando ${c.tipo} terminou como ${c.estado}: ${c.erro}`);
    return c;
  }
  const mensagem = async (texto) => comandoFeito(await comando('mensagem', chave, { texto, visto: await visto() }));

  async function pedidoDePermissao(trecho) {
    const s = await sessaoEm((x) => x.estado === 'esperando_permissao' && x.permissoes?.some((p) => p.entrada.includes(trecho)), `pedido de permissão com "${trecho}"`, 90_000);
    const p = s.permissoes.find((x) => x.entrada.includes(trecho));
    if (p.ferramenta !== 'Bash') throw new Error(`ferramenta inesperada: ${p.ferramenta}`);
    if (p.completo !== true) throw new Error('o pedido de permissão não veio inteiro (completo: false)');
    return p;
  }
  // Como o painel: a impressão digital sai do texto exibido.
  const responder = async (p, decisao, vistoHash) => comando('permissao', chave, {
    pedido: p.pedido,
    decisao,
    ...(decisao === 'aprovar' ? { vistoHash: vistoHash ?? (await hashVisto(p.ferramenta, p.entrada)) } : {}),
    visto: await visto(),
  });
  const arquivo = (sufixo) => {
    const a = path.join(SANDBOX, `${NOME}-${sufixo}.txt`);
    arquivosDeTeste.push(a);
    return a;
  };

  async function item(n, titulo, fn) {
    try {
      const detalhe = await fn();
      resultados.push(`${n}. ${titulo}: passou${detalhe ? ` (${detalhe})` : ''}`);
    } catch (err) {
      falhouAlgum ||= typeof n === 'number';
      resultados.push(`${n}. ${titulo}: falhou — ${err.message}`);
    }
    log(resultados.at(-1));
  }

  // ---------- preparo ----------
  await ate('painel local responder', async () => (await fetch(base + '/login.html')).ok, 15_000);
  const login = await http('POST', '/api/login', { senha });
  if (login.status !== 200) throw new Error(`login respondeu ${login.status}`);
  cookie = String(login.cabecalhos.get('set-cookie')).split(';')[0];

  coletor = await rodar({
    url: base,
    token,
    pastaEstado,
    chavesArq,
    projetosArq,
    dirs: [path.join(os.homedir(), '.claude')],
    intervaloMs: 1000,
    intervaloRapidoMs: 1000,
    soPrefixo: PREFIXO,
    maxSessoes: 2,
    tetoSessaoUsd: 0.3,
    ideiasTetoDia: 0,
    argsExtra: ['--system-prompt=Você é um assistente de teste. Use a ferramenta Bash exatamente como pedido, sem comentar. Respostas de uma linha.'],
    log: VERBOSO ? (...a) => console.error(new Date().toISOString().slice(11, 23), '[coletor]', ...a) : () => {},
  });
  await ate('coletor mandar o primeiro retrato com a orquestração ativa', async () => (await estado()).retrato?.orquestracao?.ativa === true, 30_000);
  log(`painel local em ${base}; sessão de teste: ${NOME}; sandbox: ${SANDBOX}`);

  // ---------- as cinco capacidades ----------
  await item(1, 'abrir sessão com um pedido', async () => {
    const id = await comando('abrir', null, { projeto: 'moises-sandbox', pedido: 'Responda apenas: pronto', modelo: 'haiku', esforco: 'low', modoPermissao: 'manual', nome: NOME });
    const c = await comandoFeito(id, 90_000);
    if (!c.chave) throw new Error('o comando terminou sem a chave da sessão nova');
    chave = c.chave;
    idDaSessao = chave.split(':')[1];
    const s = await sessaoEm((x) => x.gerenciada === true, 'sessão comandada aparecer no painel');
    if (s.nome !== NOME) throw new Error(`nome inesperado: ${s.nome}`);
    return `sessão ${idDaSessao.slice(0, 8)}`;
  });

  await item(2, 'ver estado e última resposta', async () => {
    const s = await sessaoEm((x) => x.estado === 'esperando_mensagem' && /pronto/i.test(x.ultimaResposta || ''), 'estado "esperando_mensagem" com a resposta "pronto"', 90_000);
    if (!s.tarefa) throw new Error('a tarefa veio vazia');
    return `estado ${s.estado}; última resposta "${s.ultimaResposta}"; tarefa "${s.tarefa}"`;
  });

  await item(3, 'enviar mensagem e ver a resposta', async () => {
    const marca = `recebido-${hex(3)}`;
    await mensagem(`Responda apenas: ${marca}`);
    const s = await sessaoEm((x) => x.estado === 'esperando_mensagem' && (x.ultimaResposta || '').includes(marca), `resposta com "${marca}"`, 90_000);
    return `resposta "${s.ultimaResposta}"`;
  });

  await item(4, 'aprovar e negar um pedido de permissão', async () => {
    const a = arquivo('aprovado');
    const b = arquivo('negado');
    await mensagem(`Rode com a ferramenta Bash: echo aprovado > ${path.basename(a)}`);
    const p1 = await pedidoDePermissao(path.basename(a));
    await comandoFeito(await responder(p1, 'aprovar'));
    await ate('arquivo aprovado aparecer', () => fs.existsSync(a), 30_000);
    await sessaoEm((x) => x.estado === 'esperando_mensagem', 'sessão voltar a esperar mensagem depois de aprovar', 90_000);

    await mensagem(`Rode com a ferramenta Bash: echo negado > ${path.basename(b)}`);
    const p2 = await pedidoDePermissao(path.basename(b));
    await comandoFeito(await responder(p2, 'negar'));
    await sessaoEm((x) => x.estado === 'esperando_mensagem' && !(x.permissoes || []).length, 'sessão voltar a esperar mensagem depois de negar', 90_000);
    if (fs.existsSync(b)) throw new Error('o comando negado rodou mesmo assim');
    return `aprovado criou ${path.basename(a)}; negado não criou ${path.basename(b)}`;
  });

  await item(5, 'interromper e encerrar', async () => {
    // Comando longo que pede permissão e não é sensível. `sleep` não serve: sozinho, o Claude Code roda sem
    // pedir; seguido de outro comando em primeiro plano, ele bloqueia. Gravar um arquivo faz pedir.
    const longo = path.basename(arquivo('longo'));
    await mensagem(`Rode com a ferramenta Bash, num comando só e em primeiro plano: ping -c 45 127.0.0.1 > ${longo}`);
    const p = await pedidoDePermissao('ping -c 45');
    await comandoFeito(await responder(p, 'aprovar'));
    await sessaoEm((x) => x.estado === 'trabalhando', 'sessão trabalhando no comando longo', 30_000);
    await espera(2000);
    const t0 = Date.now();
    await comandoFeito(await comando('interromper', chave, { visto: await visto() }));
    await sessaoEm((x) => x.estado === 'esperando_mensagem', 'sessão parar depois de interromper', 20_000);
    const levou = Date.now() - t0;
    if (levou > 25_000) throw new Error(`a interrupção levou ${levou} ms`);
    await comandoFeito(await comando('encerrar', chave, { nome: `${NOME} (e2e)`, visto: await visto() }), 40_000);
    await sessaoEm((x) => x.estado === 'encerrada', 'sessão aparecer como encerrada', 30_000);
    if (sessoesVivasDoClaude().some((v) => v.sessionId === idDaSessao)) throw new Error('a sessão ainda aparece em `claude agents --json`');
    return `interrompeu em ${(levou / 1000).toFixed(1)} s; encerrada e fora do claude agents`;
  });

  // ---------- extras: o que o canal recusa, com o Claude Code de verdade ----------
  await item('extra', 'coletor recusa comando com assinatura trocada', async () => {
    const cmd = await assinarComando(aparelho, { tipo: 'retomar', chave, dados: { visto: await visto() } });
    cmd.assinatura = (cmd.assinatura[0] === 'A' ? 'B' : 'A') + cmd.assinatura.slice(1);
    const c = await comandoTerminou(await enviar(cmd));
    if (c.estado !== 'recusado' || c.motivo !== 'assinatura') throw new Error(`terminou como ${c.estado} (${c.motivo})`);
    return 'recusado, motivo assinatura';
  });

  await item('extra', 'retomar a sessão encerrada, e aprovar com impressão digital errada não roda nada', async () => {
    await comandoFeito(await comando('retomar', chave, { modoPermissao: 'manual', modelo: 'haiku', visto: await visto() }), 60_000);
    await sessaoEm((x) => x.gerenciada === true && x.estado === 'esperando_mensagem', 'sessão retomada esperando mensagem', 30_000);
    const marca = `voltei-${hex(3)}`;
    await mensagem(`Responda apenas: ${marca}`);
    await sessaoEm((x) => x.estado === 'esperando_mensagem' && (x.ultimaResposta || '').includes(marca), `resposta com "${marca}"`, 90_000);

    const c = arquivo('trocado');
    await mensagem(`Rode com a ferramenta Bash: echo trocado > ${path.basename(c)}`);
    const p = await pedidoDePermissao(path.basename(c));
    const r = await comandoTerminou(await responder(p, 'aprovar', await hashVisto('Bash', 'echo outra coisa')));
    if (r.estado !== 'falhou') throw new Error(`aprovar com impressão digital errada terminou como ${r.estado}`);
    await espera(1500);
    if (fs.existsSync(c)) throw new Error('o comando rodou mesmo com a impressão digital errada');
    await comandoFeito(await responder(p, 'negar'));
    await sessaoEm((x) => x.estado === 'esperando_mensagem' && !(x.permissoes || []).length, 'sessão voltar a esperar mensagem', 90_000);

    await comandoFeito(await comando('encerrar', chave, { visto: await visto() }), 40_000);
    await sessaoEm((x) => x.estado === 'encerrada', 'sessão encerrada de novo', 30_000);
    return 'mesma conversa, mesmo id; aprovação adulterada recusada';
  });

  const fim = await sessao();
  custo = fim?.custo ?? null;
  const auditoria = path.join(pastaEstado, 'auditoria.jsonl');
  if (fs.existsSync(auditoria)) {
    const linhas = fs.readFileSync(auditoria, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const porDecisao = {};
    for (const l of linhas) porDecisao[l.decisao] = (porDecisao[l.decisao] || 0) + 1;
    log(`auditoria local: ${linhas.length} linhas ${JSON.stringify(porDecisao)}; permissão do arquivo ${(fs.statSync(auditoria).mode & 0o777).toString(8)}`);
  }
}

const guarda = setTimeout(() => {
  console.error('tempo total esgotado');
  falhouAlgum = true;
  parar().finally(() => process.exit(1));
}, TEMPO_TOTAL_MS);

try {
  await main();
} catch (err) {
  falhouAlgum = true;
  console.error(`erro fora dos itens: ${err.message}`);
  console.error(`--- fim da saída do painel\n${saidaPainel.join('').slice(-1500)}`);
} finally {
  clearTimeout(guarda);
  await parar();
  for (const a of arquivosDeTeste) fs.rmSync(a, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Depois de parar o coletor, não pode sobrar processo da sessão de teste.
if (idDaSessao) {
  try {
    if (sessoesVivasDoClaude().some((v) => v.sessionId === idDaSessao)) {
      falhouAlgum = true;
      console.error('sobrou processo da sessão de teste depois de parar o coletor');
    }
  } catch (err) {
    console.error(`não consegui conferir o claude agents: ${err.message}`);
  }
}

log('\n=== resultado ===');
for (const r of resultados) log(r);
const cinco = resultados.filter((r) => /^[1-5]\. .*: passou/.test(r)).length;
log(`capacidades do MVP que passaram: ${cinco} de 5`);
if (custo != null) log(`custo da sessão de teste: US$ ${custo.toFixed(4)}`);
if (idDaSessao) log(`id da sessão de teste: ${idDaSessao}`);
process.exit(falhouAlgum || cinco !== 5 ? 1 : 0);
