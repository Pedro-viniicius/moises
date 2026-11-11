import { rota, json, exigeLogin, pipeline, hashParaObjetos, chegadaDoComando, expirarSeVencido, K } from './_lib.js';

export default rota(['GET'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  // painelVistoEm diz ao coletor que o dono está olhando (ele pode acelerar o ritmo).
  const [retrato, recebidoEm, cmds] = await pipeline([
    ['GET', K.retrato],
    ['GET', K.recebidoEm],
    ['HGETALL', K.cmds],
    ['SET', K.painelVistoEm, String(Date.now())],
  ]);
  // Com o coletor parado ninguém expira os pendentes: expira aqui também, para o painel mostrar
  // "expirado" e o Redis não guardar dados nem assinatura além da validade.
  const agora = Date.now();
  const lista = hashParaObjetos(cmds);
  const vencidos = lista.filter((c) => expirarSeVencido(c, agora));
  if (vencidos.length) await pipeline(vencidos.map((c) => ['HSET', K.cmds, c.id, JSON.stringify(c)]));
  // Lista fechada de campos: dados e assinatura nunca voltam ao painel.
  const comandos = lista
    .sort((a, b) => chegadaDoComando(b) - chegadaDoComando(a))
    .map(({ id, tipo, chave, estado, erro, motivo, criadoEm }) => ({ id, tipo, chave, estado, erro: erro ?? null, motivo: motivo ?? null, criadoEm }));
  json(res, 200, { retrato: retrato ? JSON.parse(retrato) : null, recebidoEm: recebidoEm ? Number(recebidoEm) : null, comandos });
});
