// Guarda a chave de comandos deste aparelho no IndexedDB (banco `moises`, armazém `chaves`, registro `comandos`).
// Só fica guardado o par { kid, chave }, com a chave num CryptoKey NÃO extraível (public/assinatura.js): o código
// digitado nunca passa por aqui. Nada vai para localStorage nem sessionStorage. Sem IndexedDB (navegação privada,
// bloqueio do navegador), as funções rejeitam com CofreIndisponivel e o painel avisa; não há plano B.

const BANCO = 'moises';
const VERSAO = 1;
const ARMAZEM = 'chaves';
const REGISTRO = 'comandos';
const RE_KID = /^[a-z0-9]{6}$/;

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

const chaveValida = (chave) =>
  typeof CryptoKey !== 'undefined' && chave instanceof CryptoKey && chave.extractable === false;

// Substitui o que houver. Recusa chave extraível: o que fica no aparelho não pode ser copiado.
export async function guardar({ kid, chave }) {
  if (typeof kid !== 'string' || !RE_KID.test(kid) || !chaveValida(chave)) throw new TypeError('Chave do aparelho inválida.');
  await noArmazem('readwrite', (armazem) => armazem.put({ kid, chave }, REGISTRO));
}

// → { kid, chave } ou null se o aparelho ainda não tem chave. Registro fora do formato conta como ausente.
export async function obter() {
  const reg = await noArmazem('readonly', (armazem) => armazem.get(REGISTRO));
  if (!reg || typeof reg.kid !== 'string' || !RE_KID.test(reg.kid) || !chaveValida(reg.chave)) return null;
  return { kid: reg.kid, chave: reg.chave };
}

export async function esquecer() {
  await noArmazem('readwrite', (armazem) => armazem.delete(REGISTRO));
}
