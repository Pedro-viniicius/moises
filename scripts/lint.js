// Verifica a sintaxe de todo .js do projeto com `node --check`. Sem dependências.
// Uso: node scripts/lint.js [pasta-raiz]   (padrão: a raiz do repositório)
// Como o package.json declara "type": "module", cada arquivo é checado como módulo ES. Isso aceita
// tanto script clássico em modo estrito (public/app.js hoje) quanto módulo com import/export
// (public/assinatura.js, futuro), sem tratamento separado para `public/`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTAS = ['api', 'collector', 'public', 'scripts', 'test'];
const IGNORADAS = new Set(['node_modules', '.claude', '.superpowers', '.vercel']);

function listarJs(dir) {
  const achados = [];
  if (!fs.existsSync(dir)) return achados;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORADAS.has(e.name)) continue;
    const caminho = path.join(dir, e.name);
    if (e.isDirectory()) achados.push(...listarJs(caminho));
    else if (e.isFile() && e.name.endsWith('.js')) achados.push(caminho);
  }
  return achados;
}

const raiz = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const arquivos = PASTAS.flatMap((p) => listarJs(path.join(raiz, p))).sort();
let erros = 0;
for (const arq of arquivos) {
  try {
    execFileSync(process.execPath, ['--check', arq], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    erros++;
    console.error(`lint: ${path.relative(raiz, arq)}\n${String(err.stderr || err.message).trim()}`);
  }
}
console.log(`lint: ${arquivos.length} arquivos, ${erros} erros`);
process.exit(erros ? 1 : 0);
