import { rota, json, lerCorpo, exigeJson, ipDe, conferirSenha, cookieDeSessao, pipeline, K } from './_lib.js';

const JANELA_S = 15 * 60;
const MAX_POR_IP = 5;
const MAX_TOTAL = 30; // freio contra tentativa distribuída

export default rota(['POST'], async (req, res) => {
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const ip = ipDe(req);
  const [porIp, total] = (await pipeline([['GET', K.tentativas(ip)], ['GET', K.tentativasTodas]])).map(Number);
  if (porIp >= MAX_POR_IP || total >= MAX_TOTAL) {
    return json(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.', tenteEmS: JANELA_S });
  }
  const { senha } = await lerCorpo(req, 10_000);
  if (!conferirSenha(senha)) {
    await pipeline([
      ['INCR', K.tentativas(ip)],
      ['EXPIRE', K.tentativas(ip), JANELA_S, 'NX'],
      ['INCR', K.tentativasTodas],
      ['EXPIRE', K.tentativasTodas, JANELA_S, 'NX'],
    ]);
    return json(res, 401, { erro: 'Senha incorreta.' });
  }
  await pipeline([['DEL', K.tentativas(ip)]]);
  json(res, 200, { ok: true }, { 'set-cookie': cookieDeSessao() });
});
