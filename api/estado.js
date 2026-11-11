import { rota, json, exigeLogin, pipeline, hashParaObjetos, K } from './_lib.js';

export default rota(['GET'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  const [retrato, recebidoEm, cmds] = await pipeline([['GET', K.retrato], ['GET', K.recebidoEm], ['HGETALL', K.cmds]]);
  const comandos = hashParaObjetos(cmds)
    .sort((a, b) => b.criadoEm - a.criadoEm)
    .map(({ id, chave, nome, estado, erro, criadoEm }) => ({ id, chave, nome, estado, erro: erro ?? null, criadoEm }));
  json(res, 200, { retrato: retrato ? JSON.parse(retrato) : null, recebidoEm: recebidoEm ? Number(recebidoEm) : null, comandos });
});
