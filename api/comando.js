// Recebe do painel um comando assinado no aparelho e o guarda para o coletor buscar.
// O servidor não tem a chave: confere só formato e tamanho. Quem decide se o comando vale é o coletor.
import {
  rota,
  json,
  exigeLogin,
  exigeJson,
  lerCorpo,
  redis,
  pipeline,
  hashParaObjetos,
  expirarSeVencido,
  K,
  TIPOS_CMD,
  RE_CHAVE,
  MAX_PENDENTES,
} from './_lib.js';

const MAX_CORPO = 40_000; // dados tem até 8.000 caracteres; acentos e aspas escapadas ocupam mais de um byte
const MAX_DADOS = 8_000;
const CAMPOS = ['v', 'kid', 'id', 'tipo', 'chave', 'criadoEm', 'dados', 'assinatura'];

function dadosValidos(dados) {
  if (typeof dados !== 'string' || dados.length > MAX_DADOS) return false;
  try {
    const obj = JSON.parse(dados);
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
  } catch {
    return false;
  }
}

// Devolve o nome do primeiro campo fora do contrato, ou null. Nunca devolve conteúdo.
function campoInvalido(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'corpo';
  const extra = Object.keys(c).find((k) => !CAMPOS.includes(k));
  if (extra !== undefined) return 'campo desconhecido';
  if (c.v !== 1) return 'v';
  if (typeof c.kid !== 'string' || !/^[a-z0-9]{6}$/.test(c.kid)) return 'kid';
  if (typeof c.id !== 'string' || !/^c_[0-9a-f]{16}$/.test(c.id)) return 'id';
  if (!TIPOS_CMD.includes(c.tipo)) return 'tipo';
  if (c.tipo === 'abrir' ? c.chave !== null : typeof c.chave !== 'string' || !RE_CHAVE.test(c.chave)) return 'chave';
  if (!Number.isSafeInteger(c.criadoEm)) return 'criadoEm';
  if (!dadosValidos(c.dados)) return 'dados';
  if (typeof c.assinatura !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(c.assinatura)) return 'assinatura';
  return null;
}

export default rota(['POST'], async (req, res) => {
  if (!exigeLogin(req, res)) return;
  if (!exigeJson(req)) return json(res, 415, { erro: 'Envie JSON.' });
  const corpo = await lerCorpo(req, MAX_CORPO);
  const invalido = campoInvalido(corpo);
  if (invalido) return json(res, 400, { erro: `Comando inválido (${invalido}).` });

  const agora = Date.now();
  const cmds = hashParaObjetos(await redis('HGETALL', K.cmds));
  if (cmds.some((c) => c.id === corpo.id)) return json(res, 409, { erro: 'Esse comando já foi enviado.' });
  // Com o coletor parado ninguém expira os pendentes: expira aqui também, para não guardar o conteúdo
  // além da validade e para os vencidos não ocuparem vaga.
  const muda = [];
  for (const c of cmds) if (expirarSeVencido(c, agora)) muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
  const pendentes = cmds.filter((c) => c.estado === 'pendente').length;
  if (pendentes >= MAX_PENDENTES) {
    await pipeline(muda);
    return json(res, 429, { erro: 'Há comandos demais esperando o coletor. Aguarde e tente de novo.' });
  }

  const novo = {};
  for (const campo of CAMPOS) novo[campo] = corpo[campo];
  Object.assign(novo, { estado: 'pendente', erro: null, recebidoNoServidorEm: agora });
  // HSETNX: se dois envios com o mesmo id chegarem juntos, só o primeiro grava.
  const resultados = await pipeline([...muda, ['HSETNX', K.cmds, novo.id, JSON.stringify(novo)]]);
  if (resultados.at(-1) !== 1) return json(res, 409, { erro: 'Esse comando já foi enviado.' });
  json(res, 200, { id: novo.id });
});
