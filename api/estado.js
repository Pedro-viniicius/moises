import { rota, json, exigeLogin, pipeline, lerComandos, chegadaDoComando, expirarSeVencido, K } from './_lib.js';

// painelVistoEm só é regravado depois disso: o coletor acelera com o painel visto há menos de 60 s.
const VISTO_REGRAVA_MS = 30_000;

export default rota(['GET'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  const [retrato, recebidoEm, cmds, rec, fim, vistoEm] = await pipeline([
    ['GET', K.retrato],
    ['GET', K.recebidoEm],
    ['HGETALL', K.cmds],
    ['HGETALL', K.cmdsRec],
    ['HGETALL', K.cmdsFim],
    ['GET', K.painelVistoEm],
  ]);
  const agora = Date.now();
  const muda = [];
  // painelVistoEm diz ao coletor que o dono está olhando (ele pode acelerar o ritmo). Gravado no máximo a
  // cada 30 s; valor no futuro ou que não é número é regravado.
  const visto = Number(vistoEm);
  if (!(Number.isFinite(visto) && visto <= agora && agora - visto < VISTO_REGRAVA_MS)) muda.push(['SET', K.painelVistoEm, String(agora)]);
  // Com o coletor parado ninguém expira os pendentes: expira aqui também, para o painel mostrar
  // "expirado" e o Redis não guardar dados nem assinatura além da validade. O estado mostrado é a junção
  // do objeto com cmds-rec e cmds-fim: um ack que chegue enquanto isto grava prevalece sobre o expirado.
  const { itens } = lerComandos(cmds, rec, fim);
  for (const item of itens) {
    const gravar = expirarSeVencido(item, agora);
    if (gravar) muda.push(gravar);
  }
  await pipeline(muda);
  // Lista fechada de campos: dados e assinatura nunca voltam ao painel.
  const comandos = itens
    .map((i) => i.vista)
    .sort((a, b) => chegadaDoComando(b) - chegadaDoComando(a))
    .map(({ id, tipo, chave, estado, erro, motivo, criadoEm }) => ({ id, tipo, chave, estado, erro: erro ?? null, motivo: motivo ?? null, criadoEm }));
  json(res, 200, { retrato: retrato ? JSON.parse(retrato) : null, recebidoEm: recebidoEm ? Number(recebidoEm) : null, comandos });
});
