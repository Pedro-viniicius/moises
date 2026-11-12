// Confere o que a Vercel vai servir: vercel.json, páginas, referências locais do HTML e rotas de api/.
// Não precisa de variável de ambiente nem de rede: as rotas só leem o ambiente quando são chamadas.
// Uso: node scripts/build.js [pasta-raiz]   (padrão: a raiz do repositório)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const pub = path.join(raiz, 'public');
const erros = [];
const falha = (msg) => erros.push(msg);
const rel = (p) => path.relative(raiz, p);

// vercel.json
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(raiz, 'vercel.json'), 'utf8'));
  if (cfg.outputDirectory !== 'public') falha('vercel.json: outputDirectory deve ser "public"');
} catch (err) {
  falha(`vercel.json: não é um JSON válido (${err.message})`);
}

// Páginas e referências locais (<script src> e <link href>)
for (const pag of ['index.html', 'login.html']) {
  const arq = path.join(pub, pag);
  if (!fs.existsSync(arq)) {
    falha(`${rel(arq)}: não existe`);
    continue;
  }
  const html = fs.readFileSync(arq, 'utf8');
  const refs = [
    ...[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  ];
  for (const ref of refs) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue; // externo, data: ou âncora
    const limpo = ref.split(/[?#]/)[0];
    const alvo = limpo.startsWith('/') ? path.join(pub, limpo) : path.join(path.dirname(arq), limpo);
    if (!fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) falha(`${rel(arq)}: "${ref}" aponta para arquivo que não existe`);
  }
}

// Rotas de api/: cada uma precisa importar e ter export default função
const dirApi = path.join(raiz, 'api');
const rotas = fs.existsSync(dirApi) ? fs.readdirSync(dirApi).filter((n) => n.endsWith('.js') && !n.startsWith('_')).sort() : [];
if (!rotas.length) falha('api/: nenhuma rota encontrada');
for (const nome of rotas) {
  try {
    const mod = await import(pathToFileURL(path.join(dirApi, nome)).href);
    if (typeof mod.default !== 'function') falha(`api/${nome}: o export default não é uma função`);
  } catch (err) {
    falha(`api/${nome}: não importa (${err.message})`);
  }
}

const estaticos = fs.existsSync(pub) ? fs.readdirSync(pub, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length : 0;
if (erros.length) {
  for (const e of erros) console.error(`build: ${e}`);
  console.error(`build: falhou (${erros.length} erros)`);
  process.exit(1);
}
console.log(`build: ok (${rotas.length} rotas, ${estaticos} arquivos estáticos)`);
