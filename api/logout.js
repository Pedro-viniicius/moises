import { rota, json, cookieApagado } from './_lib.js';

export default rota(['POST'], async (_req, res) => {
  json(res, 200, { ok: true }, { 'set-cookie': cookieApagado });
});
