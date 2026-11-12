// QA do transporte de comandos no servidor (CA4 e CA9 do lado da API) e da interface por leitura
// estática (CA8, CA9 e CA10 no painel, onde o projeto não tem teste de UI). Redis em memória e
// nenhum acesso a ~/.config/moises nem a .env*.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { gerarHashSenha } from '../api/_lib.js';
import login from '../api/login.js';
import estado from '../api/estado.js';
import comando from '../api/comando.js';
import logs from '../api/logs.js';
import ingest from '../api/ingest.js';
import { instalarRedisFalso } from '../scripts/redis-memoria.js';

const redisFalso = instalarRedisFalso();
const SENHA = 'abcd-efgh-jkmn-pqrs';
process.env.PANEL_PASSWORD_HASH = gerarHashSenha(SENHA);
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.MOISES_TOKEN = 'y'.repeat(43);

// Rodada 2 (A4, S22): o servidor só aceita comando de aparelho anunciado no retrato e só entrega a coletor com protocolo 2.
beforeEach(() => {
  redisFalso.limpar();
  redisFalso.db.set('moises:retrato', JSON.stringify({ sessoes: [], orquestracao: { aparelhos: [{ kid: 'ab2cd3', rotulo: 'x' }] } }));
});

async function chamar(handler, { method = 'GET', url = '/', body, bruto, headers = {} } = {}) {
  const txt = bruto ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from(txt ? [Buffer.from(txt)] : []);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...headers }, socket: {} });
  const res = {
    statusCode: 200,
    h: {},
    setHeader(k, v) { this.h[k.toLowerCase()] = v; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
  await handler(req, res);
  return res;
}
async function entrar() {
  const r = await chamar(login, { method: 'POST', body: { senha: SENHA } });
  return r.h['set-cookie'].split(';')[0];
}
const coletor = { authorization: `Bearer ${'y'.repeat(43)}` };
const CHAVE = 'principal:4e00abb1-1234-4abc-8def-0123456789ab';
// Rodada 2 (A1): a assinatura passou a ser ECDSA P-256 (IEEE P1363) em base64url, 86 caracteres.
const ASSINATURA = 'QaQa_-0123456789abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, 85) + 'Q';
const MARCA = 'TEXTO-SIGILOSO-QA';
let seq = 0;
const cmdValido = (extra = {}) => ({
  v: 1, kid: 'ab2cd3', id: `c_${(++seq).toString(16).padStart(16, 'a')}`, tipo: 'mensagem', chave: CHAVE, criadoEm: Date.now(),
  dados: JSON.stringify({ texto: MARCA, visto: { projeto: 'p', nome: null } }), assinatura: ASSINATURA, ...extra,
});
const guardado = (id) => JSON.parse(redisFalso.db.get('moises:cmds').get(id));
// Rodada de correção 2 (R9): o resultado de cada etapa fica em moises:cmds-rec e moises:cmds-fim (gravados
// uma vez só). Estado no Redis, pela regra: fim, senão recebido, senão o do objeto em moises:cmds.
function estadoGuardado(id) {
  const fim = redisFalso.db.get('moises:cmds-fim')?.get(id);
  if (fim) return JSON.parse(fim).estado;
  if (redisFalso.db.get('moises:cmds-rec')?.has(id)) return 'recebido';
  return guardado(id).estado;
}
const enviar = async (cookie, c) => (await chamar(comando, { method: 'POST', body: c, headers: { cookie } })).statusCode;
const acks = (lista) => chamar(ingest, { method: 'POST', body: { protocolo: 2, acks: lista }, headers: coletor });
const porId = async (cookie) => Object.fromEntries((await chamar(estado, { headers: { cookie } })).body.comandos.map((c) => [c.id, c]));

// ---------------------------------------------------------------- CA4

test('CA4: qualquer ack (recebido, feito, falhou, recusado, formato antigo) apaga dados e assinatura, e nada do conteúdo chega ao painel', async () => {
  const cookie = await entrar();
  const grupos = [
    [{ estado: 'recebido' }, 'recebido'],
    [{ estado: 'feito' }, 'feito'],
    [{ estado: 'falhou', erro: 'deu ruim' }, 'falhou'],
    [{ estado: 'recusado', erro: 'não', motivo: 'assinatura' }, 'recusado'],
    [{ ok: true }, 'feito'],
    [{ ok: false, erro: 'x' }, 'falhou'],
  ];
  const cmds = grupos.map(() => cmdValido());
  for (const c of cmds) assert.equal(await enviar(cookie, c), 200);
  const entregues = (await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor })).body.comandos;
  assert.equal(entregues.length, grupos.length);
  for (const e of entregues) {
    assert.equal(e.assinatura, ASSINATURA);
    assert.ok(e.dados.includes(MARCA));
  }
  await acks(grupos.map(([a], i) => ({ id: cmds[i].id, ...a })));
  grupos.forEach(([, esperado], i) => {
    const g = guardado(cmds[i].id);
    assert.equal(estadoGuardado(cmds[i].id), esperado, `ack ${i}`);
    assert.equal('dados' in g, false);
    assert.equal('assinatura' in g, false);
    assert.ok(!redisFalso.db.get('moises:cmds').get(cmds[i].id).includes(MARCA));
    assert.ok(!redisFalso.db.get('moises:cmds').get(cmds[i].id).includes(ASSINATURA));
  });
  const corpo = JSON.stringify([(await chamar(estado, { headers: { cookie } })).body, (await chamar(logs, { headers: { cookie } })).body]);
  assert.ok(!corpo.includes(MARCA) && !corpo.includes(ASSINATURA));
  assert.equal((await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor })).body.comandos.length, 0, 'nada é entregue de novo');
});

test('CA4: o POST /api/comando nunca devolve dados nem assinatura, nem em erro', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  const ok = await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  assert.deepEqual(ok.body, { id: c.id });
  const repetido = await chamar(comando, { method: 'POST', body: c, headers: { cookie } });
  assert.equal(repetido.statusCode, 409);
  const ruim = await chamar(comando, { method: 'POST', body: { ...cmdValido(), assinatura: 'curta' }, headers: { cookie } });
  assert.equal(ruim.statusCode, 400);
  for (const r of [ok, repetido, ruim]) {
    const txt = JSON.stringify(r.body);
    assert.ok(!txt.includes(MARCA) && !txt.includes(ASSINATURA) && !txt.includes('curta'));
  }
});

// ---------------------------------------------------------------- ordem dos estados e log

test('CA9: estado do comando só anda para a frente, mesmo com acks fora de ordem', async () => {
  const cookie = await entrar();
  const a = cmdValido();
  const b = cmdValido();
  await enviar(cookie, a);
  await enviar(cookie, b);
  await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor });
  await acks([{ id: a.id, estado: 'feito' }, { id: a.id, estado: 'recebido' }, { id: a.id, estado: 'falhou', erro: 'tarde demais' }, { id: a.id, estado: 'recusado', motivo: 'repetido' }]);
  assert.equal((await porId(cookie))[a.id].estado, 'feito');
  assert.equal((await porId(cookie))[a.id].erro, null);
  await acks([{ id: b.id, estado: 'recebido' }]);
  assert.equal((await porId(cookie))[b.id].estado, 'recebido');
  await acks([{ id: b.id, estado: 'recebido' }]);
  assert.equal((await porId(cookie))[b.id].estado, 'recebido');
  await acks([{ id: b.id, estado: 'falhou', erro: 'x' }]);
  const final = (await porId(cookie))[b.id];
  assert.deepEqual([final.estado, final.erro], ['falhou', 'x']);
});

test('CA9: um id de comando já concluído não pode ser enviado de novo (409), nem com outros dados', async () => {
  const cookie = await entrar();
  const c = cmdValido();
  await enviar(cookie, c);
  await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor });
  await acks([{ id: c.id, estado: 'feito' }]);
  assert.equal(await enviar(cookie, c), 409);
  assert.equal(await enviar(cookie, { ...c, dados: JSON.stringify({ texto: 'outro', visto: { projeto: 'p', nome: null } }) }), 409);
  assert.equal(estadoGuardado(c.id), 'feito');
});

test('o log do Histórico só nasce de encerrar que terminou feito', async () => {
  const cookie = await entrar();
  const log = { nome: 'log de teste', projeto: 'p', custo: 1 };
  const feitoMensagem = cmdValido();
  const falhouEncerrar = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  const recusadoEncerrar = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  const feitoEncerrar = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  for (const c of [feitoMensagem, falhouEncerrar, recusadoEncerrar, feitoEncerrar]) await enviar(cookie, c);
  await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor });
  await acks([
    { id: feitoMensagem.id, estado: 'feito', log },
    { id: falhouEncerrar.id, estado: 'falhou', erro: 'x', log },
    { id: recusadoEncerrar.id, estado: 'recusado', motivo: 'assinatura', log },
  ]);
  assert.deepEqual((await chamar(logs, { headers: { cookie } })).body.logs, []);
  await acks([{ id: feitoEncerrar.id, estado: 'feito', log }]);
  const lista = (await chamar(logs, { headers: { cookie } })).body.logs;
  assert.deepEqual(lista.map((l) => [l.id, l.nome]), [[feitoEncerrar.id, 'log de teste']]);
  // Repetir o ack não duplica o log.
  await acks([{ id: feitoEncerrar.id, estado: 'feito', log }]);
  assert.equal((await chamar(logs, { headers: { cookie } })).body.logs.length, 1);
});

// ---------------------------------------------------------------- entradas ruins

test('comando e ingest recusam corpo que não é JSON, e acks fora do formato não quebram o ingest', async () => {
  const cookie = await entrar();
  assert.equal((await chamar(comando, { method: 'POST', bruto: '{quebrado', headers: { cookie } })).statusCode, 400);
  assert.equal((await chamar(comando, { method: 'POST', bruto: '', headers: { cookie } })).statusCode, 400);
  assert.equal((await chamar(comando, { method: 'POST', bruto: 'x'.repeat(40_001), headers: { cookie } })).statusCode, 413);
  for (const acksRuins of [null, 'x', 7, {}, [null, 1, 'x', [], { id: 7 }, { id: '__proto__', estado: 'feito' }, { id: 'c_0000000000000000' }]]) {
    const r = await chamar(ingest, { method: 'POST', body: { acks: acksRuins }, headers: coletor });
    assert.equal(r.statusCode, 200, JSON.stringify(acksRuins));
  }
  // Retrato sem lista de sessões não apaga o retrato que já estava lá.
  await chamar(ingest, { method: 'POST', body: { retrato: { dia: 'x', sessoes: [{ chave: CHAVE }] } }, headers: coletor });
  await chamar(ingest, { method: 'POST', body: { retrato: { sessoes: 'lixo' } }, headers: coletor });
  assert.equal((await chamar(estado, { headers: { cookie } })).body.retrato.sessoes[0].chave, CHAVE);
});

test('duas confirmações do mesmo comando na mesma chamada terminam no estado mais avançado', async () => {
  const cookie = await entrar();
  const c = cmdValido({ tipo: 'encerrar', dados: JSON.stringify({ visto: { projeto: 'p', nome: null } }) });
  await enviar(cookie, c);
  await chamar(ingest, { method: 'POST', body: { protocolo: 2 }, headers: coletor });
  // O coletor manda recebido e feito juntos quando o comando termina antes do próximo ciclo.
  await acks([{ id: c.id, estado: 'recebido' }, { id: c.id, estado: 'feito', log: { nome: 'junto' } }]);
  assert.equal((await porId(cookie))[c.id].estado, 'feito');
  assert.equal((await chamar(logs, { headers: { cookie } })).body.logs[0].nome, 'junto');
});

// ---------------------------------------------------------------- interface, por leitura estática

const lerPublico = (arq) => fs.readFileSync(new URL(`../public/${arq}`, import.meta.url), 'utf8');
const semComentarios = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('painel: nenhum JS de public/ usa innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function, localStorage ou href montado', () => {
  const proibidos = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /setAttribute\(\s*['"](href|src|style|on\w+)['"]/, /createContextualFragment/, /DOMParser/, /\.srcdoc\b/];
  for (const arq of fs.readdirSync(new URL('../public/', import.meta.url)).filter((n) => n.endsWith('.js'))) {
    const js = semComentarios(lerPublico(arq));
    for (const re of proibidos) assert.ok(!re.test(js), `${arq}: ${re}`);
    // Atribuir a .href só com texto literal fixo (a navegação para /login.html); nada montado com conteúdo.
    for (const m of js.matchAll(/\.href\s*=\s*([^;\n]*)/g)) assert.match(m[1], /^'[^'+$`\\]*'\s*$/, `${arq}: href montado: ${m[0]}`);
  }
});

test('painel: as páginas não têm script, estilo nem manipulador inline, e a CSP não abre exceção', () => {
  for (const pag of ['index.html', 'login.html']) {
    const html = lerPublico(pag);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="\/[a-z]+\.js"/, `${pag}: script só com src local`);
      assert.equal(m[2].trim(), '', `${pag}: script sem corpo`);
    }
    assert.ok(!/<style\b/i.test(html), `${pag}: sem <style>`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${pag}: sem atributo style`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${pag}: sem manipulador inline`);
    assert.ok(!/(src|href)\s*=\s*["']\s*(https?:)?\/\//i.test(html), `${pag}: nada externo`);
  }
  assert.match(lerPublico('index.html'), /<script type="module" src="\/app\.js"><\/script>/);
  const csp = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.ok(!/unsafe-|\*|https?:|data:|blob:/.test(csp), csp);
});

test('CA8: o painel só oferece Aprovar para pedido completo e calcula o vistoHash do texto que está na tela', () => {
  const js = lerPublico('app.js');
  // O botão Aprovar nem existe se o pedido não é `completo === true`, e a função recusa de novo por garantia.
  assert.match(js, /const completo = p\.completo === true;/);
  assert.match(js, /const aprovar = completo \? botao\('Aprovar'/);
  assert.match(js, /if \(decisao === 'aprovar' && !b\.completo\) return;/);
  // A impressão digital sai do <pre> exibido (textContent), não de um dado guardado à parte.
  assert.match(js, /exibido = decisao === 'aprovar' \? \{ ferramenta: b\.ferramenta, entrada: b\.pre\.textContent \} : null/);
  assert.match(js, /corpo\.vistoHash = await hashVisto\(exibido\.ferramenta, exibido\.entrada\)/);
  // Aprovar sem o texto exibido não sai.
  assert.match(js, /if \(!exibido\) return \{ ok: false, erro: TEXTOS\.erro400 \}/);
  // Todo comando passa por enviarComando, que anexa o `visto` da sessão exibida.
  assert.equal([...js.matchAll(/api\('\/api\/comando'/g)].length, 1, 'uma única saída de comandos');
  assert.match(js, /if \(sessao\) corpo\.visto = \{ projeto: sessao\.projeto, nome: sessao\.nome \?\? null \}/);
  // O texto do pedido nunca entra como HTML.
  assert.match(js, /pre\.textContent = entrada;/);
});

test('CA9 e CA10: o painel desabilita as ações com o coletor fora do ar e pede confirmação para encerrar e interromper', () => {
  const js = lerPublico('app.js');
  assert.match(js, /COLETOR_PARADO_MS/);
  assert.match(js, /function motivoBloqueio\(\)[\s\S]*coletorParado\(\)[\s\S]*o\.ativa !== true/);
  assert.match(js, /abrirConfirmacao\(c, 'interromper'\)/);
  assert.match(js, /abrirConfirmacao\(c, 'encerrar'\)/);
  // O clique no botão só abre a confirmação; o envio fica no `submit`/botão de confirmar.
  const trechoEncerrar = js.slice(js.indexOf("encerrar.addEventListener('click'"), js.indexOf("encerrar.addEventListener('click'") + 200);
  assert.ok(!/enviarComando/.test(trechoEncerrar), 'clicar em Encerrar não envia direto');
  assert.match(js, /await enviarComando\(tipo, c\.sessao, dados\)/);
  // Estados do andamento: enviado → recebido → executado, mais recusado, falhou e expirado.
  for (const e of ['pendente', 'recebido', 'feito', 'recusado', 'falhou', 'expirado']) assert.match(js, new RegExp(`case '${e}'`), e);
  // Sair do painel esquece a chave do aparelho.
  assert.match(js, /await esquecer\(\);[\s\S]{0,200}location\.href = '\/login\.html'/);
});

// Rodada 2 (A1): não existe mais código do aparelho digitado na página; o aparelho gera o próprio par de
// chaves e só o nome dele é digitado (fora de <form>, sem preenchimento automático).
test('o cofre só guarda chave não extraível e nada secreto é digitado no painel', () => {
  const cofre = lerPublico('cofre.js');
  assert.match(cofre, /chave\.extractable === false/);
  assert.match(cofre, /throw new TypeError\('Chave do aparelho inválida\.'\)/);
  const html = lerPublico('index.html');
  assert.ok(!/id="codigo"/.test(html), 'campo do código não existe mais');
  assert.ok(!/type="password"/.test(html), 'nenhum campo de senha no painel');
  const campo = html.match(/<input[^>]*id="autorizar-rotulo"[^>]*>/);
  assert.ok(campo, 'campo do nome do aparelho');
  assert.match(campo[0], /autocomplete="off"/);
  for (const f of html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) assert.ok(!/id="autorizar-rotulo"/.test(f[0]), 'o nome do aparelho está dentro de um form');
  // A chave nasce no aparelho e só a pública sai, pelo pedido de autorização.
  const js = lerPublico('app.js');
  assert.match(js, /const novo = await gerarAparelho\(\);/);
  assert.match(js, /api\('\/api\/aparelho', jsonOpcoes\('POST', \{ kid: ap\.kid, publica: ap\.publica, rotulo \}\)\)/);
});
