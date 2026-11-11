#!/usr/bin/env node
// Coletor local: lê as sessões do Claude Code e envia só metadados ao painel.
// Uso: node collector/index.js           (laço contínuo, serviço systemd)
//      node collector/index.js --uma-vez  (um ciclo, imprime o retrato e não envia)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Coletor } from './sessoes.js';
import { executarEncerrar } from './encerrar.js';
import { Ideias } from './ideias.js';

const CONF = process.env.MOISES_CONF || path.join(os.homedir(), '.config/moises/coletor.env');
const ESTADO = process.env.MOISES_ESTADO || path.join(os.homedir(), '.local/state/moises');
const INTERVALO_MS = Number(process.env.MOISES_INTERVALO_MS || 20_000);
const REENVIO_MS = 5 * 60_000; // manda o retrato mesmo sem mudança, como sinal de vida

function lerConf() {
  const out = {};
  try {
    for (const l of fs.readFileSync(CONF, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* sem arquivo: usa variáveis de ambiente */
  }
  return { url: process.env.MOISES_URL || out.MOISES_URL, token: process.env.MOISES_TOKEN || out.MOISES_TOKEN };
}

// Hash do que importa no retrato (sem horários que mudam a cada ciclo sem mudança real).
function assinatura(r) {
  const base = r.sessoes.map((s) => [s.chave, s.status, s.custo, s.modelo, s.esforco, s.tarefa, s.ultimaAtividade, s.sugestao?.geradaEm]);
  return crypto.createHash('sha1').update(JSON.stringify([r.totalDia, base])).digest('hex');
}

async function enviar(conf, corpo) {
  const r = await fetch(new URL('/api/ingest', conf.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${conf.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`painel respondeu ${r.status}`);
  return r.json();
}

async function main() {
  const coletor = new Coletor();
  const ideias = new Ideias({ pastaEstado: ESTADO });
  if (process.argv.includes('--uma-vez')) {
    console.log(JSON.stringify(ideias.aplicar(coletor.retrato()), null, 2));
    return;
  }
  const conf = lerConf();
  if (!conf.url || !conf.token) {
    console.error(`[coletor] configure MOISES_URL e MOISES_TOKEN em ${CONF}`);
    process.exit(1);
  }
  console.log(`[coletor] lendo ${coletor.dirs.length} diretórios; enviando para ${new URL(conf.url).host} a cada ${INTERVALO_MS / 1000}s`);
  let ultimaAss = null;
  let ultimoEnvio = 0;
  let acks = [];
  let falhasSeguidas = 0;
  for (;;) {
    const inicio = Date.now();
    try {
      const retrato = ideias.aplicar(coletor.retrato());
      const ass = assinatura(retrato);
      const mandarRetrato = ass !== ultimaAss || inicio - ultimoEnvio > REENVIO_MS;
      const resp = await enviar(conf, { retrato: mandarRetrato ? retrato : null, acks });
      acks = [];
      if (mandarRetrato) {
        ultimaAss = ass;
        ultimoEnvio = inicio;
      }
      falhasSeguidas = 0;
      for (const cmd of resp.comandos || []) {
        if (cmd.tipo && cmd.tipo !== 'encerrar') continue;
        const r = await executarEncerrar(coletor, cmd);
        console.log(`[coletor] encerrar ${cmd.chave.split(':')[0]}: ${r.ok ? 'feito' : r.erro}`);
        acks.push({ id: cmd.id, ...r });
      }
      if (acks.length) {
        ultimaAss = null; // força retrato novo junto com o resultado
        continue;
      }
    } catch (err) {
      falhasSeguidas++;
      if (falhasSeguidas <= 3 || falhasSeguidas % 30 === 0) console.error(`[coletor] falha (${falhasSeguidas}x): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, INTERVALO_MS - (Date.now() - inicio))));
  }
}

main();
