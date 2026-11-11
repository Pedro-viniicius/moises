// v3: ideias de próximo passo e recomendação de modelo/esforço por sessão aberta.
// A classificação da tarefa vem do Haiku (contexto mínimo, ~US$ 0,0002 por chamada);
// a recomendação sai de regras fixas. Só roda quando a sessão muda de forma relevante.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diaLocal } from './transcript.js';

const INTERVALO_MIN_MS = 10 * 60_000; // por sessão
// Lido na construção, não na importação: quem cria o Ideias depois de ajustar o ambiente vê o valor novo.
const tetoDoAmbiente = () => Number(process.env.MOISES_IDEIAS_TETO_DIA || 80);

// A tarefa que alimenta as ideias. Se ela veio do primeiro pedido, vai o nome da sessão no lugar:
// o texto de um pedido não alimenta as ideias que sobem ao site (PLANO, tarefa 7).
const tarefaDe = (s) => (s.tarefaOrigem === 'pedido' ? s.nome || null : s.tarefa);

export const TIER = (m = '') => (/fable|mythos/.test(m) ? 4 : /opus/.test(m) ? 3 : /sonnet/.test(m) ? 2 : /haiku/.test(m) ? 1 : 0);
const NIVEL = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

export function recomendar(modelo, esforco, complexidade, motivoIA = '') {
  const t = TIER(modelo);
  const e = NIVEL[esforco] || 3;
  if (!t || !complexidade) return null;
  const ok = (motivo) => ({ adequado: true, modelo, esforco, motivo });
  const troca = (m, ef, motivo) => ({ adequado: false, modelo: m, esforco: ef, motivo });
  if (complexidade === 'mecanica') {
    if (t >= 3) return troca('claude-sonnet-5-5', 'medium', 'Tarefa mecânica em modelo caro: o Sonnet em esforço médio resolve por bem menos.');
    if (e >= 3) return troca(modelo, 'medium', 'Tarefa mecânica: esforço médio basta e gasta menos.');
    return ok(motivoIA || 'Modelo e esforço proporcionais a uma tarefa mecânica.');
  }
  if (complexidade === 'moderada') {
    if (t === 4) return troca('claude-opus-5-5', 'high', 'Fable custa o dobro do Opus; para esta tarefa o Opus em high entrega o mesmo.');
    if (e >= 4) return troca(modelo, 'high', 'Esforço acima de high raramente compensa numa tarefa média.');
    if (t === 1) return troca('claude-sonnet-5-5', 'high', 'Tarefa média em modelo pequeno: subir para o Sonnet evita retrabalho.');
    return ok(motivoIA || 'Combina com uma tarefa de complexidade média.');
  }
  if (t <= 2) return troca('claude-opus-5-5', 'high', 'Tarefa complexa em modelo pequeno: suba para o Opus para não pagar em retrabalho.');
  if (e <= 2) return troca(modelo, 'high', 'Tarefa complexa com esforço baixo: suba para high.');
  return ok(motivoIA || 'Tarefa complexa: modelo e esforço adequados.');
}

const SISTEMA = 'Você classifica sessões de programação e sugere próximos passos. Responda só com um objeto JSON, sem markdown.';

export function montarPergunta(s) {
  return [
    'Metadados de uma sessão do Claude Code (assistente de programação):',
    `- projeto: ${s.projeto}`,
    `- tarefa atual: ${tarefaDe(s) || '(sem título)'}`,
    `- resumo: ${s.resumo || '(sem resumo)'}`,
    '',
    'Responda com JSON: {"complexidade":"mecanica|moderada|complexa","ideias":["...","..."],"motivo":"..."}',
    '- complexidade: mecanica = edição repetitiva, renomear, formatar, rodar comandos, ajustar textos ou configuração; moderada = funcionalidade comum, bug com causa clara, página ou tela nova; complexa = arquitetura, depuração difícil, segurança, integração nova, decisão de produto.',
    '- ideias: 2 ou 3 próximos passos concretos para o projeto evoluir de forma iterativa a partir dessa tarefa, cada um com até 90 caracteres, em português do Brasil.',
    '- motivo: uma frase de até 100 caracteres explicando a complexidade.',
  ].join('\n');
}

export function lerResposta(txt) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const complexidade = ['mecanica', 'moderada', 'complexa'].includes(j.complexidade) ? j.complexidade : null;
    const ideias = (Array.isArray(j.ideias) ? j.ideias : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 3).map((x) => x.trim().slice(0, 140));
    if (!complexidade || ideias.length < 2) return null;
    return { complexidade, ideias, motivo: typeof j.motivo === 'string' ? j.motivo.trim().slice(0, 140) : '' };
  } catch {
    return null;
  }
}

export function chamarHaiku(pergunta, { cwd, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const filho = execFile(
      process.env.MOISES_CLAUDE_BIN || 'claude',
      ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', SISTEMA, '--tools', ''],
      { cwd, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (err, stdout) => {
        if (err) return resolve({ erro: err.message.slice(0, 200) });
        try {
          const j = JSON.parse(stdout);
          resolve({ texto: j.result, custo: Number(j.total_cost_usd) || 0, erro: j.is_error ? 'erro do claude' : null });
        } catch {
          resolve({ erro: 'saída inesperada do claude' });
        }
      },
    );
    filho.stdin.end(pergunta);
  });
}

export class Ideias {
  constructor({ pastaEstado, chamar = chamarHaiku, agora = () => Date.now(), tetoDia = tetoDoAmbiente() }) {
    this.arquivo = path.join(pastaEstado, 'ideias.json');
    this.pasta = pastaEstado;
    this.chamar = chamar;
    this.agora = agora;
    this.tetoDia = tetoDia;
    this.ocupado = false;
    fs.mkdirSync(this.pasta, { recursive: true });
    try {
      this.d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
    } catch {
      this.d = { porSessao: {}, gastoPorDia: {}, chamadasPorDia: {} };
    }
  }

  // Grava num temporário e renomeia: um corte no meio não zera o teto diário.
  salvar() {
    fs.mkdirSync(this.pasta, { recursive: true });
    const tmp = `${this.arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.arquivo);
  }

  assinatura(s) {
    return crypto.createHash('sha1').update([s.projeto, tarefaDe(s), s.resumo].join('|')).digest('hex');
  }

  // Anexa a sugestão já conhecida a cada sessão e dispara no máximo uma geração nova por vez.
  aplicar(retrato) {
    const hoje = diaLocal(this.agora());
    for (const s of retrato.sessoes) {
      const g = this.d.porSessao[s.chave];
      if (!g) continue;
      s.sugestao = { ideias: g.ideias, recomendacao: recomendar(s.modelo, s.esforco, g.complexidade, g.motivo), geradaEm: g.em };
    }
    retrato.custoIdeiasHoje = Math.round((this.d.gastoPorDia[hoje] || 0) * 10000) / 10000;
    if (!this.ocupado) {
      const alvo = retrato.sessoes.find((s) => s.status !== 'encerrada' && (tarefaDe(s) || s.resumo) && this.precisa(s));
      if (alvo && (this.d.chamadasPorDia[hoje] || 0) < this.tetoDia) {
        this.gerar(alvo, hoje).catch((err) => console.error('[ideias] falha:', err.message));
      }
    }
    return retrato;
  }

  precisa(s) {
    const g = this.d.porSessao[s.chave];
    if (!g) return true;
    if (this.agora() - g.em <= INTERVALO_MIN_MS) return false;
    return g.falhou || g.assinatura !== this.assinatura(s);
  }

  async gerar(s, hoje) {
    this.ocupado = true;
    try {
      const r = await this.chamar(montarPergunta(s), { cwd: this.pasta });
      this.d.chamadasPorDia[hoje] = (this.d.chamadasPorDia[hoje] || 0) + 1;
      this.d.gastoPorDia[hoje] = (this.d.gastoPorDia[hoje] || 0) + (r.custo || 0);
      const lido = r.erro ? null : lerResposta(r.texto);
      // Mesmo se falhar, guarda a assinatura para não insistir na mesma sessão a cada ciclo.
      this.d.porSessao[s.chave] = lido
        ? { ...lido, assinatura: this.assinatura(s), em: this.agora() }
        : { ...(this.d.porSessao[s.chave] || { ideias: [], complexidade: null, motivo: '' }), assinatura: this.assinatura(s), em: this.agora(), falhou: true };
      if (!lido) console.error('[ideias] sem resposta válida:', r.erro || 'formato');
      this.salvar();
    } finally {
      this.ocupado = false;
    }
  }
}
