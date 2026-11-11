#!/usr/bin/env node
// Gera a senha do painel, o segredo do cookie e o token do coletor.
// Grava tudo em ~/.config/moises/ (permissão 600) e imprime só o que vai para a Vercel.
// Uso: node scripts/configurar.js <url do painel>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gerarHashSenha } from '../api/_lib.js';

const url = process.argv[2];
if (!url) {
  console.error('Uso: node scripts/configurar.js https://<painel>.vercel.app');
  process.exit(1);
}
if (!/^https:\/\//.test(url)) {
  console.error('A URL do painel precisa começar com https://');
  process.exit(1);
}
const pasta = path.join(os.homedir(), '.config/moises');
fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
const arqSenha = path.join(pasta, 'senha-painel.txt');
const arqVercel = path.join(pasta, 'vercel.env');
const arqColetor = path.join(pasta, 'coletor.env');

// Senha fácil de digitar no celular: 4 grupos de 4 letras/dígitos sem ambiguidade.
const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
const grupo = () => Array.from(crypto.randomBytes(4), (b) => alfabeto[b % alfabeto.length]).join('');
const senha = fs.existsSync(arqSenha) ? fs.readFileSync(arqSenha, 'utf8').trim() : [grupo(), grupo(), grupo(), grupo()].join('-');
const token = crypto.randomBytes(32).toString('base64url');
const segredo = crypto.randomBytes(48).toString('base64url');

fs.writeFileSync(arqSenha, senha + '\n', { mode: 0o600 });
fs.writeFileSync(arqColetor, `MOISES_URL=${url}\nMOISES_TOKEN=${token}\n`, { mode: 0o600 });
fs.writeFileSync(arqVercel, `PANEL_PASSWORD_HASH=${gerarHashSenha(senha)}\nSESSION_SECRET=${segredo}\nMOISES_TOKEN=${token}\n`, { mode: 0o600 });
// O `mode` acima só vale ao criar: garante as permissões também em arquivos que já existiam.
fs.chmodSync(pasta, 0o700);
for (const a of [arqSenha, arqColetor, arqVercel]) fs.chmodSync(a, 0o600);
console.log(`Senha do painel em ${arqSenha}`);
console.log(`Variáveis para a Vercel em ${arqVercel}`);
console.log(`Configuração do coletor em ${arqColetor}`);
