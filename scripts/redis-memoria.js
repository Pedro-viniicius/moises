// Redis falso em memória, no formato da API REST do Upstash. Usado nos testes e no servidor local.
export function instalarRedisFalso() {
  const db = new Map();
  const h = (k) => (db.has(k) ? db.get(k) : db.set(k, new Map()).get(k));
  const exec = ([cmd, ...a]) => {
    switch (cmd) {
      case 'GET': return db.get(a[0]) ?? null;
      case 'SET': db.set(a[0], a[1]); return 'OK';
      case 'DEL': return db.delete(a[0]) ? 1 : 0;
      case 'INCR': { const v = Number(db.get(a[0]) || 0) + 1; db.set(a[0], String(v)); return v; }
      case 'EXPIRE': return 1;
      case 'HSET': h(a[0]).set(a[1], a[2]); return 1;
      case 'HSETNX': if (h(a[0]).has(a[1])) return 0; h(a[0]).set(a[1], a[2]); return 1;
      case 'HGET': return db.get(a[0])?.get(a[1]) ?? null;
      case 'HDEL': return db.get(a[0])?.delete(a[1]) ? 1 : 0;
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
    const res = String(url).endsWith('/pipeline') ? corpo.map((c) => ({ result: exec(c) })) : { result: exec(corpo) };
    return { json: async () => res };
  };
  return { db, limpar: () => db.clear() };
}
