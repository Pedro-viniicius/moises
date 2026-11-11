import { rota, json, lerCorpo, tokenColetorValido, pipeline, hashParaObjetos, K, EXPIRA_CMD_MS } from './_lib.js';

const GUARDA_CMD_MS = 24 * 3600 * 1000;

export default rota(['POST'], async (req, res) => {
  if (!tokenColetorValido(req)) return json(res, 401, { erro: 'Token inválido.' });
  const { retrato, acks } = await lerCorpo(req);
  const agora = Date.now();
  const [, cmdsArr] = await pipeline([['SET', K.recebidoEm, String(agora)], ['HGETALL', K.cmds]]);
  const cmds = new Map(hashParaObjetos(cmdsArr).map((c) => [c.id, c]));
  const muda = [];
  if (retrato && typeof retrato === 'object' && Array.isArray(retrato.sessoes)) muda.push(['SET', K.retrato, JSON.stringify(retrato)]);

  for (const a of Array.isArray(acks) ? acks : []) {
    const c = cmds.get(a?.id);
    if (!c) continue;
    c.estado = a.ok ? 'feito' : 'falhou';
    c.erro = a.ok ? null : String(a.erro || 'falhou').slice(0, 200);
    c.feitoEm = agora;
    muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
    if (a.ok && a.log && typeof a.log === 'object') {
      const log = { ...a.log, id: c.id, chave: c.chave, nome: String(a.log.nome || c.nome || c.chave).slice(0, 140), criadoEm: agora };
      muda.push(['HSET', K.logs, log.id, JSON.stringify(log)]);
    }
  }

  const pendentes = [];
  for (const c of cmds.values()) {
    const idade = agora - c.criadoEm;
    if (c.estado === 'pendente' && idade >= EXPIRA_CMD_MS) {
      c.estado = 'expirado';
      muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
    } else if (c.estado === 'pendente') {
      pendentes.push({ id: c.id, tipo: c.tipo, chave: c.chave, nome: c.nome, idadeMs: idade });
    } else if (idade > GUARDA_CMD_MS) {
      muda.push(['HDEL', K.cmds, c.id]);
    }
  }
  await pipeline(muda);
  json(res, 200, { comandos: pendentes });
});
