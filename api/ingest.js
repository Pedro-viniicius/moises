import {
  rota,
  json,
  lerCorpo,
  tokenColetorValido,
  pipeline,
  lerComandos,
  juntarComando,
  chegadaDoComando,
  esquecerConteudo,
  gravarSemConteudo,
  apagarComando,
  expirarSeVencido,
  pedidosDeAparelho,
  K,
  RE_CHAVE,
  ORDEM_ESTADO,
  MAX_PENDENTES,
} from './_lib.js';

const GUARDA_CMD_MS = 24 * 3600 * 1000;
const SEM_RESULTADO_MS = 10 * 60 * 1000;
// O retrato leva resumos de sessão: some do Redis se o coletor ficar 24 h sem mandar outro.
const VALIDADE_RETRATO_S = 24 * 3600;
// Só o coletor que confere assinatura anuncia este protocolo; o antigo executaria encerrar sem conferir.
const PROTOCOLO_COLETOR = 2;
const CAMPOS_LOG = ['projeto', 'conta', 'tarefa', 'resumo', 'iniciadaEm', 'encerradaEm', 'duracaoMs', 'modelo', 'esforco', 'porModelo', 'tokens', 'custo'];
const ESTADOS_ACK = ['recebido', 'feito', 'falhou', 'recusado'];

// Ack novo {id, estado, erro, motivo, log, chaveNova} ou antigo {id, ok, erro, log}.
function estadoDoAck(a) {
  if (ESTADOS_ACK.includes(a.estado)) return a.estado;
  if (a.estado === undefined && typeof a.ok === 'boolean') return a.ok ? 'feito' : 'falhou';
  return null;
}

// Hora de um registro de cmds-rec ou cmds-fim, para apagar o que ficou sem comando; ilegível vale 0.
function horaDoResultado(valor, ehFim) {
  try {
    const t = ehFim ? JSON.parse(valor)?.feitoEm : Number(valor);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

export default rota(['POST'], async (req, res) => {
  if (!tokenColetorValido(req)) return json(res, 401, { erro: 'Token inválido.' });
  const corpo = await lerCorpo(req);
  // JSON que não é objeto (null, número, texto, lista) não é um corpo do coletor: 400, antes de gravar nada.
  if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) return json(res, 400, { erro: 'Corpo inválido.' });
  const { retrato, acks, protocolo } = corpo;
  const agora = Date.now();
  // Lê o objeto antes de cmds-rec e cmds-fim: quem grava o resultado o grava antes de regravar o objeto,
  // então um objeto já sem conteúdo sempre vem com o resultado que o acompanha.
  const [, cmdsArr, recArr, fimArr, painelVistoEm, pedidosArr] = await pipeline([
    ['SET', K.recebidoEm, String(agora)],
    ['HGETALL', K.cmds],
    ['HGETALL', K.cmdsRec],
    ['HGETALL', K.cmdsFim],
    ['GET', K.painelVistoEm],
    ['HGETALL', K.aparelhosPedidos],
  ]);
  const lidos = lerComandos(cmdsArr, recArr, fimArr);
  const itens = new Map(lidos.itens.map((x) => [x.guardado.id, x]));
  // Resultados (HSETNX) vão antes das regravações do objeto; veja o comentário da leitura.
  const resultados = [];
  const muda = [];
  // Pedidos de pareamento de aparelho (tarefa 15): os vencidos saem; os válidos vão ao coletor novo.
  const pedidos = pedidosDeAparelho(pedidosArr, agora);
  for (const kid of pedidos.vencidos) muda.push(['HDEL', K.aparelhosPedidos, kid]);
  if (retrato && typeof retrato === 'object' && Array.isArray(retrato.sessoes)) muda.push(['SET', K.retrato, JSON.stringify(retrato), 'EX', VALIDADE_RETRATO_S]);

  for (const a of Array.isArray(acks) ? acks : []) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
    const item = itens.get(a.id);
    const novo = item && estadoDoAck(a);
    if (!novo) continue;
    const { guardado } = item;
    // Qualquer ack confirma que o coletor já tem o comando: o conteúdo sai do Redis (e da vista).
    if ('dados' in guardado || 'assinatura' in guardado) muda.push(gravarSemConteudo(guardado));
    esquecerConteudo(item.vista);
    // A leitura pode estar velha: o HSETNX garante que só o primeiro resultado de cada etapa vale.
    if (!(ORDEM_ESTADO[novo] > (ORDEM_ESTADO[item.vista.estado] ?? 2))) continue;
    if (novo === 'recebido') {
      resultados.push(['HSETNX', K.cmdsRec, guardado.id, String(agora)]);
      item.vista = juntarComando(guardado, String(agora), null);
      continue;
    }
    const fim = {
      estado: novo,
      erro: novo === 'feito' ? null : String(a.erro || novo).slice(0, 200),
      motivo: typeof a.motivo === 'string' && /^[a-z_]{1,20}$/.test(a.motivo) ? a.motivo : null,
      feitoEm: agora,
    };
    if (guardado.tipo === 'abrir' && typeof a.chaveNova === 'string' && RE_CHAVE.test(a.chaveNova)) fim.chaveNova = a.chaveNova;
    resultados.push(['HSETNX', K.cmdsFim, guardado.id, JSON.stringify(fim)]);
    item.vista = juntarComando(guardado, null, JSON.stringify(fim));
    if (novo === 'feito' && guardado.tipo === 'encerrar' && a.log && typeof a.log === 'object') {
      const log = { id: guardado.id, chave: guardado.chave, criadoEm: agora, nome: String(a.log.nome || guardado.nome || guardado.chave).slice(0, 140) };
      for (const campo of CAMPOS_LOG) if (a.log[campo] !== undefined) log[campo] = a.log[campo];
      // HSETNX: um feito repetido (reenvio que leu antes do primeiro gravar) não desfaz o nome que o dono editou.
      resultados.push(['HSETNX', K.logs, log.id, JSON.stringify(log)]);
    }
  }

  const pendentes = [];
  for (const item of itens.values()) {
    const { guardado, vista } = item;
    const expirou = expirarSeVencido(item, agora);
    if (expirou) {
      muda.push(expirou);
    } else if (vista.estado === 'pendente') {
      pendentes.push(vista);
    } else if (vista.estado === 'recebido' && agora - (vista.recebidoPeloColetorEm ?? agora) > SEM_RESULTADO_MS) {
      // Se o resultado do coletor chegar ao mesmo tempo, vale o que gravou primeiro.
      const fim = { estado: 'falhou', erro: 'O coletor não confirmou o resultado.', motivo: null, feitoEm: agora };
      resultados.push(['HSETNX', K.cmdsFim, guardado.id, JSON.stringify(fim)]);
    } else if (agora - chegadaDoComando(guardado) > GUARDA_CMD_MS) {
      muda.push(...apagarComando(guardado.id));
    }
  }
  // Resultado de etapa sem o comando (o objeto foi apagado entre a leitura e a gravação de outra chamada):
  // sai depois do mesmo prazo, para os hashes não crescerem sem limite.
  for (const [mapa, chave, ehFim] of [[lidos.rec, K.cmdsRec, false], [lidos.fim, K.cmdsFim, true]]) {
    for (const [id, valor] of mapa) if (!itens.has(id) && agora - horaDoResultado(valor, ehFim) > GUARDA_CMD_MS) muda.push(['HDEL', chave, id]);
  }
  await pipeline([...resultados, ...muda]);
  // Para o coletor antigo, nada: os pendentes ficam guardados até expirar ou até o coletor novo buscar.
  if (protocolo !== PROTOCOLO_COLETOR) {
    return json(res, 200, { comandos: [], painelVistoEm: painelVistoEm ? Number(painelVistoEm) : null });
  }
  const comandos = pendentes
    .sort((a, b) => chegadaDoComando(a) - chegadaDoComando(b))
    .slice(0, MAX_PENDENTES)
    .map((c) => {
      const { v, kid, id, tipo, chave, criadoEm, dados, assinatura } = c;
      return { v, kid, id, tipo, chave, criadoEm, dados, assinatura, idadeMs: agora - chegadaDoComando(c) };
    });
  // O coletor confere cada pedido de novo antes de gravá-lo: o servidor não é confiável.
  const aparelhosPedidos = pedidos.validos
    .sort((a, b) => a.criadoEm - b.criadoEm)
    .map(({ kid, publica, rotulo, criadoEm }) => ({ kid, publica, rotulo, criadoEm }));
  json(res, 200, { comandos, painelVistoEm: painelVistoEm ? Number(painelVistoEm) : null, aparelhosPedidos });
});
