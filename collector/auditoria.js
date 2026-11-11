// Registro de auditoria local do canal de comandos: uma linha JSON por decisão (aceito, recusado,
// feito, falhou), num arquivo com permissão 600 que nunca sai da máquina. Nada de texto de mensagem,
// `dados` ou chave aqui: só metadados do comando, cortados e sem caracteres de controle.
// Contrato no PLANO, tarefa 3; recusas agregadas pelo achado S11.
import fs from 'node:fs';
import path from 'node:path';

const MINUTO_MS = 60_000;
const MAX_TEXTO = 80;
// Controles (C0, C1), formatação (direção de texto, largura zero) e separadores de linha/parágrafo.
const INVISIVEIS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const ABRIR = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

// Texto que vai para a linha: sem invisíveis e com no máximo 80 caracteres. Número vira texto;
// qualquer outra coisa (objeto, lista, nulo) vira null, para nada de `dados` escapar por engano.
function limpar(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) valor = String(valor);
  if (typeof valor !== 'string') return null;
  return Array.from(valor.replace(INVISIVEIS, '')).slice(0, MAX_TEXTO).join('');
}

export class Auditoria {
  constructor({ arquivo, agora = () => Date.now(), maxBytes = 5_000_000, maxRecusasPorMinuto = 20 }) {
    this.arquivo = arquivo;
    this.agora = agora;
    this.maxBytes = maxBytes;
    this.maxRecusasPorMinuto = maxRecusasPorMinuto;
    this.minuto = null;
    this.recusas = 0;
    this.suprimidas = 0;
  }

  // Uma linha por chamada. Recusas além do teto do minuto só são contadas e saem numa linha de
  // resumo na primeira chamada do minuto seguinte. Nunca lança: falha vira aviso sem conteúdo.
  registrar(entrada) {
    try {
      const { id, tipo, chave, quem, decisao, motivo = null, resultado = null } = entrada ?? {};
      const agora = this.agora();
      const em = new Date(agora).toISOString();
      const minuto = Math.floor(agora / MINUTO_MS);
      if (minuto !== this.minuto) {
        const suprimidas = this.suprimidas;
        this.minuto = minuto;
        this.recusas = 0;
        this.suprimidas = 0;
        if (suprimidas > 0) this.#escrever({ em, decisao: 'recusado', motivo: 'suprimidas', resultado: `${suprimidas} recusas` });
      }
      if (decisao === 'recusado' && ++this.recusas > this.maxRecusasPorMinuto) {
        this.suprimidas++;
        return;
      }
      this.#escrever({
        em,
        id: limpar(id),
        tipo: limpar(tipo),
        sessao: limpar(chave),
        quem: limpar(quem),
        decisao: limpar(decisao),
        motivo: limpar(motivo),
        resultado: limpar(resultado),
      });
    } catch (err) {
      console.error(`auditoria: não foi possível gravar o registro (${err?.code || 'erro'}).`);
    }
  }

  // Grava já a linha de resumo das recusas suprimidas no minuto corrente, sem esperar a virada
  // (o coletor chama ao parar). Sem nada suprimido, não grava nada. Nunca lança.
  descarregar() {
    try {
      if (this.suprimidas <= 0) return;
      const em = new Date(this.agora()).toISOString();
      this.#escrever({ em, decisao: 'recusado', motivo: 'suprimidas', resultado: `${this.suprimidas} recusas` });
      this.suprimidas = 0;
    } catch (err) {
      console.error(`auditoria: não foi possível gravar o registro (${err?.code || 'erro'}).`);
    }
  }

  // Acrescenta a linha; se ela fizer o arquivo passar de maxBytes, o atual vira <arquivo>.1
  // (substituindo o anterior) e a linha abre um arquivo novo. Os dois ficam com permissão 600.
  #escrever(obj) {
    const linha = `${JSON.stringify(obj)}\n`;
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true, mode: 0o700 });
    let fd = fs.openSync(this.arquivo, ABRIR, 0o600);
    try {
      const { size } = fs.fstatSync(fd);
      if (size > 0 && size + Buffer.byteLength(linha) > this.maxBytes) {
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(this.arquivo, `${this.arquivo}.1`);
        fd = fs.openSync(this.arquivo, ABRIR, 0o600);
      }
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, linha);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}
