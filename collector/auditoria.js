// Registro de auditoria local do canal de comandos: uma linha JSON por decisão, em arquivos com
// permissão 600 que nunca saem da máquina. Aceito, feito e falhou ficam em `arquivo`; as recusas,
// em `arquivoRecusas` (padrão: o mesmo nome com `-recusas`), para uma enxurrada de recusas não
// empurrar os aceitos para fora (achado S21). Nada de texto de mensagem, `dados` ou chave aqui: só
// metadados do comando, cortados e sem caracteres de controle.
// Contrato no PLANO, tarefas 3 e 12; recusas agregadas pelo achado S11.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MINUTO_MS = 60_000;
const MAX_TEXTO = 80;
// Controles (C0, C1), formatação (direção de texto, largura zero) e separadores de linha/parágrafo.
const INVISIVEIS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ABRIR = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
const RE_MOTIVO = /^[a-z_]{1,20}$/;
// Fim da primeira frase de um erro: ponto, dois-pontos ou quebra de linha (achado S24).
const FIM_DA_FRASE = /[.:\r\n\p{Zl}\p{Zp}]/u;

// Texto que vai para a linha: sem invisíveis e com no máximo 80 caracteres. Número vira texto;
// qualquer outra coisa (objeto, lista, nulo) vira null, para nada de `dados` escapar por engano.
function limpar(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) valor = String(valor);
  if (typeof valor !== 'string') return null;
  return Array.from(valor.replace(INVISIVEIS, '')).slice(0, MAX_TEXTO).join('');
}

// Só a primeira frase de um erro, sem o delimitador, cortada em 80: o resto costuma ser o fim do
// stderr de um processo (caminhos, trechos de arquivo). Vazio vira null.
function primeiraFrase(valor) {
  if (typeof valor !== 'string') return null;
  const frase = valor.split(FIM_DA_FRASE, 1)[0].replace(INVISIVEIS, '').trim();
  const cortada = Array.from(frase).slice(0, MAX_TEXTO).join('').trimEnd();
  return cortada || null;
}

// `auditoria.jsonl` → `auditoria-recusas.jsonl`, na mesma pasta.
const nomeDasRecusas = (arquivo) => path.join(path.dirname(arquivo), `${path.basename(arquivo, '.jsonl')}-recusas.jsonl`);

// Caminho real, ou o caminho absoluto se ele não existe (uma pasta pessoal que não existe não é esta pasta).
function caminhoReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Cria a pasta só para o dono e, se ela já existir mais aberta e for deste usuário, fecha para 700:
// quem pudesse apagar arquivos dela (comandos-vistos.json) desarmaria a proteção contra repetição.
export function pastaSoDoDono(pasta) {
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  // Nunca a pasta pessoal nem a raiz: um arquivo de configuração posto direto em ~ não fecha a casa inteira.
  const real = fs.realpathSync(pasta);
  if (real === path.parse(real).root || real === caminhoReal(os.homedir())) return;
  const st = fs.statSync(pasta);
  if (st.isDirectory() && (st.mode & 0o077) !== 0 && st.uid === process.getuid?.()) fs.chmodSync(pasta, 0o700);
}

// Grava `texto` em `arquivo` de uma vez: num temporário novo (<arquivo>.<pid>.tmp, criado exclusivo e com
// permissão 600) e rename, para quem lê nunca ver o arquivo pela metade. A pasta é garantida por
// pastaSoDoDono; com `fsync`, os dados vão ao disco antes do rename. No erro, apaga o temporário e relança
// o erro original: o log (só com o código do erro) fica com quem chama.
export function escreverAtomico(arquivo, texto, { fsync = false } = {}) {
  const tmp = `${arquivo}.${process.pid}.tmp`;
  let fd = null;
  try {
    pastaSoDoDono(path.dirname(arquivo));
    fs.rmSync(tmp, { force: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, texto);
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* já fechado */
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nada a limpar */
    }
    throw err;
  }
}

export class Auditoria {
  constructor({ arquivo, arquivoRecusas, agora = () => Date.now(), maxBytes = 5_000_000, maxRecusasPorMinuto = 20 }) {
    this.arquivo = arquivo;
    this.arquivoRecusas = arquivoRecusas ?? nomeDasRecusas(arquivo);
    this.agora = agora;
    this.maxBytes = maxBytes;
    this.maxRecusasPorMinuto = maxRecusasPorMinuto;
    this.minuto = null;
    this.recusas = 0;
    this.suprimidas = new Map(); // motivo → recusas não gravadas no minuto corrente
  }

  // Uma linha por chamada. Recusas além do teto do minuto só são contadas (por motivo) e saem numa
  // linha de resumo na primeira chamada do minuto seguinte. Nunca lança: falha vira aviso sem conteúdo.
  // Na linha de recusa, `quem` só existe depois da assinatura conferir; antes, o kid que o comando
  // diz ter vai em `kidInformado` (achado A5).
  registrar(entrada) {
    try {
      const { id, tipo, chave, quem, kidInformado = null, decisao, motivo = null, resultado = null } = entrada ?? {};
      const agora = this.agora();
      const em = new Date(agora).toISOString();
      const minuto = Math.floor(agora / MINUTO_MS);
      if (minuto !== this.minuto) {
        this.minuto = minuto;
        this.recusas = 0;
        this.#resumir(em);
      }
      if (decisao === 'recusado') {
        if (++this.recusas > this.maxRecusasPorMinuto) {
          const m = typeof motivo === 'string' && RE_MOTIVO.test(motivo) ? motivo : 'outro';
          this.suprimidas.set(m, (this.suprimidas.get(m) ?? 0) + 1);
          return;
        }
        this.#escrever(this.arquivoRecusas, {
          em,
          id: limpar(id),
          tipo: limpar(tipo),
          sessao: limpar(chave),
          quem: limpar(quem),
          kidInformado: limpar(kidInformado),
          decisao: 'recusado',
          motivo: limpar(motivo),
          resultado: limpar(resultado),
        });
        return;
      }
      this.#escrever(this.arquivo, {
        em,
        id: limpar(id),
        tipo: limpar(tipo),
        sessao: limpar(chave),
        quem: limpar(quem),
        decisao: limpar(decisao),
        motivo: limpar(motivo),
        resultado: decisao === 'falhou' ? primeiraFrase(resultado) : limpar(resultado),
      });
    } catch (err) {
      console.error(`auditoria: não foi possível gravar o registro (${err?.code || 'erro'}).`);
    }
  }

  // Grava já a linha de resumo das recusas suprimidas no minuto corrente, sem esperar a virada
  // (o coletor chama ao parar). Sem nada suprimido, não grava nada. Nunca lança.
  descarregar() {
    try {
      this.#resumir(new Date(this.agora()).toISOString());
    } catch (err) {
      console.error(`auditoria: não foi possível gravar o registro (${err?.code || 'erro'}).`);
    }
  }

  // Linha de resumo das suprimidas, com a contagem por motivo, no arquivo das recusas. A contagem é
  // zerada antes de gravar: se a gravação falhar, o resumo se perde, mas não sai duas vezes.
  #resumir(em) {
    if (this.suprimidas.size === 0) return;
    const porMotivo = Object.fromEntries([...this.suprimidas].sort(([a], [b]) => (a < b ? -1 : 1)));
    const total = [...this.suprimidas.values()].reduce((s, n) => s + n, 0);
    this.suprimidas = new Map();
    this.#escrever(this.arquivoRecusas, { em, decisao: 'recusado', motivo: 'suprimidas', resultado: `${total} recusas`, porMotivo });
  }

  // Acrescenta a linha; se ela fizer o arquivo passar de maxBytes, o atual vira <arquivo>.1
  // (substituindo o anterior) e a linha abre um arquivo novo. Os dois ficam com permissão 600.
  // Cada arquivo (aceitos e recusas) gira sozinho.
  #escrever(arquivo, obj) {
    const linha = `${JSON.stringify(obj)}\n`;
    pastaSoDoDono(path.dirname(arquivo));
    let fd = fs.openSync(arquivo, ABRIR, 0o600);
    try {
      const { size } = fs.fstatSync(fd);
      if (size > 0 && size + Buffer.byteLength(linha) > this.maxBytes) {
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(arquivo, `${arquivo}.1`);
        fd = fs.openSync(arquivo, ABRIR, 0o600);
      }
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, linha);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}
