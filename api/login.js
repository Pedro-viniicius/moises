import { rota, json, lerCorpo, exigeJson, ipDe, conferirSenha, cookieDeSessao, pipeline, K } from './_lib.js';

const JANELA_S = 15 * 60;
const MAX_POR_IP = 5; // senha gerada tem ~79 bits: o limite por IP basta, sem trava global que qualquer um aciona

export default rota(['POST'], async (req, res) => {
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const ip = ipDe(req);
  // Conta a tentativa antes de conferir: pedidos em paralelo não passam do limite.
  const [tentativas] = await pipeline([['INCR', K.tentativas(ip)], ['EXPIRE', K.tentativas(ip), JANELA_S, 'NX']]);
  if (Number(tentativas) > MAX_POR_IP) {
    return json(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.', tenteEmS: JANELA_S });
  }
  const { senha } = await lerCorpo(req, 10_000);
  if (!conferirSenha(senha)) return json(res, 401, { erro: 'Senha incorreta.' });
  await pipeline([['DEL', K.tentativas(ip)]]);
  json(res, 200, { ok: true }, { 'set-cookie': cookieDeSessao() });
});
