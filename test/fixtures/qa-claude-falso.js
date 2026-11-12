#!/usr/bin/env node
// Segundo claude falso, só para o QA (test/qa-orquestrador.test.js). Nunca chama o Claude Code de verdade.
// Na primeira mensagem do usuário emite o `init` e um pedido de permissão para Bash cujo comando tem
// emoji e acentos, escrito em DOIS pedaços no stdout, com o corte no meio de um caractere de 4 bytes:
// o coletor tem de remontar a linha em bytes, não em texto. Cada linha que chega no stdin vai para
// <caminho>.entrada (o caminho vem de --system-prompt=registro:<caminho>).
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const valor = (flag) => args.find((x) => x.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? null;
const registro = (valor('system-prompt') ?? '').replace(/^registro:/, '');
const sessionId = valor('session-id') ?? valor('resume');
const modo = { manual: 'default', acceptEdits: 'acceptEdits', plan: 'plan' }[valor('permission-mode')] ?? valor('permission-mode');
const emitir = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let iniciado = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (linha) => {
  if (registro) fs.appendFileSync(`${registro}.entrada`, linha + '\n');
  let msg;
  try {
    msg = JSON.parse(linha);
  } catch {
    return;
  }
  if (msg?.type === 'user' && !iniciado) {
    iniciado = true;
    emitir({ type: 'system', subtype: 'init', session_id: sessionId, tools: (valor('tools') ?? '').split(','), mcp_servers: [], permissionMode: modo });
    const linhaInteira = Buffer.from(
      JSON.stringify({ type: 'control_request', request_id: 'req_utf8', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo 😀😀😀 ação ✓ 日本語' } } }) + '\n',
      'utf8',
    );
    const corte = linhaInteira.indexOf(Buffer.from('😀', 'utf8')) + 2; // no meio dos 4 bytes do primeiro emoji
    process.stdout.write(linhaInteira.subarray(0, corte));
    setTimeout(() => process.stdout.write(linhaInteira.subarray(corte)), 60);
  } else if (msg?.type === 'control_response') {
    emitir({ type: 'result', subtype: 'success', is_error: false, result: msg.response?.response?.behavior ?? '?', total_cost_usd: 0 });
  }
});
rl.on('close', () => process.exit(0));
