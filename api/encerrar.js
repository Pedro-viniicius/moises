import crypto from 'node:crypto';
import { rota, json, exigeLogin, exigeJson, lerCorpo, pipeline, hashParaObjetos, K, EXPIRA_CMD_MS } from './_lib.js';

export default rota(['POST'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const { chave, nome } = await lerCorpo(req, 10_000);
  if (typeof chave !== 'string' || !chave) return json(res, 400, { erro: 'Informe a sessão.' });
  const [retratoTxt, cmdsArr] = await pipeline([['GET', K.retrato], ['HGETALL', K.cmds]]);
  const sessao = retratoTxt ? JSON.parse(retratoTxt).sessoes.find((s) => s.chave === chave) : null;
  if (!sessao) return json(res, 404, { erro: 'Sessão não encontrada no último retrato.' });
  if (sessao.status === 'encerrada') return json(res, 409, { erro: 'Essa sessão já está encerrada.' });
  const agora = Date.now();
  const pendente = hashParaObjetos(cmdsArr).find((c) => c.chave === chave && c.estado === 'pendente' && agora - c.criadoEm < EXPIRA_CMD_MS);
  if (pendente) return json(res, 409, { erro: 'Já existe um pedido para essa sessão.' });
  const cmd = {
    id: `c_${crypto.randomBytes(8).toString('hex')}`,
    tipo: 'encerrar',
    chave,
    nome: typeof nome === 'string' && nome.trim() ? nome.trim().slice(0, 140) : null,
    estado: 'pendente',
    erro: null,
    criadoEm: agora,
  };
  await pipeline([['HSET', K.cmds, cmd.id, JSON.stringify(cmd)]]);
  json(res, 200, { id: cmd.id });
});
