// Guarda a chave de comandos deste aparelho no IndexedDB (banco `moises`, armazém `chaves`, registro `comandos`).
// Fica guardado { kid, chave, publica }: a chave privada ECDSA P-256 num CryptoKey NÃO extraível, gerada aqui mesmo
// (public/assinatura.js), e a chave pública, que não é segredo e serve para mostrar a impressão digital e pedir a
// autorização de novo. Nada secreto é digitado (achado A1). Nada vai para localStorage nem sessionStorage. Sem
// IndexedDB (navegação privada, bloqueio do navegador), as funções rejeitam com CofreIndisponivel e o painel avisa;
// não há plano B.

const BANCO = 'moises';
const VERSAO = 1;
const ARMAZEM = 'chaves';
const REGISTRO = 'comandos';
const RE_KID = /^[0-9a-f]{6}$/;
const RE_PUBLICA = /^[A-Za-z0-9_-]{87}$/;

export class CofreIndisponivel extends Error {
  constructor() {
    super('IndexedDB indisponível.');
    this.name = 'CofreIndisponivel';
  }
}

function abrirBanco() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      if (!globalThis.indexedDB) throw new CofreIndisponivel();
      req = globalThis.indexedDB.open(BANCO, VERSAO);
    } catch {
      reject(new CofreIndisponivel());
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ARMAZEM)) req.result.createObjectStore(ARMAZEM);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new CofreIndisponivel());
    req.onblocked = () => reject(new CofreIndisponivel());
  });
}

// Roda uma operação no armazém e só resolve quando a transação termina (gravação confirmada).
async function noArmazem(modo, operacao) {
  const banco = await abrirBanco();
  try {
    return await new Promise((resolve, reject) => {
      const tx = banco.transaction(ARMAZEM, modo);
      let resultado;
      tx.oncomplete = () => resolve(resultado);
      tx.onerror = () => reject(new CofreIndisponivel());
      tx.onabort = () => reject(new CofreIndisponivel());
      const req = operacao(tx.objectStore(ARMAZEM)); // put de CryptoKey pode lançar DataCloneError aqui
      req.onsuccess = () => { resultado = req.result; };
    });
  } catch {
    throw new CofreIndisponivel();
  } finally {
    banco.close();
  }
}

// Só a chave privada ECDSA P-256, não extraível, que assina. A chave HMAC do antigo código do aparelho não vale mais.
const chaveValida = (chave) =>
  typeof CryptoKey !== 'undefined' && chave instanceof CryptoKey && chave.extractable === false &&
  chave.type === 'private' && chave.algorithm?.name === 'ECDSA' && chave.algorithm?.namedCurve === 'P-256' &&
  chave.usages.includes('sign');

const registroValido = (r) =>
  !!r && typeof r.kid === 'string' && RE_KID.test(r.kid) && typeof r.publica === 'string' && RE_PUBLICA.test(r.publica) && chaveValida(r.chave);

// Substitui o que houver. Recusa chave extraível: o que fica no aparelho não pode ser copiado.
export async function guardar({ kid, chave, publica }) {
  if (!registroValido({ kid, chave, publica })) throw new TypeError('Chave do aparelho inválida.');
  await noArmazem('readwrite', (armazem) => armazem.put({ kid, chave, publica }, REGISTRO));
}

// → { kid, chave, publica } ou null se o aparelho ainda não tem chave. Registro fora do formato (inclusive o do
// antigo código do aparelho) conta como ausente.
export async function obter() {
  const reg = await noArmazem('readonly', (armazem) => armazem.get(REGISTRO));
  if (!registroValido(reg)) return null;
  return { kid: reg.kid, chave: reg.chave, publica: reg.publica };
}

export async function esquecer() {
  await noArmazem('readwrite', (armazem) => armazem.delete(REGISTRO));
}
