import {
  rota,
  json,
  lerCorpo,
  tokenColetorValido,
  pipeline,
  hashParaObjetos,
  chegadaDoComando,
  esquecerConteudo,
  expirarSeVencido,
  K,
  RE_CHAVE,
  MAX_PENDENTES,
} from './_lib.js';

const GUARDA_CMD_MS = 24 * 3600 * 1000;
const SEM_RESULTADO_MS = 10 * 60 * 1000;
// O retrato leva resumos de sessão: some do Redis se o coletor ficar 24 h sem mandar outro.
const VALIDADE_RETRATO_S = 24 * 3600;
// Só o coletor que confere assinatura anuncia este protocolo; o antigo executaria encerrar sem conferir.
const PROTOCOLO_COLETOR = 2;
const CAMPOS_LOG = ['projeto', 'conta', 'tarefa', 'resumo', 'iniciadaEm', 'encerradaEm', 'duracaoMs', 'modelo', 'esforco', 'porModelo', 'tokens', 'custo'];
// Um ack só faz o comando andar para a frente: pendente/expirado → recebido → feito | falhou | recusado.
// O expirado aceita ack porque o coletor pode ter recebido o comando pouco antes de o servidor expirá-lo.
const ORDEM = { pendente: 0, expirado: 0, recebido: 1, feito: 2, falhou: 2, recusado: 2 };
const ESTADOS_ACK = ['recebido', 'feito', 'falhou', 'recusado'];

// Ack novo {id, estado, erro, motivo, log, chaveNova} ou antigo {id, ok, erro, log}.
function estadoDoAck(a) {
  if (ESTADOS_ACK.includes(a.estado)) return a.estado;
  if (a.estado === undefined && typeof a.ok === 'boolean') return a.ok ? 'feito' : 'falhou';
  return null;
}

export default rota(['POST'], async (req, res) => {
  if (!tokenColetorValido(req)) return json(res, 401, { erro: 'Token inválido.' });
  const { retrato, acks, protocolo } = await lerCorpo(req);
  const agora = Date.now();
  const [, cmdsArr, painelVistoEm] = await pipeline([['SET', K.recebidoEm, String(agora)], ['HGETALL', K.cmds], ['GET', K.painelVistoEm]]);
  const cmds = new Map(hashParaObjetos(cmdsArr).map((c) => [c.id, c]));
  const muda = [];
  if (retrato && typeof retrato === 'object' && Array.isArray(retrato.sessoes)) muda.push(['SET', K.retrato, JSON.stringify(retrato), 'EX', VALIDADE_RETRATO_S]);

  for (const a of Array.isArray(acks) ? acks : []) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
    const c = cmds.get(a.id);
    const novo = c && estadoDoAck(a);
    if (!novo) continue;
    // Qualquer ack confirma que o coletor já tem o comando: o conteúdo sai do Redis.
    esquecerConteudo(c);
    if (ORDEM[novo] > (ORDEM[c.estado] ?? 2)) {
      c.estado = novo;
      c.erro = novo === 'falhou' || novo === 'recusado' ? String(a.erro || novo).slice(0, 200) : null;
      c.motivo = typeof a.motivo === 'string' && /^[a-z_]{1,20}$/.test(a.motivo) ? a.motivo : null;
      if (novo === 'recebido') c.recebidoPeloColetorEm = agora;
      else c.feitoEm = agora;
      if (c.tipo === 'abrir' && typeof a.chaveNova === 'string' && RE_CHAVE.test(a.chaveNova)) c.chave = a.chaveNova;
      if (novo === 'feito' && c.tipo === 'encerrar' && a.log && typeof a.log === 'object') {
        const log = { id: c.id, chave: c.chave, criadoEm: agora, nome: String(a.log.nome || c.nome || c.chave).slice(0, 140) };
        for (const campo of CAMPOS_LOG) if (a.log[campo] !== undefined) log[campo] = a.log[campo];
        muda.push(['HSET', K.logs, log.id, JSON.stringify(log)]);
      }
    }
    muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
  }

  const pendentes = [];
  for (const c of cmds.values()) {
    const idade = agora - chegadaDoComando(c);
    if (expirarSeVencido(c, agora)) {
      muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
    } else if (c.estado === 'pendente') {
      pendentes.push(c);
    } else if (c.estado === 'recebido' && agora - (c.recebidoPeloColetorEm ?? agora) > SEM_RESULTADO_MS) {
      c.estado = 'falhou';
      c.erro = 'O coletor não confirmou o resultado.';
      c.feitoEm = agora;
      muda.push(['HSET', K.cmds, c.id, JSON.stringify(c)]);
    } else if (idade > GUARDA_CMD_MS) {
      muda.push(['HDEL', K.cmds, c.id]);
    }
  }
  await pipeline(muda);
  // Para o coletor antigo, nada: os pendentes ficam guardados até expirar ou até o coletor novo buscar.
  if (protocolo !== PROTOCOLO_COLETOR) pendentes.length = 0;
  const comandos = pendentes
    .sort((a, b) => chegadaDoComando(a) - chegadaDoComando(b))
    .slice(0, MAX_PENDENTES)
    .map((c) => {
      const { v, kid, id, tipo, chave, criadoEm, dados, assinatura } = c;
      return { v, kid, id, tipo, chave, criadoEm, dados, assinatura, idadeMs: agora - chegadaDoComando(c) };
    });
  json(res, 200, { comandos, painelVistoEm: painelVistoEm ? Number(painelVistoEm) : null });
});
