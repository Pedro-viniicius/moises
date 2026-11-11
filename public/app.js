'use strict';

const TZ = 'America/Sao_Paulo';
const INTERVALO_MS = 15000;
const COLETOR_PARADO_MS = 120000;

const fmtMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const fmtInt = new Intl.NumberFormat('pt-BR');
const fmtDec = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const $ = (id) => document.getElementById(id);

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  return e;
}

/* ---------- Formatação ---------- */

const moeda = (v) => fmtMoeda.format(Number.isFinite(v) ? v : 0);
const hora = (ms) => fmtHora.format(new Date(ms));
const dataHora = (ms) => fmtDataHora.format(new Date(ms)).replace(',', '');

function tempoRel(ms) {
  const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (min < 1) return 'agora há pouco';
  if (min < 60) return 'há ' + min + ' min';
  const h = Math.floor(min / 60);
  if (h < 24) return 'há ' + h + ' h';
  return 'há ' + Math.floor(h / 24) + ' d';
}

function duracao(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'menos de 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' min';
  return h + ' h ' + String(m).padStart(2, '0') + ' min';
}

function tokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return fmtDec.format(n / 1e6) + ' mi';
  if (n >= 1e3) return fmtInt.format(Math.round(n / 1e3)) + ' mil';
  return fmtInt.format(n);
}

const NOMES_MODELO = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-2': 'Fable 5.2',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
};

function modeloLegivel(m) {
  if (!m) return '—';
  if (NOMES_MODELO[m]) return NOMES_MODELO[m];
  let s = String(m).replace(/^claude-/, '');
  const i = s.search(/\d-\d(?!.*\d-\d)/);
  if (i >= 0) s = s.slice(0, i + 1) + '.' + s.slice(i + 2);
  s = s.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function nomePadrao(s) {
  const base = s.tarefa ? String(s.tarefa).slice(0, 60) : (s.nome || '');
  return hojeSP() + ' ' + (s.projeto || '') + ' – ' + base;
}

const STATUS = {
  ativa: { rotulo: 'Ativa', icone: '●' },
  aguardando: { rotulo: 'Aguardando você', icone: '◐' },
  ociosa: { rotulo: 'Ociosa', icone: '○' },
  encerrada: { rotulo: 'Encerrada', icone: '■' },
};

/* ---------- Rede ---------- */

class NaoAutorizado extends Error {}

async function api(caminho, opcoes) {
  const r = await fetch(caminho, Object.assign({ credentials: 'same-origin' }, opcoes));
  if (r.status === 401) {
    location.href = '/login.html';
    throw new NaoAutorizado();
  }
  let dados = null;
  try { dados = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, ok: r.ok, dados };
}

function jsonOpcoes(metodo, corpo) {
  return {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  };
}

/* ---------- Estado ---------- */

const estado = {
  dados: null, // última resposta de /api/estado
  filtro: 'abertas',
  aba: 'sessoes',
  cartoes: new Map(), // chave -> objeto do cartão
  pendentesLocais: new Map(), // chave -> comando otimista
};

/* ---------- Resumo ---------- */

function renderResumo() {
  const d = estado.dados;
  if (!d) return;
  $('resumo').hidden = false;
  const r = d.retrato;
  $('resumo-total').textContent = r ? moeda(r.totalDia) : '—';

  const top = $('resumo-top');
  const sessoes = (r && r.sessoes) || [];
  let maior = null;
  for (const s of sessoes) {
    if ((s.custoHoje || 0) > 0 && (!maior || s.custoHoje > maior.custoHoje)) maior = s;
  }
  if (maior) {
    top.textContent = 'Mais gasta hoje: ' + maior.projeto + ' · ' + moeda(maior.custoHoje);
    top.hidden = false;
  } else {
    top.hidden = true;
  }

  const ideias = $('resumo-ideias');
  if (r && r.custoIdeiasHoje > 0) {
    ideias.textContent = 'ideias: ' + moeda(r.custoIdeiasHoje);
    ideias.hidden = false;
  } else {
    ideias.hidden = true;
  }

  const col = $('coletor');
  const parado = !r || !d.recebidoEm || Date.now() - d.recebidoEm > COLETOR_PARADO_MS;
  col.classList.toggle('alerta', parado);
  if (!r) {
    col.textContent = 'Coletor ainda não enviou dados';
  } else if (parado) {
    col.textContent = 'Coletor sem enviar desde ' + hora(d.recebidoEm);
  } else {
    col.textContent = 'coletor ok · atualizado ' + hora(d.recebidoEm);
  }
}

/* ---------- Comandos ---------- */

function comandoDe(chave) {
  const lista = (estado.dados && estado.dados.comandos) || [];
  let achado = null;
  for (const c of lista) {
    if (c.chave === chave && (!achado || c.criadoEm > achado.criadoEm)) achado = c;
  }
  const local = estado.pendentesLocais.get(chave);
  if (local && (!achado || achado.criadoEm < local.criadoEm)) achado = local;
  return achado;
}

function textoComando(c) {
  switch (c.estado) {
    case 'pendente': return { texto: 'Encerrando… (aguardando o coletor)', erro: false };
    case 'feito': return { texto: 'Encerrada. Log salvo no Histórico.', erro: false };
    case 'falhou': return { texto: 'Não encerrou: ' + (c.erro || 'erro desconhecido'), erro: true };
    case 'expirado': return { texto: 'Pedido expirou: o coletor não respondeu em 2 min', erro: true };
    default: return null;
  }
}

/* ---------- Cartões ---------- */

function criarCartao(s) {
  const c = { chave: s.chave, expandido: false, sessao: s, confirmando: null, erroLocal: null };

  const li = el('li');
  const art = el('article', 'cartao');
  li.appendChild(art);

  const cab = el('button', 'cartao-cab');
  cab.type = 'button';
  cab.setAttribute('aria-expanded', 'false');

  const l1 = el('span', 'l1');
  const projeto = el('span', 'projeto');
  const custo = el('span', 'custo');
  l1.append(projeto, custo);
  const tarefa = el('span', 'tarefa');
  const l3 = el('span', 'l3');
  const selo = el('span', 'selo');
  const modelo = el('span');
  l3.append(selo, modelo);
  const atividade = el('span', 'atividade');
  const meta = el('span', 'meta');
  const hoje = el('span', 'meta num');
  cab.append(l1, tarefa, l3, atividade, meta, hoje);

  const detalhe = el('div', 'detalhe');
  detalhe.hidden = true;
  const idDet = 'det-' + Math.random().toString(36).slice(2, 9);
  detalhe.id = idDet;
  cab.setAttribute('aria-controls', idDet);
  const info = el('div');
  const acao = el('div', 'acao');
  detalhe.append(info, acao);

  art.append(cab, detalhe);

  Object.assign(c, { li, art, cab, projeto, custo, tarefa, selo, modelo, atividade, meta, hoje, detalhe, info, acao });

  cab.addEventListener('click', () => {
    c.expandido = !c.expandido;
    atualizarCartao(c);
  });
  return c;
}

function linhaGrade(dl, k, v) {
  dl.append(el('dt', null, k), el('dd', null, v));
}

function secao(pai, titulo) {
  pai.appendChild(el('h3', null, titulo));
}

function montarDetalhe(c) {
  const s = c.sessao;
  const info = c.info;
  const nodes = [];

  if (s.resumo) {
    const d = el('div');
    secao(d, 'Resumo');
    d.appendChild(el('p', null, s.resumo));
    nodes.push(d);
  }

  const tempo = el('div');
  secao(tempo, 'Tempo');
  const g1 = el('dl', 'grade');
  linhaGrade(g1, 'Início', dataHora(s.iniciadaEm));
  const fim = s.status === 'encerrada' ? s.ultimaAtividade : Date.now();
  linhaGrade(g1, 'Duração', duracao(fim - s.iniciadaEm));
  tempo.appendChild(g1);
  nodes.push(tempo);

  const tk = s.tokens || {};
  const t = el('div');
  secao(t, 'Tokens');
  const g2 = el('dl', 'grade');
  linhaGrade(g2, 'Entrada', tokens(tk.input));
  linhaGrade(g2, 'Saída', tokens(tk.output));
  linhaGrade(g2, 'Cache lido', tokens(tk.read));
  linhaGrade(g2, 'Cache escrito', tokens((tk.w5m || 0) + (tk.w1h || 0)));
  t.appendChild(g2);
  nodes.push(t);

  const pm = s.porModelo ? Object.entries(s.porModelo) : [];
  if (pm.length) {
    const m = el('div');
    secao(m, 'Custo por modelo');
    const g3 = el('dl', 'grade');
    for (const [nome, v] of pm) linhaGrade(g3, modeloLegivel(nome), moeda(v && v.custo));
    m.appendChild(g3);
    nodes.push(m);
  }

  const sg = s.sugestao;
  if (sg && sg.recomendacao) {
    const rec = sg.recomendacao;
    const m = el('div');
    secao(m, 'Modelo e esforço');
    if (rec.adequado) {
      m.appendChild(el('p', 'sugestao-ok', '✓ Combina com a tarefa'));
    } else {
      m.appendChild(el('p', 'sugestao-troca',
        'Sugestão: trocar para ' + modeloLegivel(rec.modelo) + ' · ' + (rec.esforco || '—')));
    }
    if (rec.motivo) m.appendChild(el('p', null, rec.motivo));
    nodes.push(m);
  }
  if (sg && Array.isArray(sg.ideias) && sg.ideias.length) {
    const p = el('div');
    secao(p, 'Próximos passos');
    const ul = el('ul');
    for (const i of sg.ideias) ul.appendChild(el('li', null, i));
    p.appendChild(ul);
    nodes.push(p);
  }

  info.replaceChildren(...nodes);
}

function atualizarAcao(c) {
  const s = c.sessao;
  const cmd = comandoDe(s.chave);
  const pendente = !!cmd && cmd.estado === 'pendente';

  if (!c.btnEncerrar) {
    const b = el('button', 'btn btn-perigo', 'Encerrar sessão');
    b.type = 'button';
    b.addEventListener('click', () => abrirConfirmacao(c));
    c.btnEncerrar = b;
    c.estadoCmd = el('p', 'acao-estado');
    c.estadoCmd.setAttribute('role', 'status');
    c.estadoCmd.hidden = true;
    c.acao.append(b, c.estadoCmd);
  }
  c.btnEncerrar.hidden = s.status === 'encerrada' || pendente || !!c.confirmando;

  let msg = null;
  if (c.erroLocal) {
    msg = { texto: c.erroLocal, erro: true };
  } else if (cmd) {
    msg = textoComando(cmd);
  }
  if (msg) {
    c.estadoCmd.textContent = msg.texto;
    c.estadoCmd.classList.toggle('erro', msg.erro);
    c.estadoCmd.hidden = false;
  } else {
    c.estadoCmd.hidden = true;
  }
}

function abrirConfirmacao(c) {
  if (c.confirmando) return;
  c.erroLocal = null;
  const form = el('form', 'confirmar');
  const idCampo = 'nome-' + Math.random().toString(36).slice(2, 9);
  const label = el('label', null, 'Nome do trabalho');
  label.htmlFor = idCampo;
  const campo = el('input', 'campo');
  campo.id = idCampo;
  campo.type = 'text';
  campo.maxLength = 200;
  campo.value = nomePadrao(c.sessao);
  const botoes = el('div', 'botoes');
  const ok = el('button', 'btn btn-primario', 'Encerrar');
  ok.type = 'submit';
  const cancelar = el('button', 'btn', 'Cancelar');
  cancelar.type = 'button';
  botoes.append(ok, cancelar);
  form.append(label, campo, botoes);

  const fechar = () => {
    form.remove();
    c.confirmando = null;
    atualizarAcao(c);
    c.btnEncerrar.focus();
  };
  cancelar.addEventListener('click', fechar);
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') fechar();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = campo.value.trim();
    if (!nome) { campo.focus(); return; }
    ok.disabled = true;
    cancelar.disabled = true;
    try {
      const r = await api('/api/encerrar', jsonOpcoes('POST', { chave: c.chave, nome }));
      if (r.ok && r.dados && r.dados.id) {
        estado.pendentesLocais.set(c.chave, {
          id: r.dados.id, chave: c.chave, nome, estado: 'pendente', erro: null, criadoEm: Date.now(),
        });
        form.remove();
        c.confirmando = null;
        atualizarAcao(c);
        carregarEstado();
        return;
      }
      ok.disabled = false;
      cancelar.disabled = false;
      const motivo = r.status === 404 ? 'a sessão não está mais no painel.'
        : r.status === 409 ? 'a sessão já está encerrada ou tem um pedido pendente.'
          : (r.dados && r.dados.erro) || 'erro ao enviar o pedido.';
      c.erroLocal = 'Não encerrou: ' + motivo;
      form.remove();
      c.confirmando = null;
      atualizarAcao(c);
    } catch (e) {
      if (e instanceof NaoAutorizado) return;
      ok.disabled = false;
      cancelar.disabled = false;
      c.erroLocal = 'Não encerrou: sem conexão.';
      atualizarAcao(c);
    }
  });

  c.confirmando = form;
  c.acao.insertBefore(form, c.estadoCmd);
  atualizarAcao(c);
  campo.focus();
  campo.select();
}

function atualizarCartao(c) {
  const s = c.sessao;
  c.projeto.textContent = s.projeto || '(sem projeto)';
  const conferido = s.custoConferido !== false;
  c.custo.textContent = (conferido ? '' : '≈ ') + moeda(s.custo);
  if (conferido) c.custo.removeAttribute('title');
  else c.custo.title = 'estimado a partir do transcript';

  c.tarefa.textContent = s.tarefa || 'Sem tarefa registrada';

  const st = STATUS[s.status] || { rotulo: s.status || '—', icone: '○' };
  c.selo.className = 'selo selo-' + (STATUS[s.status] ? s.status : 'ociosa');
  c.selo.textContent = st.icone + ' ' + st.rotulo;
  c.modelo.textContent = modeloLegivel(s.modelo) + (s.esforco ? ' · ' + s.esforco : '');

  c.atividade.textContent = s.ultimaAtividade
    ? 'última atividade ' + hora(s.ultimaAtividade) + ' (' + tempoRel(s.ultimaAtividade) + ')'
    : 'sem atividade registrada';
  c.meta.textContent = [s.nome, s.conta].filter(Boolean).join(' · ');
  c.meta.hidden = !c.meta.textContent;

  const dif = Math.abs((s.custoHoje || 0) - (s.custo || 0)) > 0.005;
  c.hoje.hidden = !dif;
  if (dif) c.hoje.textContent = 'hoje: ' + moeda(s.custoHoje);

  c.cab.setAttribute('aria-expanded', String(c.expandido));
  c.detalhe.hidden = !c.expandido;
  if (c.expandido) montarDetalhe(c);
  atualizarAcao(c);
}

function renderLista() {
  const d = estado.dados;
  if (!d) return;
  $('carregando').hidden = true;

  const todas = (d.retrato && d.retrato.sessoes) || [];
  const visiveis = estado.filtro === 'abertas' ? todas.filter((s) => s.status !== 'encerrada') : todas;
  const ativo = document.activeElement;

  const vivos = new Set(visiveis.map((s) => s.chave));
  for (const [chave, c] of estado.cartoes) {
    if (!vivos.has(chave)) {
      c.li.remove();
      estado.cartoes.delete(chave);
    }
  }

  const lista = $('lista');
  visiveis.forEach((s, i) => {
    let c = estado.cartoes.get(s.chave);
    if (!c) {
      c = criarCartao(s);
      estado.cartoes.set(s.chave, c);
    }
    c.sessao = s;
    atualizarCartao(c);
    c.art.classList.toggle('destaque', i === 0);
    if (lista.children[i] !== c.li) lista.insertBefore(c.li, lista.children[i] || null);
  });

  if (ativo && ativo !== document.body && document.contains(ativo) && document.activeElement !== ativo) {
    ativo.focus();
  }

  const vazio = $('vazio');
  vazio.hidden = visiveis.length > 0;
  vazio.textContent = estado.filtro === 'abertas' ? 'Nenhuma sessão aberta agora' : 'Nenhuma sessão hoje';
}

function renderTudo() {
  renderResumo();
  renderLista();
}

/* ---------- Carga ---------- */

let carregando = false;
let timerRetry = null;

async function carregarEstado() {
  if (carregando) return;
  carregando = true;
  try {
    const r = await api('/api/estado');
    if (!r.ok || !r.dados) throw new Error('resposta inválida');
    estado.dados = r.dados;
    $('banner-rede').hidden = true;
    renderTudo();
  } catch (e) {
    if (e instanceof NaoAutorizado) return;
    $('banner-rede').hidden = false;
    renderResumo();
    clearTimeout(timerRetry);
    timerRetry = setTimeout(() => {
      if (document.visibilityState === 'visible') carregarEstado();
    }, 5000);
  } finally {
    carregando = false;
  }
}

setInterval(() => {
  if (document.visibilityState === 'visible' && estado.aba === 'sessoes') carregarEstado();
}, INTERVALO_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && estado.aba === 'sessoes') carregarEstado();
});

/* ---------- Filtro ---------- */

function definirFiltro(f) {
  estado.filtro = f;
  $('filtro-abertas').setAttribute('aria-pressed', String(f === 'abertas'));
  $('filtro-todas').setAttribute('aria-pressed', String(f === 'todas'));
  renderLista();
}
$('filtro-abertas').addEventListener('click', () => definirFiltro('abertas'));
$('filtro-todas').addEventListener('click', () => definirFiltro('todas'));

/* ---------- Abas ---------- */

function definirAba(nome) {
  estado.aba = nome;
  const sess = nome === 'sessoes';
  $('aba-sessoes').setAttribute('aria-selected', String(sess));
  $('aba-sessoes').tabIndex = sess ? 0 : -1;
  $('aba-historico').setAttribute('aria-selected', String(!sess));
  $('aba-historico').tabIndex = sess ? -1 : 0;
  $('painel-sessoes').hidden = !sess;
  $('painel-historico').hidden = sess;
  if (sess) carregarEstado();
  else carregarLogs();
}
$('aba-sessoes').addEventListener('click', () => definirAba('sessoes'));
$('aba-historico').addEventListener('click', () => definirAba('historico'));
for (const id of ['aba-sessoes', 'aba-historico']) {
  $(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const outro = id === 'aba-sessoes' ? 'historico' : 'sessoes';
      definirAba(outro);
      $('aba-' + outro).focus();
    }
  });
}

/* ---------- Histórico ---------- */

let seqLogs = 0;

async function carregarLogs() {
  const minha = ++seqLogs;
  const q = $('busca').value.trim();
  $('logs-erro').hidden = true;
  $('logs-vazio').hidden = true;
  if (!$('logs').children.length) $('logs-carregando').hidden = false;
  try {
    const r = await api('/api/logs' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (minha !== seqLogs) return;
    $('logs-carregando').hidden = true;
    if (!r.ok || !r.dados) throw new Error('resposta inválida');
    renderLogs(r.dados.logs || []);
  } catch (e) {
    if (e instanceof NaoAutorizado || minha !== seqLogs) return;
    $('logs-carregando').hidden = true;
    $('logs-erro').hidden = false;
  }
}

function renderLogs(logs) {
  const ul = $('logs');
  ul.replaceChildren(...logs.map(criarLog));
  const vazio = $('logs-vazio');
  vazio.textContent = $('busca').value.trim()
    ? 'Nenhum log encontrado para essa busca.'
    : 'Nenhuma sessão encerrada pelo painel ainda.';
  vazio.hidden = logs.length > 0;
}

function criarLog(l) {
  const li = el('li');
  const art = el('article', 'log');
  li.appendChild(art);

  const topo = el('div', 'log-linha');
  const nome = el('span', 'log-nome', l.nome || '(sem nome)');
  const renomear = el('button', 'btn btn-leve', 'Renomear');
  renomear.type = 'button';
  topo.append(nome, renomear);

  const meta = el('div', 'log-meta num');
  const partes = [
    l.encerradaEm ? dataHora(l.encerradaEm) : null,
    l.projeto,
    l.duracaoMs != null ? duracao(l.duracaoMs) : null,
    l.modelo ? modeloLegivel(l.modelo) + (l.esforco ? ' · ' + l.esforco : '') : null,
    moeda(l.custo),
  ].filter(Boolean);
  meta.textContent = partes.join(' · ');

  art.append(topo, meta);
  if (l.resumo) art.appendChild(el('p', 'log-resumo', l.resumo));

  renomear.addEventListener('click', () => {
    const form = el('form', 'log-linha');
    const campo = el('input', 'campo');
    campo.type = 'text';
    campo.maxLength = 200;
    campo.value = l.nome || '';
    campo.setAttribute('aria-label', 'Novo nome do log');
    const salvar = el('button', 'btn btn-primario', 'Salvar');
    salvar.type = 'submit';
    const cancelar = el('button', 'btn', 'Cancelar');
    cancelar.type = 'button';
    const aviso = el('p', 'acao-estado erro');
    aviso.hidden = true;
    form.append(campo, salvar, cancelar);
    topo.replaceWith(form);
    form.after(aviso);
    campo.focus();

    const voltar = () => {
      form.replaceWith(topo);
      aviso.remove();
      renomear.focus();
    };
    cancelar.addEventListener('click', voltar);
    form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') voltar(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const novo = campo.value.trim();
      if (!novo) { campo.focus(); return; }
      salvar.disabled = true;
      try {
        const r = await api('/api/logs', jsonOpcoes('PATCH', { id: l.id, nome: novo }));
        if (!r.ok) throw new Error('falhou');
        l.nome = novo;
        nome.textContent = novo;
        voltar();
      } catch (e) {
        if (e instanceof NaoAutorizado) return;
        salvar.disabled = false;
        aviso.textContent = 'Não foi possível salvar o nome.';
        aviso.hidden = false;
      }
    });
  });
  return li;
}

let timerBusca = null;
$('busca').addEventListener('input', () => {
  clearTimeout(timerBusca);
  timerBusca = setTimeout(carregarLogs, 300);
});

/* ---------- Sair ---------- */

$('sair').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* segue para o login mesmo assim */ }
  location.href = '/login.html';
});

carregarEstado();
