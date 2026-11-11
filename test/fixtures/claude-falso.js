#!/usr/bin/env node
// Imita o `claude -p --input-format=stream-json --output-format=stream-json` nos testes do orquestrador.
// Nunca chama o Claude Code de verdade. Como no Claude Code 2.1.322, nada sai antes da primeira mensagem
// do usuário e o `system`/`init` chega de novo a cada turno. Mensagem que chega com um turno em andamento
// (pedido de permissão pendente, `demora`) espera na fila, como no Claude Code.
//
// Comportamento pelo texto de cada mensagem:
//   permissao:<comando>    pede permissão para Bash com esse comando; allow → result "feito", deny → "negado"
//   permissoes:<a>;;<b>    dois pedidos no mesmo turno; o result lista as decisões na ordem ("negado,feito")
//   editar:<caminho>       pede permissão para Edit (no painel a entrada vira JSON)
//   bash-extra:<comando>   pede permissão para Bash com um campo além de command, description e timeout
//   ferramenta-ruim        pede permissão com nome de ferramenta inválido (com quebra de linha)
//   demora                 não responde até receber interrupt; então result com subtype error_during_execution
//   lixo                   linha que não é JSON, linha gigante, eventos de outros tipos e control_request desconhecido
//   morre                  escreve no stderr e sai com código 3
//   mudo                   não emite nada
//   teimoso                passa a ignorar o fim do stdin e o SIGTERM
//   init-ruim              init com permissionMode "bypassPermissions"
//   init-mcp, init-ferramenta   init com um servidor MCP, ou com uma ferramenta fora da lista
//   sem-init               sem init: pede permissão para Bash e, com a resposta, emite o result
//   neto                   dispara `sleep 300` em segundo plano (no mesmo grupo de processos), grava o pid
//                          dele em <caminho>.neto e responde
//   hook:<texto>           emite um `system` de subtipo `hook_started` (como um hook SessionStart) antes de
//                          tudo e segue com <texto> (ex.: `hook:init-ruim`, `hook:morre`, `hook:mudo`)
//   pedido-solto:<comando> pede permissão para Bash e emite o result logo em seguida, sem esperar a resposta
//                          (o pedido ainda está pendente no coletor quando o turno acaba)
//   qualquer outro texto   init coerente com os argumentos e result com o próprio texto
//
// Com --system-prompt=registro:<caminho>, grava em <caminho> o argv, os nomes das variáveis de ambiente,
// o valor de CLAUDE_CONFIG_DIR e a pasta de trabalho; cada linha recebida no stdin vai para <caminho>.entrada.
// Com --system-prompt=registro:<caminho>:sai, sai com código 2 antes de ler.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const valor = (flag) => {
  const a = args.find((x) => x.startsWith(`--${flag}=`));
  return a == null ? null : a.slice(flag.length + 3);
};

let registro = null;
let sai = false;
const prompt = valor('system-prompt');
if (prompt?.startsWith('registro:')) {
  registro = prompt.slice('registro:'.length);
  if (registro.endsWith(':sai')) {
    sai = true;
    registro = registro.slice(0, -':sai'.length);
  }
}
if (registro) {
  fs.writeFileSync(
    registro,
    JSON.stringify({ argv: args, env: Object.keys(process.env).sort(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, cwd: process.cwd() }),
  );
}
if (sai) {
  process.stderr.write('falha simulada antes de ler; chave sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA\n');
  process.exit(2);
}

const sessionId = valor('session-id') ?? valor('resume');
const modoInit = { manual: 'default', acceptEdits: 'acceptEdits', plan: 'plan' }[valor('permission-mode')] ?? valor('permission-mode');
const tools = (valor('tools') ?? '').split(',').filter(Boolean);
const emitir = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const init = (extra = {}) =>
  emitir({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools, mcp_servers: [], permissionMode: modoInit, model: valor('model') ?? 'claude-haiku', ...extra });
const resultado = (texto, subtype = 'success') =>
  emitir({ type: 'result', subtype, is_error: subtype !== 'success', result: texto, total_cost_usd: 0.0005, session_id: sessionId });

let teimoso = false;
let turno = null; // { ordem: [ids], pendentes: Map, decisoes: [] } ou { demora: true }
const fila = [];
let contador = 0;

function pedir(tool_name, input) {
  const id = `req_${++contador}`;
  turno.ordem.push(id);
  turno.pendentes.set(id, input);
  emitir({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: `toolu_${contador}` } });
}

function concluir(texto, subtype) {
  turno = null;
  resultado(texto, subtype);
  proximo();
}

function iniciar(texto) {
  if (texto.startsWith('hook:')) {
    emitir({ type: 'system', subtype: 'hook_started', hook_id: 'hook_1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: sessionId });
    return iniciar(texto.slice('hook:'.length));
  }
  if (texto === 'morre') {
    process.stderr.write('falha simulada no meio; token sk-ant-BBBBBBBBBBBBBBBBBBBBBBBB\n');
    process.exit(3);
  }
  if (texto === 'mudo') return;
  if (texto === 'init-ruim') init({ permissionMode: 'bypassPermissions' });
  else if (texto === 'init-mcp') init({ mcp_servers: [{ name: 'externo', status: 'connected' }] });
  else if (texto === 'init-ferramenta') init({ tools: [...tools, 'WebFetch'] });
  else if (texto !== 'sem-init') init();

  const comeca = (prefixo) => texto.startsWith(prefixo) && texto.slice(prefixo.length);
  const novoTurno = () => (turno = { ordem: [], pendentes: new Map(), decisoes: [] });
  if (comeca('permissao:') !== false) {
    novoTurno();
    pedir('Bash', { command: comeca('permissao:'), description: 'Comando pedido no teste' });
  } else if (comeca('permissoes:') !== false) {
    novoTurno();
    for (const c of comeca('permissoes:').split(';;')) pedir('Bash', { command: c });
  } else if (comeca('editar:') !== false) {
    novoTurno();
    pedir('Edit', { file_path: comeca('editar:'), old_string: 'a', new_string: 'b' });
  } else if (comeca('bash-extra:') !== false) {
    novoTurno();
    pedir('Bash', { command: comeca('bash-extra:'), run_in_background: true });
  } else if (texto === 'ferramenta-ruim') {
    novoTurno();
    pedir('Bash\nRead', { command: 'ls' });
  } else if (texto === 'sem-init') {
    novoTurno();
    pedir('Bash', { command: 'echo sem init' });
  } else if (texto === 'neto') {
    // Sem `detached`: o neto fica no grupo de processos deste falso, como um comando do Bash em segundo plano.
    const neto = spawn('sleep', ['300'], { stdio: 'ignore' });
    neto.unref();
    if (registro) fs.writeFileSync(`${registro}.neto`, String(neto.pid));
    resultado('neto');
  } else if (comeca('pedido-solto:') !== false) {
    emitir({ type: 'control_request', request_id: 'req_solto', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: comeca('pedido-solto:') }, tool_use_id: 'toolu_solto' } });
    resultado('solto');
  } else if (texto === 'demora') {
    turno = { demora: true };
  } else if (texto === 'lixo') {
    process.stdout.write('isto não é JSON\n');
    process.stdout.write('42\nnull\n[1,2]\n\n');
    emitir({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    emitir({ type: 'system', subtype: 'status', status: 'compacting' });
    emitir({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pensando' }] } });
    emitir({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
    emitir({ type: 'control_request', request_id: 'ctl_1', request: { subtype: 'desconhecido' } });
    resultado('lixo');
    // Depois do result, uma linha de mais de 5 MB: se não fosse descartada, viraria um pedido de permissão
    // pendente. O segundo control_request desconhecido marca a ordem: quando ele é respondido, a linha
    // gigante já passou pelo coletor.
    const enorme = 'a'.repeat(6 * 1024 * 1024);
    emitir({ type: 'control_request', request_id: 'gigante', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: enorme } } });
    emitir({ type: 'control_request', request_id: 'ctl_2', request: { subtype: 'desconhecido' } });
  } else if (texto === 'teimoso') {
    teimoso = true;
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1 << 30);
    resultado('teimoso');
  } else {
    emitir({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] }, session_id: sessionId });
    resultado(texto);
  }
}

function proximo() {
  while (!turno && fila.length) iniciar(fila.shift());
}

function textoDe(msg) {
  const c = msg?.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
}

function processar(linha) {
  if (registro) fs.appendFileSync(`${registro}.entrada`, linha + '\n');
  let msg;
  try {
    msg = JSON.parse(linha);
  } catch {
    return;
  }
  if (msg?.type === 'user') {
    fila.push(textoDe(msg));
    proximo();
  } else if (msg?.type === 'control_response') {
    const r = msg.response;
    const id = r?.request_id;
    if (!turno?.pendentes?.has(id)) return;
    turno.decisoes[turno.ordem.indexOf(id)] = r.response?.behavior === 'allow' ? 'feito' : 'negado';
    turno.pendentes.delete(id);
    if (!turno.pendentes.size) concluir(turno.decisoes.join(','));
  } else if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    emitir({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    if (turno) concluir('interrompido', 'error_during_execution');
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', processar);
rl.on('close', () => {
  if (!teimoso) process.exit(0);
});
