import { rota, json, exigeLogin, exigeJson, lerCorpo, redis, hashParaObjetos, K } from './_lib.js';

const MAX_LOGS = 500;
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export default rota(['GET', 'PATCH'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  if (req.method === 'GET') {
    const q = norm(new URL(req.url, 'http://x').searchParams.get('q'));
    let logs = hashParaObjetos(await redis('HGETALL', K.logs)).sort((a, b) => b.criadoEm - a.criadoEm);
    // Guarda só os 500 mais recentes.
    if (logs.length > MAX_LOGS) {
      await redis('HDEL', K.logs, ...logs.slice(MAX_LOGS).map((l) => l.id));
      logs = logs.slice(0, MAX_LOGS);
    }
    if (q) logs = logs.filter((l) => norm([l.nome, l.projeto, l.tarefa, l.resumo].join(' ')).includes(q));
    return json(res, 200, { logs });
  }
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const { id, nome } = await lerCorpo(req, 10_000);
  if (typeof id !== 'string' || typeof nome !== 'string' || !nome.trim()) return json(res, 400, { erro: 'Informe id e nome.' });
  const atual = await redis('HGET', K.logs, id);
  if (!atual) return json(res, 404, { erro: 'Log não encontrado.' });
  const log = { ...JSON.parse(atual), nome: nome.trim().slice(0, 140) };
  await redis('HSET', K.logs, id, JSON.stringify(log));
  json(res, 200, { ok: true });
});
