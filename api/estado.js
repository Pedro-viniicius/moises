import { rota, json, exigeLogin, pipeline, hashParaObjetos, chegadaDoComando, K } from './_lib.js';

export default rota(['GET'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  // painelVistoEm diz ao coletor que o dono está olhando (ele pode acelerar o ritmo).
  const [retrato, recebidoEm, cmds] = await pipeline([
    ['GET', K.retrato],
    ['GET', K.recebidoEm],
    ['HGETALL', K.cmds],
    ['SET', K.painelVistoEm, String(Date.now())],
  ]);
  // Lista fechada de campos: dados e assinatura nunca voltam ao painel.
  const comandos = hashParaObjetos(cmds)
    .sort((a, b) => chegadaDoComando(b) - chegadaDoComando(a))
    .map(({ id, tipo, chave, estado, erro, motivo, criadoEm }) => ({ id, tipo, chave, estado, erro: erro ?? null, motivo: motivo ?? null, criadoEm }));
  json(res, 200, { retrato: retrato ? JSON.parse(retrato) : null, recebidoEm: recebidoEm ? Number(recebidoEm) : null, comandos });
});
