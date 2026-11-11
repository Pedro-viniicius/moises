// Redis falso em memória, no formato da API REST do Upstash. Usado nos testes e no servidor local.
// `SET chave valor EX segundos` expira pela hora de Date.now() (os testes adiantam o relógio).
export function instalarRedisFalso() {
  const db = new Map();
  const expira = new Map(); // chave → instante (ms) em que deixa de existir
  const h = (k) => (db.has(k) ? db.get(k) : db.set(k, new Map()).get(k));
  const vencer = (k) => {
    if (expira.has(k) && Date.now() >= expira.get(k)) {
      db.delete(k);
      expira.delete(k);
    }
  };
  const set = (k, v, opcoes) => {
    const i = opcoes.findIndex((o) => String(o).toUpperCase() === 'EX');
    if (i >= 0 && !(Number(opcoes[i + 1]) > 0)) throw new Error('ERR invalid expire time in set');
    db.set(k, v);
    if (i >= 0) expira.set(k, Date.now() + Number(opcoes[i + 1]) * 1000);
    else expira.delete(k);
    return 'OK';
  };
  const exec = ([cmd, ...a]) => {
    vencer(a[0]);
    switch (cmd) {
      case 'GET': return db.get(a[0]) ?? null;
      case 'SET': return set(a[0], a[1], a.slice(2));
      case 'DEL': expira.delete(a[0]); return db.delete(a[0]) ? 1 : 0;
      case 'INCR': { const v = Number(db.get(a[0]) || 0) + 1; db.set(a[0], String(v)); return v; }
      case 'EXPIRE': return 1;
      case 'HSET': h(a[0]).set(a[1], a[2]); return 1;
      case 'HSETNX': if (h(a[0]).has(a[1])) return 0; h(a[0]).set(a[1], a[2]); return 1;
      case 'HGET': return db.get(a[0])?.get(a[1]) ?? null;
      // Como no Redis, HDEL aceita vários campos e devolve quantos existiam.
      case 'HDEL': return a.slice(1).filter((campo) => db.get(a[0])?.delete(campo)).length;
      case 'HGETALL': return [...(db.get(a[0]) || new Map())].flat();
      default: throw new Error(`comando não simulado: ${cmd}`);
    }
  };
  const fetchReal = globalThis.fetch;
  process.env.KV_REST_API_URL ||= 'https://redis.memoria';
  process.env.KV_REST_API_TOKEN ||= 'memoria';
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://redis.memoria')) return fetchReal(url, opts);
    const corpo = JSON.parse(opts.body);
    // Como no Upstash: o pipeline não para no comando que falha (não é atômico); o erro vai na posição dele.
    const um = (c) => {
      try {
        return { result: exec(c) };
      } catch (err) {
        return { error: err.message };
      }
    };
    const res = String(url).endsWith('/pipeline') ? corpo.map(um) : um(corpo);
    return { json: async () => res };
  };
  return {
    db,
    limpar: () => {
      db.clear();
      expira.clear();
    },
  };
}
