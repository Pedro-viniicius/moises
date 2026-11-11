'use strict';

const form = document.getElementById('form');
const campo = document.getElementById('senha');
const botao = document.getElementById('entrar');
const erro = document.getElementById('erro');

function mostrarErro(texto) {
  erro.textContent = texto;
  erro.hidden = false;
}

function tempoEspera(s) {
  if (!Number.isFinite(s) || s <= 0) return 'alguns instantes';
  if (s < 60) return s + ' s';
  const min = Math.ceil(s / 60);
  return min + (min === 1 ? ' minuto' : ' minutos');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  erro.hidden = true;
  if (!campo.value) {
    mostrarErro('Digite a senha.');
    campo.focus();
    return;
  }
  botao.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: campo.value }),
    });
    let dados = null;
    try { dados = await r.json(); } catch { /* corpo vazio */ }
    if (r.ok) {
      location.href = '/';
      return;
    }
    if (r.status === 401) {
      mostrarErro('Senha incorreta.');
    } else if (r.status === 429) {
      mostrarErro('Muitas tentativas. Tente de novo em ' + tempoEspera(dados && dados.tenteEmS) + '.');
    } else {
      mostrarErro((dados && dados.erro) || 'Não foi possível entrar.');
    }
    campo.select();
  } catch {
    mostrarErro('Sem conexão. Tente de novo.');
  } finally {
    botao.disabled = false;
  }
});
