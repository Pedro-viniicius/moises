// Pedido de pareamento de um aparelho (tarefa 15, achado A1). O navegador gerou um par ECDSA P-256 com a
// chave privada não extraível e manda só a pública, o kid e um rótulo. O servidor guarda o pedido por 1 h
// (no máximo 5) e o ingest o entrega ao coletor; quem autoriza é o dono, no terminal do computador,
// conferindo a impressão digital. Nada aqui autoriza coisa alguma: só transporta.
import crypto from 'node:crypto';
import {
  rota,
  json,
  exigeLogin,
  exigeJson,
  lerCorpo,
  pipeline,
  pedidosDeAparelho,
  K,
  MAX_PEDIDOS_APARELHO,
} from './_lib.js';

const MAX_CORPO = 2_000;
const CAMPOS = ['kid', 'publica', 'rotulo'];
const RE_KID = /^[0-9a-f]{6}$/;
const RE_PUBLICA = /^[A-Za-z0-9_-]{87}$/;
const MAX_ROTULO = 40;
const INVISIVEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// Pública `raw` P-256 (0x04 || x || y) em base64url canônico, com o ponto na curva; senão null.
function bytesDaPublica(publica) {
  if (typeof publica !== 'string' || !RE_PUBLICA.test(publica)) return null;
  const bytes = Buffer.from(publica, 'base64url');
  if (bytes.length !== 65 || bytes[0] !== 4 || bytes.toString('base64url') !== publica) return null;
  try {
    const jwk = { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') };
    crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return null;
  }
  return bytes;
}

// Devolve o nome do primeiro campo fora do formato, ou null. Nunca devolve conteúdo.
function campoInvalido(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'corpo';
  if (Object.keys(c).some((k) => !CAMPOS.includes(k))) return 'campo desconhecido';
  const bytes = bytesDaPublica(c.publica);
  if (!bytes) return 'publica';
  // O kid é o da própria chave: 6 primeiros hexadecimais do SHA-256 da pública raw.
  if (typeof c.kid !== 'string' || !RE_KID.test(c.kid)) return 'kid';
  if (crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 6) !== c.kid) return 'kid';
  if (typeof c.rotulo !== 'string' || INVISIVEL.test(c.rotulo)) return 'rotulo';
  const n = Array.from(c.rotulo.trim()).length;
  if (n < 1 || n > MAX_ROTULO) return 'rotulo';
  return null;
}

export default rota(['POST'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const corpo = await lerCorpo(req, MAX_CORPO);
  const invalido = campoInvalido(corpo);
  if (invalido) return json(res, 400, { erro: `Pedido de autorização inválido (${invalido}).` });

  const agora = Date.now();
  const [arr] = await pipeline([['HGETALL', K.aparelhosPedidos]]);
  const { validos, vencidos } = pedidosDeAparelho(arr, agora);
  const muda = vencidos.map((kid) => ['HDEL', K.aparelhosPedidos, kid]);
  // O mesmo aparelho pedindo de novo substitui o próprio pedido; um novo só entra se houver vaga.
  const outros = validos.filter((p) => p.kid !== corpo.kid);
  if (outros.length >= MAX_PEDIDOS_APARELHO) {
    await pipeline(muda);
    return json(res, 429, { erro: 'Há pedidos de autorização demais esperando o computador. Autorize os que são seus ou espere uma hora e tente de novo.' });
  }
  const pedido = { kid: corpo.kid, publica: corpo.publica, rotulo: corpo.rotulo.trim(), criadoEm: agora };
  await pipeline([...muda, ['HSET', K.aparelhosPedidos, pedido.kid, JSON.stringify(pedido)]]);
  json(res, 200, { kid: pedido.kid });
});
