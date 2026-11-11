# Especificação de UI/UX: controles de orquestração do painel

Local pedido pelo dono para este trabalho (no lugar de `docs/produto/specs/`). Cobre os critérios CA5, CA8, CA9 e CA10 de `PLANO.md` e a tarefa 8. Não redesenha o que existe: tema, coluna de 720 px, cartões, abas, filtro, `.btn`, `.campo`, `.confirmar`, `.acao-estado`, `.selo` e `.banner` continuam como estão e são reaproveitados.

## Objetivo e usuário

Um usuário só, o dono, no celular (de 320 a 430 px de largura), com pressa, com uma mão, às vezes com conexão ruim, olhando o painel para decidir "preciso fazer alguma coisa agora?". O painel passa de mostrar para comandar. As duas perguntas que a tela tem de responder em 2 segundos: **qual sessão está esperando por mim** e **o que o meu último toque causou**. Tudo que muda algo na máquina dele é uma ação com consequência, então: confirmação nas destrutivas, retorno visível em cada passo e nenhum botão que finge funcionar quando não vai funcionar.

Orientação da ferramenta de apoio (`ui-ux-pro-max`, consultas `destructive action confirmation`, `status badge color only`, `touch target size`, `form inline validation`, `loading feedback button` e as regras de `quick-reference.md`), tratada como recomendação e já aplicada abaixo: confirmar antes de ação irreversível; cor nunca é o único sinal (texto mais forma); alvo de 44 px no celular e no mínimo 24 px na web (WCAG 2.2), com 8 px entre alvos; botão desabilitado durante a operação assíncrona com texto de andamento; erro perto do campo; validar ao sair do campo (blur) e resumir no envio; anunciar mudança de estado como frase completa, sem mover o foco, em uma região viva só.

## Fluxo

1. Abre o painel. O retrato traz `estado`, `ultimaResposta`, `gerenciada`, `retomavel`, `permissoes` (cada uma com `completo` e `sensivel`) por sessão e `orquestracao` no topo (`maxSessoes`, `abertas`, `aparelhos`). Todo comando sobre uma sessão leva `visto` (projeto e nome que o cartão mostrava) e o coletor o recusa se a sessão real for outra (CA8). O painel decide por sessão o que mostrar (matriz na seção Componentes, item 5).
2. Uma sessão pede permissão: o selo do cartão muda para "Pedindo permissão", o cartão ganha borda âmbar, o contador no resumo sobe e o leitor de tela ouve uma frase. O dono abre o cartão, lê ferramenta e entrada, e toca Aprovar ou Negar.
3. Qualquer comando: o toque envia na hora; a linha de andamento mostra Enviado → Recebido pelo coletor → Executado (ou Recusado, Falhou, Expirado). A tela consulta o servidor a cada 2 s enquanto houver comando em andamento e volta aos 15 s de hoje depois.
4. Na primeira vez no aparelho, o primeiro comando abre o diálogo do código do aparelho; guardada a chave, o comando que o dono tinha pedido segue sozinho.
5. "Nova sessão": botão acima do filtro → formulário → resumo → enviar → linha de andamento sob o botão → a sessão aparece na lista.

## Layout (mobile e desktop)

Uma coluna, igual a hoje. Nada de grade nova: em 1280 px a coluna continua com 720 px, centralizada. Linhas de texto ficam abaixo de 75 caracteres por causa dos 720 px.

Aba Sessões, de cima para baixo:

```
[Resumo: total · coletor · "2 esperando você"]
[Banner: coletor fora do ar ...]             (só quando o coletor está parado)
[Nova sessão]  (btn-primario, largura total)
[linha de andamento do "abrir" / motivo do botão desabilitado]
[Filtro Abertas | Todas de hoje]
[cartões]
[Rodapé "Este aparelho": kid, rótulo, esquecer]
```

Cartão fechado: igual a hoje. Muda só o selo (agora vem de `estado`) e, quando `esperando_permissao`, a borda esquerda e o selo em âmbar. A tarefa passa a vir preenchida pelo coletor (CA5).

Cartão aberto (`.detalhe`), nova ordem; o que já existe (Resumo, Tempo, Tokens, Custo por modelo, Modelo e esforço, Próximos passos) desce para baixo do bloco novo, sem mudança:

```
Pedidos de permissão (0 a N)     <- primeiro: é o que exige o dono
Última resposta                  <- texto, horário, "Mostrar tudo"
Mensagem para a sessão           <- caixa + Enviar (comandada) OU uma linha explicativa
Andamento do último comando      <- uma linha viva + 3 passos
Ações: Interromper · Encerrar · Retomar
[confirmação inline, quando pedida]
--- existente: Resumo, Tempo, Tokens, ... ---
```

O `.acao` atual (botão Encerrar no fim) é substituído pela linha "Ações" do bloco novo. Em 320 px os botões de ação ficam empilhados (`.botoes` já usa `flex-wrap`, cada botão com `flex: 1 1 140px`).

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Selo de estado | existente (`.selo`), 1 variante nova (`.selo-permissao`) e rótulos novos | `style.css`, `app.js` (`STATUS` passa a ser `ESTADOS`) |
| Bloco "Última resposta" (`.resposta`) | novo | `app.js` `montarDetalhe`/`criarCartao`, `style.css` |
| Caixa de mensagem (`.mensagem-form`) | novo, usa `.campo` e `.btn` | idem |
| Bloco de permissão (`.permissao`) | novo | idem |
| Linha de andamento (`.andamento`, `.passos`) | novo, estende `.acao-estado` | idem |
| Confirmação inline | existente (`.confirmar`) reaproveitado para Interromper e Retomar | idem |
| Botão e diálogo "Nova sessão" | novo; `<dialog>` nativo | `index.html`, `app.js`, `style.css` |
| Diálogo do código do aparelho | novo; `<dialog>` nativo | idem |
| Guarda da chave (IndexedDB) | novo, sem interface | `public/cofre.js` |
| Rodapé "Este aparelho" | novo | `index.html`, `app.js` |
| Região viva global `#anuncios` | nova, só para leitor de tela (`.so-leitor`) | `index.html` |
| Banner do coletor (`#banner-coletor`) | existente (`.banner`), instância nova | `index.html` |

### 1. Selo de estado

Fonte: `estado` do retrato. Se `estado` faltar (coletor antigo), cair no `status` antigo com os rótulos de hoje. O rótulo é sempre texto; a forma do marcador (antes do texto) é a segunda pista, para não depender só de cor.

| `estado` | Rótulo | Cor (tokens existentes) | Marcador | Borda esquerda do cartão |
|---|---|---|---|---|
| `trabalhando` | Trabalhando | `--ativa-*` | círculo cheio, pulsa 3 vezes (já existe) | `--ativa-cor` |
| `esperando_mensagem` | Esperando você | `--aguard-*` | círculo cheio | `--aguard-cor` |
| `esperando_permissao` | Pedindo permissão | novo `.selo-permissao`: `--aviso-fundo` / `--aviso-texto` | losango (`clip-path: polygon(50% 0,100% 50%,50% 100%,0 50%)`) | `--permissao-borda` |
| `parada` | Parada | `--ociosa-*` | círculo vazado (já existe) | `--ociosa-cor` |
| `encerrada` | Encerrada | `--enc-*` | quadrado (já existe) | `--enc-cor` |

Contraste medido (calculado a partir dos tokens): `--aviso-texto` sobre `--aviso-fundo` = 8,44:1 no claro e 10,16:1 no escuro; os outros selos já passam hoje. O `--aviso-borda` atual só tem 1,71:1 contra a superfície no tema claro, então a borda do bloco de permissão e a borda esquerda do cartão usam um token novo `--permissao-borda`: `#9a6f00` no claro (4,52:1 sobre `--superficie`) e `#c9a227` no escuro (7,33:1). É o único token novo.

Estados: carregando (antes do primeiro retrato) mostra "Carregando…" como hoje; vazio não se aplica; erro: `estado` com valor desconhecido mostra o texto cru em `.selo-ociosa`; desabilitado não se aplica. Quando o coletor está fora do ar, o selo continua, mas o detalhe mostra "Estado de HH:MM; o coletor está fora do ar" (item 9).

Resumo: quando houver sessão em `esperando_permissao`, uma segunda pílula em `.resumo-linha`: "1 esperando permissão" / "2 esperando permissão" (`.num`, âmbar). Se também houver `esperando_mensagem` não se conta; só permissão exige o dono.

### 2. Última resposta

- Título (`h3`): "Última resposta" e, à direita no mesmo `h3`, `<time>` com "às 14:32" (hoje) ou "12/11 14:32" (outro dia), de `ultimaRespostaEm`.
- Texto em `<p class="resposta">`, somente `textContent` (nunca `innerHTML`, nunca Markdown), `white-space: pre-wrap; overflow-wrap: anywhere`, fonte do corpo, 0,9375rem, linha 1,45. Recolhido em 6 linhas (`-webkit-line-clamp: 6`); botão `.btn-leve` "Mostrar tudo" / "Mostrar menos" com `aria-expanded` e `aria-controls`. Só aparece o botão se o texto passa de 6 linhas (medir por `scrollHeight > clientHeight`).
- Notas abaixo, em `.meta`: se o texto contém `[oculto]`: "Trechos marcados [oculto] foram escondidos por segurança antes de sair do computador."; se `length >= 1200`: "Resposta cortada em 1.200 caracteres."
- Vazio (sem `ultimaResposta`): "Esta sessão ainda não respondeu."
- Carregando/erro/desabilitado: não se aplicam (vem no retrato).

### 3. Caixa de mensagem

Só aparece com `gerenciada: true` e `estado !== 'encerrada'`. Estrutura: `<form class="mensagem-form">`, `<label for>` "Mensagem para a sessão", `<textarea class="campo campo-area" rows="3" maxlength="6000">` (`.campo-area`: `padding: 10px 12px; min-height: 88px; resize: vertical; line-height: 1.45`), botão `.btn.btn-primario` "Enviar mensagem". Enter quebra linha; Ctrl/Cmd+Enter envia (dica `.meta` só em `(hover: hover)`: "Ctrl+Enter envia"). Contador só a partir de 5.000 caracteres: "5.350 de 6.000" (`.meta`, `aria-live` desligado).

| Estado | O que se vê |
|---|---|
| Normal (`esperando_mensagem` ou `parada`) | caixa e botão habilitados. Botão desabilitado enquanto o texto estiver vazio (só espaços conta como vazio) |
| Enviando | botão "Enviando…" desabilitado, textarea `readonly` (mantém foco e texto) |
| Enviado | texto limpo, foco volta ao textarea, andamento mostra o passo (item 6) |
| Erro ao enviar | texto preservado; `.acao-estado.erro` com o motivo (item 6); botão volta a "Enviar mensagem" |
| Comando recusado ou falhou depois | andamento mostra o motivo e o texto enviado volta para a caixa, se ela estiver vazia, com a nota "Sua mensagem foi devolvida à caixa." |
| `trabalhando` | caixa visível, botão desabilitado, motivo escrito sob ela: "A sessão está trabalhando. Espere terminar ou toque em Interromper." |
| `esperando_permissao` | idem: "Responda ao pedido de permissão acima antes de mandar outra mensagem." |
| Comando de mensagem anterior em andamento | desabilitado: "Aguarde a mensagem anterior chegar à sessão." |
| Coletor fora do ar ou orquestração desligada | desabilitado com o motivo do item 9 |
| Conteúdo longo | `resize: vertical`; contador; 6.000 é o teto (maxlength, o do contrato) |

O rascunho não pode se perder: a caixa é criada uma vez por cartão e atualizada no lugar. O re-render a cada 15 s nunca recria o textarea nem tira o foco dele. Rascunho some só ao enviar com sucesso para o servidor.

**Sessão aberta à mão** (`gerenciada: false`, não encerrada), no lugar da caixa, `<p class="meta">`: "Esta sessão foi aberta fora do Moisés. Daqui dá para acompanhar e encerrar. Para mandar mensagens pelo painel, encerre e toque em Retomar." **Encerrada, `retomavel: true`:** "Sessão encerrada. Toque em Retomar para continuar a conversa por aqui." **Encerrada, `retomavel: false`:** "Sessão encerrada. A pasta do projeto não está na lista de projetos permitidos deste computador, então não dá para retomar pelo painel."

### 4. Bloco de pedido de permissão

Um `<section class="permissao" role="group" aria-labelledby>` por item de `permissoes`, no topo do detalhe, na ordem recebida. Visual: fundo `--aviso-fundo`, borda de 2 px `--permissao-borda`, raio `--raio-p`, padding 14 px, margem inferior 10 px. Distinto de tudo o mais no cartão (único bloco com fundo âmbar e borda grossa) e com texto, não só cor.

Cada permissão do retrato traz `pedido`, `ferramenta`, `entrada`, `completo`, `sensivel` e `criadoEm`. Não há conferência de MAC no painel: o que protege o dono é só poder aprovar o que foi mostrado inteiro e assinar a impressão digital do que ele viu (CA8, S2).

Conteúdo, de cima para baixo:

1. `h3` "Pedido de permissão" (com "2 de 3" quando houver mais de um) e o marcador losango do selo.
2. `<p>`: "A sessão quer usar a ferramenta **Bash**." (nome da ferramenta em negrito, `textContent`).
3. Se `sensivel: true`: `<p class="permissao-aviso">` **antes da entrada e dos botões**, com "Atenção." em negrito: "Atenção. Este pedido mexe com chaves, senhas ou configuração do Moisés ou do Claude Code. Aprove só se foi você quem pediu isso." Mesma faixa do bloco, texto em `--aviso-texto`; a palavra "Atenção." é o sinal, não a cor. Não bloqueia: o dono pode aprovar ou negar.
4. Rótulo "O que ela quer fazer" e `<pre class="entrada" tabindex="0" role="group" aria-label="Entrada do pedido">` com `entrada` via `textContent` e `font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14em; overflow: auto; background: var(--superficie); border: 1px solid var(--borda); border-radius: 8px; padding: 10px`. **As quebras de linha são preservadas e nada é cortado com reticências** (sem `text-overflow`, sem `line-clamp`): o que aparece é exatamente o que será assinado (`vistoHash`). Caracteres invisíveis e de direção de texto já chegam escapados como `\u{XXXX}` e aparecem assim, em texto comum; a interface não os altera. `tabindex="0"` só para o trecho rolar pelo teclado.
5. Se a entrada contém `[oculto]`: `.meta` "Trechos marcados [oculto] foram escondidos por segurança."
6. Botões `.botoes`:
   - `completo: true`: **Negar** (`.btn`, neutro, à esquerda) e **Aprovar** (`.btn.btn-primario`). Mesma altura de 44 px, `gap: 8px`; em 320 px lado a lado se couber, senão empilhados, Aprovar por cima. Nenhum é "perigo" vermelho: negar é o lado seguro.
   - `completo: false`: faixa `.permissao-aviso` com "Este pedido não coube inteiro no painel; só é possível negar." e **só Negar**. Aprovar **não é exibido** (some, em vez de ficar desabilitado, para não induzir a insistir). Não existe "Aprovar mesmo assim": não se aprova o que não foi visto inteiro.

Estados:

| Estado | O que se vê |
|---|---|
| `completo: true` | Aprovar e Negar habilitados |
| `completo: false` | só Negar, com o texto acima |
| `sensivel: true` | aviso do item 3 antes dos botões; combina com qualquer outro estado |
| Aparelho sem código | Aprovar e Negar aparecem normais; ao tocar, `enviarComando` abre o diálogo do código (item 8) e, guardado o código, a resposta segue sozinha |
| Enviando resposta | os dois botões desabilitados, o clicado vira "Aprovando…" ou "Negando…" |
| Respondido | o bloco fica, com os botões trocados por "Resposta enviada. Aguardando o coletor." até o pedido sumir de `permissoes` na próxima consulta; some do DOM com o foco indo para o título da seção "Última resposta" (ou, se o cartão fechou, para o cabeçalho do cartão) |
| Recusado pelo coletor | `.acao-estado.erro` dentro do bloco com o texto do motivo (item 6). Se o motivo for `assinatura` ou `aparelho`, mais "Digitar o código de novo". Se o coletor disser que o pedido não está mais pendente ou que mudou, o bloco some na consulta seguinte; nos demais casos os botões voltam |
| Erro antes de chegar ao servidor | `.acao-estado.erro` dentro do bloco, texto do item 6 ("Não enviado: …"); botões voltam |
| Coletor fora do ar ou orquestração desligada | pedido visível (último conhecido) com faixa: "O coletor está fora do ar. Este pedido pode já ter sido resolvido." Botões desabilitados |
| Entrada longa | rola dentro do `<pre>`; nunca estoura a coluna |
| Vários pedidos | empilhados, cada um com o seu estado |

O comando de aprovar leva `vistoHash = hashVisto(ferramenta, entrada)` calculado sobre exatamente o texto exibido no `<pre>`; os dois comandos levam `visto` (projeto e nome do cartão). Se o retrato mudar a `entrada` do mesmo `pedido` depois de exibida, o bloco é recriado e o hash segue o que está na tela no momento do toque.

### 5. Ações por estado e por tipo de sessão

Condição geral: nenhum botão que envia comando fica habilitado com o coletor fora do ar ou `orquestracao.ativa` falso (item 9). Sessão "comandada" = `gerenciada: true`.

| `estado` | Comandada | Caixa de mensagem | Interromper | Encerrar | Retomar |
|---|---|---|---|---|---|
| `trabalhando` | sim | visível, desabilitada | sim | sim | não |
| `trabalhando` | não | linha explicativa | não | sim | não |
| `esperando_mensagem` | sim | habilitada | não | sim | não |
| `esperando_mensagem` | não | linha explicativa | não | sim | não |
| `esperando_permissao` | sim | visível, desabilitada; blocos de permissão no topo | sim | sim | não |
| `esperando_permissao` | não | linha explicativa e "Esta sessão está esperando permissão no terminal onde foi aberta." | não | sim | não |
| `parada` | sim | habilitada | não | sim | não |
| `parada` | não | linha explicativa | não | sim | não |
| `encerrada` | qualquer | não (linha de encerrada) | não | não | só se `retomavel: true` (sem o campo, não aparece) |

Regras: Encerrar e Interromper aparecem sempre que a matriz diz sim, mesmo com outro comando em andamento na sessão, exceto que ficam desabilitados enquanto um comando do mesmo verbo estiver em andamento ("Aguarde: já existe um pedido de interromper em andamento"). Retomar some assim que o comando é aceito.

**Interromper** (confirmação inline, `.confirmar`): texto "Interromper o que a sessão está fazendo agora? A sessão continua aberta e você pode mandar outra mensagem." Botões "Interromper" (`.btn-perigo`) e "Cancelar". Foco inicial em Cancelar.

**Encerrar** (confirmação inline, o formulário que já existe, com texto novo): título "Encerrar esta sessão?". Comandada: "O processo será fechado no computador. Você pode retomar a conversa depois." Não comandada: "O Claude Code desta sessão será finalizado no computador, inclusive no terminal onde ele está aberto. Trabalho que não foi salvo pode se perder. Você pode retomar a conversa pelo painel depois." Campo "Nome do trabalho" como hoje; botões "Encerrar e salvar log" (`.btn-primario`) e "Cancelar". Foco inicial no campo, como hoje; Esc cancela.

**Retomar** (inline, `.confirmar`): "Retomar esta conversa no computador?" Três campos: Modo de permissão (select, padrão "Perguntar antes de agir (manual)"), Modelo (select, padrão "Manter o da sessão") e Esforço (select, padrão "Manter o da sessão"). Botões "Retomar sessão" (`.btn-primario`) e "Cancelar".

### 6. Linha de andamento do último comando

`<div class="andamento">` por cartão, logo acima das ações, com dois filhos: `<ol class="passos" aria-hidden="true">` (visual) e `<p class="acao-estado" role="status" aria-live="polite">` (a frase, que é o que o leitor de tela ouve). Fonte: o comando mais novo da sessão em `comandos` (por `chave`) ou o pendente local, como `comandoDe` faz hoje. Visível por 5 minutos depois do `criadoEm` e some depois (como `recemEncerrada`). Não-vazio mantém o último até o próximo comando.

Passos visuais: três itens "Enviado", "Recebido", "Executado". Concluído: "✓ " antes do texto, cor `--ok-texto`; atual: texto em negrito, cor `--destaque`, com reticências animadas só fora de `prefers-reduced-motion`; futuro: `--texto-suave`. Em falha, o passo onde parou vira "✕ Recusado", "✕ Falhou" ou "✕ Expirado" em `--perigo`. Em 320 px os três cabem em uma linha (0,8125rem).

Mapa estado do comando → passos → frase (a frase troca "Mensagem" conforme o verbo):

| Estado do servidor | Passos | Frase (mensagem, como exemplo) |
|---|---|---|
| `pendente` | ✓ Enviado, Recebido…, Executado | "Mensagem enviada. Aguardando o coletor…" |
| `recebido` | ✓ Enviado, ✓ Recebido, Executado… | "O coletor recebeu a mensagem. Entregando à sessão…" |
| `feito` | ✓ ✓ ✓ | "Mensagem entregue à sessão." |
| `recusado` | ✓ Enviado, ✕ Recusado | "O coletor recusou a mensagem: <erro>" |
| `falhou` | ✓ ✓ ✕ Falhou | "A mensagem não foi entregue: <erro>" |
| `expirado` | ✓ Enviado, ✕ Expirado | "O coletor não buscou o pedido em 2 minutos, então ele expirou e não foi executado. Tente de novo quando o coletor voltar." |

Frases por verbo (pendente / recebido / feito): **mensagem**: acima. **permissao**: "Resposta enviada. Aguardando o coletor…" / "O coletor recebeu a resposta. Entregando à sessão…" / "Resposta entregue à sessão." **interromper**: "Pedido de interrupção enviado…" / "O coletor recebeu. Interrompendo…" / "Sessão interrompida. Ela espera a sua próxima mensagem." **encerrar**: "Encerrando… aguardando o coletor." / "O coletor recebeu. Encerrando a sessão…" / "Encerrada. Log salvo no Histórico." **retomar**: "Pedido de retomada enviado…" / "O coletor recebeu. Retomando…" / "Sessão retomada." **abrir** (aparece sob o botão Nova sessão, item 7): "Pedido de nova sessão enviado…" / "O coletor recebeu. Abrindo a sessão…" / "Sessão aberta. Ela aparece na lista em instantes."

**Motivo da recusa.** Cada comando em `comandos` traz `motivo` quando `recusado`. O painel escolhe o texto só pelo `motivo`, nunca procurando palavras no texto de `erro`:

| `motivo` | Texto (depois de "O coletor recusou a mensagem:") | Ação extra |
|---|---|---|
| `assinatura`, `aparelho` | "o código deste aparelho não foi aceito pelo computador." | botão `.btn-leve` "Digitar o código de novo" (abre o diálogo do item 8) |
| `relogio` | "a hora deste aparelho está diferente da do computador. Acerte a data e a hora do celular (ajuste automático) e tente de novo." | nenhuma |
| `expirado` | "o pedido demorou mais de 2 minutos para chegar e não foi executado. Tente de novo." | nenhuma |
| `repetido` | "este pedido já tinha sido recebido." | nenhuma |
| `ritmo` | "pedidos demais em pouco tempo. Espere um minuto e tente de novo." | nenhuma |
| `desligado` | "os comandos estão desligados neste computador." | nenhuma |
| `sem_chave` | "o computador não tem nenhum código de aparelho configurado." | nenhuma |
| `formato` | "o pedido veio em formato inválido." | nenhuma |
| `verbo` | "este tipo de pedido não é aceito." | nenhuma |
| `interno` | "erro interno do coletor. Tente de novo; se repetir, veja o log no computador." | nenhuma |
| outro ou ausente | "motivo não informado." | nenhuma |

Recusas que o contrato não lista como motivo (sessão diferente da que você viu, teto de sessões, de aberturas ou de gasto): o painel mostra o texto de `erro` como veio, pois o coletor já o escreve em português e sem dado de sessão. Para `falhou` usa-se sempre `erro` (ou "motivo não informado" se vier vazio). O `<erro>` da tabela do item 6 é, portanto, o texto do motivo acima ou o `erro` do coletor. `recusado` e `falhou` usam `role="alert"` em vez de `status` (anúncio imediato, uma vez).

Erro antes de chegar ao servidor (não há comando ainda): `.acao-estado.erro` "Não enviado: sem conexão. Tente de novo." / 400 "Não enviado: o pedido está inválido." / 409 "Este pedido já tinha sido enviado." / 429 "Há pedidos demais esperando o coletor. Espere alguns instantes e tente de novo." / outros "Não enviado: erro ao falar com o painel." Sessão 401 já redireciona ao login.

### 7. Nova sessão

**Botão:** `.btn.btn-primario` "Nova sessão", largura total, 44 px, entre o resumo e o filtro. É a única ação principal da tela de lista.

| Situação | Botão | Texto abaixo (`.acao-estado`) |
|---|---|---|
| `orquestracao` ausente ou `ativa` falso | desabilitado | "A orquestração está desligada neste computador. Rode `node scripts/configurar-comandos.js` nele para ligar." |
| `ativa` e `projetos` vazio | desabilitado | "Nenhum projeto permitido neste computador. Adicione projetos ao arquivo projetos.json, em ~/.config/moises." |
| `abertas >= maxSessoes` | desabilitado | "Limite de <maxSessoes> sessões abertas pelo painel. Encerre uma para abrir outra." |
| Coletor fora do ar | desabilitado | motivo do item 9 |
| Pronto | habilitado | vazio; ou a linha de andamento do último "abrir" (item 6) |

Os outros tetos do coletor (aberturas por dia, gasto por sessão, ritmo) não aparecem antes: o painel não os conhece e só mostra a recusa do coletor, com o texto do item 6, na linha de andamento do "abrir".

**Diálogo** (`<dialog class="dialogo">`, `showModal()`; em telas até 600 px ocupa a largura toda, colado embaixo e com cantos de cima arredondados, rola por dentro com `max-height: 92dvh`; acima disso, centralizado com 520 px). Título "Nova sessão". Botão de fechar `.btn-leve` "Fechar" no topo. Campos, nesta ordem, todos com `<label>` visível:

| Campo | Controle | Regras |
|---|---|---|
| Projeto | `<select class="campo">`, primeira opção "Escolha um projeto" | obrigatório; opções = `orquestracao.projetos` |
| Conta | `<select>` | só aparece se `contas.length > 1`; padrão `principal` |
| Pedido inicial | `<textarea class="campo campo-area" rows="4">` | obrigatório, 1 a 6.000 caracteres (limite do contrato); dica "Descreva o que a sessão deve fazer primeiro." |
| Modelo | `<select>` | primeira opção "Padrão da conta" (não envia); depois `orquestracao.modelos`: Haiku, Sonnet, Opus, Fable |
| Esforço | `<select>` | "Padrão" (não envia), Baixo (`low`), Médio (`medium`), Alto (`high`), Muito alto (`xhigh`), Máximo (`max`) |
| Modo de permissão | `<fieldset>` com 3 `radio` e ajuda embaixo de cada | "Perguntar antes de agir" (`manual`, **marcado**): "A sessão pede a sua permissão antes de editar arquivos ou rodar comandos."; "Aceitar edições" (`acceptEdits`): "Edita arquivos sem perguntar; comandos ainda pedem permissão."; "Só planejar" (`plan`): "A sessão só propõe um plano, sem mudar nada." Sem opção para pular permissões, em lugar nenhum |
| Cópia isolada | `<input type="checkbox">` | "Trabalhar numa cópia isolada (worktree)"; ajuda: "Cria um ramo e uma pasta separados dentro do projeto, sem mexer no seu trabalho principal." |
| Nome | `<input class="campo" maxlength="60">` | opcional; ajuda "Letras, números, espaço, ponto, hífen e sublinhado."; regra `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$` |

**Linha de ajuda sobre isolamento**, `.meta`, logo abaixo do título do formulário: "Sessões abertas pelo painel rodam isoladas: sem seus plugins, servidores MCP, skills e comandos de barra, e só com as ferramentas básicas (Bash, Read, Edit, Write, Glob, Grep)." Ela existe para que o dono não estranhe a sessão "mais simples" que o Claude Code dele no terminal.

Limite de alvo: cada rádio e o checkbox têm a linha inteira clicável (`<label>` com `min-height: 44px`).

Validação: ao sair do campo (blur) e ao tocar "Revisar"; erro em `<p class="campo-erro" id="…">` ligado por `aria-describedby`, `aria-invalid="true"` no controle. Mensagens: Projeto "Escolha um projeto."; Pedido "Escreva o pedido inicial."; Pedido longo "O pedido passa de 6.000 caracteres."; Nome "Use só letras, números, espaço, ponto, hífen e sublinhado, começando por letra ou número." No envio com erro, o foco vai para o primeiro campo inválido e um `role="alert"` no topo do formulário diz "Corrija <N> campo(s) para continuar."

**Etapa de resumo (CA10).** Botão do formulário: "Revisar" (`.btn-primario`). O mesmo diálogo troca para o resumo, com título "Confirmar nova sessão" e `<dl class="grade">`: Projeto, Conta (se houver), Modelo, Esforço, Modo de permissão (rótulo e, abaixo, a ajuda), Cópia isolada (Sim/Não), Nome (ou "automático"), Pedido inicial (em `.resposta`-like, completo, `pre-wrap`, rolável). Frase fixa: "O Claude vai trabalhar na pasta do projeto, neste modo, no seu computador. Ele roda isolado: sem seus plugins, MCP, skills e comandos de barra, só com as ferramentas básicas. Sessões abertas pelo painel: <abertas> de <maxSessoes>." Botões: "Abrir sessão" (`.btn-primario`) e "Voltar e editar" (`.btn`). Foco inicial no título do resumo (`tabindex="-1"`).

Enviando: "Abrir sessão" vira "Enviando…" e os dois botões ficam desabilitados. Sucesso (servidor aceitou): o diálogo fecha, o foco vai para o botão "Nova sessão" e a linha de andamento do "abrir" aparece embaixo dele. Erro: faixa `role="alert"` dentro do resumo com o motivo (item 6, erros antes do servidor) e os botões voltam. O formulário guarda os valores até a sessão aparecer ou o diálogo ser cancelado; ao reabrir depois de enviar, vem limpo.

### 8. Código do aparelho

O código tem o formato `xxxxxx-xxxx-xxxx-xxxx-xxxx` (22 caracteres em 5 grupos, alfabeto sem `i`, `l`, `o`, `0`, `1`). Os 6 primeiros são o identificador público do aparelho (`kid`). Dele sai uma chave não extraível, guardada por `public/cofre.js` no **IndexedDB**; o código digitado nunca é guardado nem enviado, e o campo é limpo ao fechar o diálogo.

Diálogo `<dialog class="dialogo">` aberto por `enviarComando` quando o aparelho não tem chave, pelo rodapé e pelo botão "Digitar o código de novo".

Conteúdo: título "Código do aparelho". Texto: "Este aparelho ainda não pode mandar comandos ao seu computador. Digite o código que o computador gerou para ele. O código não fica guardado: só uma chave que não pode ser copiada permanece neste aparelho." (na troca: "Digite o novo código. Ele substitui o que está guardado neste aparelho."). Campo `<input type="password" class="campo" autocomplete="off" autocapitalize="none" spellcheck="false">` com label "Código", **fora de qualquer `<form>`** (Enter no campo aciona "Guardar neste aparelho" por script) e ajuda "22 letras e números, como xxxxxx-xxxx-xxxx-xxxx-xxxx. Hífens e espaços são ignorados." Colar funciona (nada de bloquear `paste`). Botão `.btn-leve` "Mostrar código" (`aria-pressed`). Botões "Guardar neste aparelho" (`.btn-primario`) e "Cancelar".

| Estado | O que se vê |
|---|---|
| Primeira vez | como acima; foco no campo |
| Código mal formado (depois da normalização não são 22 caracteres do alfabeto) | erro no campo: "O código tem 22 letras e números. Confira e tente de novo." Nada é derivado |
| Derivando (PBKDF2 pode levar de 0,3 a 1,5 s no celular) | botão "Conferindo…" desabilitado, `aria-busy="true"` no diálogo |
| Guardado | diálogo fecha; se veio de um comando, ele é enviado; senão o rodapé mostra "Código guardado neste aparelho." (`role="status"`) |
| IndexedDB indisponível (navegação privada, bloqueio) | erro no diálogo: "Este navegador não deixou guardar o código. Saia do modo privado e tente de novo." Nada é enviado |
| Código errado ou de aparelho desconhecido | o aparelho não tem como conferir na hora. O coletor recusa o comando com o motivo `assinatura` ou `aparelho` e a linha de andamento (item 6) oferece "Digitar o código de novo" |
| Cancelar | fecha e o comando que o pedia não é enviado; a tela diz "Comando não enviado: falta o código do aparelho." |

**Rodapé "Este aparelho"** (`<section aria-labelledby>`, discreto, no fim da página, nas duas abas): `h2` pequeno "Este aparelho". Com chave: "Aparelho `<kid>`" seguido de " · <rótulo>" quando o `kid` está em `orquestracao.aparelhos` (por exemplo "Aparelho ab2cd3 · celular do Moisés"); se o `kid` não está na lista (e o retrato já trouxe `orquestracao`): "Aparelho `<kid>`. O computador não conhece este código; os comandos serão recusados. Digite o código de novo ou esqueça este aparelho." Botões `.btn-leve` "Trocar código" e "Esquecer este aparelho". Sem chave: "Este aparelho ainda não tem código." e `.btn` "Informar código". "Esquecer este aparelho" abre confirmação inline: "Este aparelho vai deixar de mandar comandos até você digitar o código de novo." e botões "Esquecer este aparelho" (`.btn-perigo`) e "Cancelar"; ao concluir: "Aparelho esquecido." (`role="status"`). **Sair do painel também esquece o aparelho** (chama `esquecer()`); com chave, o rodapé acrescenta: "Sair do painel também esquece este aparelho."

**Onde a chave fica:** `CryptoKey` HMAC não extraível no IndexedDB (banco `moises`, armazém `chaves`, registro `comandos`), por `public/cofre.js`. Nada em `localStorage` nem `sessionStorage`. Quem conseguir rodar script no painel ainda poderia pedir assinaturas enquanto ele estiver aberto, mas não leva a chave embora (S1); a CSP e a ausência de `innerHTML` reduzem esse risco (S12).

### 9. Coletor fora do ar e orquestração desligada

"Fora do ar" = sem retrato ou `recebidoEm` com mais de 120 s (mesma regra do `COLETOR_PARADO_MS`). Ordem de prioridade do motivo: coletor fora do ar, depois orquestração desligada.

- **Banner** `#banner-coletor` (`.banner`, `role="status"`), acima do botão Nova sessão: "O coletor está fora do ar desde 14:02. Você vê o último estado conhecido, mas não pode mandar comandos." Sem retrato nunca: "O coletor ainda não enviou dados. Sem ele não dá para mandar comandos."
- **Botões**: todos os que enviam comando ficam `disabled` (padrão visual existente: opacidade 0,6). Como botão desabilitado não recebe foco, **o motivo é sempre texto visível**, em `.acao-estado` logo abaixo do grupo (uma vez por cartão, não por botão), ligado por `aria-describedby` aos botões: "Comandos desligados: o coletor está fora do ar desde 14:02."
- **Orquestração desligada**: "Comandos desligados: a orquestração está desligada neste computador." (`orquestracao.ativa` falso ou ausente).
- **Estado do cartão**: continua o último selo, mas `.meta` no topo do bloco novo diz "Estado de 14:02. Pode estar desatualizado."
- **Comando já enviado** quando o coletor cai: a linha de andamento fica em "Enviado" e acrescenta, depois de 20 s, "O coletor está fora do ar. O pedido vale por 2 minutos e depois expira."
- Quando o coletor volta, tudo se reabilita na consulta seguinte, sem recarregar a página.

### 10. Textos da interface

Tudo em pt-BR, direto em `app.js` e `index.html` como hoje (o projeto não tem arquivo de textos; sugestão: agrupar em um objeto `TEXTOS` no topo de `app.js`). Rótulos e mensagens estão nos itens acima; lista de conferência dos que não aparecem em tabela:

- Botões: "Nova sessão", "Revisar", "Voltar e editar", "Abrir sessão", "Enviar mensagem", "Aprovar", "Negar", "Interromper", "Encerrar", "Encerrar e salvar log", "Retomar", "Retomar sessão", "Cancelar", "Fechar", "Mostrar tudo", "Mostrar menos", "Guardar neste aparelho", "Informar código", "Trocar código", "Esquecer este aparelho", "Mostrar código", "Digitar o código de novo".
- Avisos fixos do bloco de permissão: "Atenção. Este pedido mexe com chaves, senhas ou configuração do Moisés ou do Claude Code. Aprove só se foi você quem pediu isso." e "Este pedido não coube inteiro no painel; só é possível negar."
- Em andamento: "Enviando…", "Aprovando…", "Negando…", "Conferindo…" (derivando a chave do código).
- Região viva `#anuncios` (só leitor de tela): "<projeto>: pedindo permissão para usar <ferramenta>." / "<projeto>: esperando você." / "<projeto>: terminou o trabalho." (de `trabalhando` para `esperando_mensagem`) / "<projeto>: encerrada." Só quando o `estado` mudou entre duas consultas, nunca na primeira carga; várias mudanças na mesma consulta viram uma só frase separada por ponto.
- Título da aba: com permissões pendentes, `document.title = "(2) Moisés · Sessões do Claude Code"`; volta ao normal sem pendências.

## Estados (visão geral)

| Item | Normal | Carregando/enviando | Erro | Vazio | Desabilitado |
|---|---|---|---|---|---|
| Selo | item 1 | "Carregando…" da lista | texto cru | n/a | n/a |
| Última resposta | item 2 | n/a | n/a | "Esta sessão ainda não respondeu." | n/a |
| Mensagem | caixa | "Enviando…" | `.acao-estado.erro` | caixa vazia, botão desabilitado | com motivo escrito |
| Permissão | `completo`: Aprovar e Negar; senão só Negar; `sensivel`: aviso antes | "Aprovando…" | "Não enviado: …" ou motivo da recusa (item 6) | sem bloco | faixa do item 9 |
| Ações | matriz do item 5 | confirmação aberta / botão "Aguarde" | andamento `recusado`/`falhou` | n/a | com motivo escrito |
| Andamento | passos e frase | `pendente`/`recebido` | `recusado`, `falhou`, `expirado` | oculto sem comando recente | n/a |
| Nova sessão | formulário e resumo | "Enviando…" | campo e faixa | projetos vazio | item 7 |
| Código | diálogo | "Conferindo…" | mal formado | n/a | n/a |

## Acessibilidade (WCAG 2.2 AA)

- **Contraste**: todos os pares reaproveitam tokens que já passam (texto 15 a 18:1, `--texto-suave` 7,9:1, `--perigo` 6,6 a 8,7:1, botão primário 7,9 a 9,6:1, `--borda-campo` 4,0:1 contra superfície). Novo: `--permissao-borda` 4,52:1 (claro) e 7,33:1 (escuro) contra a superfície, acima dos 3:1 de componente. Pares calculados em 11/11/2026 a partir de `style.css`.
- **Cor nunca sozinha**: selo = texto + forma; passos do andamento = texto + ✓/✕; bloco de permissão = título e texto; erro = texto "Não …".
- **Alvo de toque**: todos os botões, selects, rádios (linha inteira) e checkbox com 44 px de altura mínima; `gap` de 8 px entre botões; "Mostrar tudo" e botões `.btn-leve` também 44 px (já é a regra de `.btn`).
- **Foco**: `:focus-visible` existente (3 px, `--foco`). `<pre class="entrada">` com `tabindex="0"` tem o mesmo anel. O cabeçalho sticky (`.abas`) já tem `scroll-padding-top: 76px`, então o foco não fica escondido atrás dele (WCAG 2.4.11).
- **Diálogos**: `<dialog>` nativo com `showModal()` (preso o foco, Esc fecha, fundo inerte). Ordem de foco ao abrir: Nova sessão, primeiro campo ("Projeto"); resumo, título do resumo; código do aparelho, campo "Código". Ao fechar, o foco volta ao botão que abriu (ou, se ele sumiu, ao cabeçalho do cartão). `::backdrop` com `rgb(0 0 0 / 0.6)`, suficiente para isolar o conteúdo nos dois temas. Foco inicial das confirmações destrutivas em "Cancelar" (Interromper) ou no campo de nome (Encerrar, como hoje).
- **Regiões vivas**: uma `aria-live="polite"` global (`#anuncios`) para mudanças de estado, uma `role="status"` por linha de andamento (cada uma só é preenchida quando o comando muda de estado, para não repetir a cada consulta de 2 s) e `role="alert"` só para `recusado`, `falhou`, "não conferido" e erro de formulário. O selo de cada cartão **não** é região viva (seriam dezenas de anúncios). Nenhuma região viva é recriada a cada render: criar uma vez e trocar o texto.
- **Rótulos**: todo campo com `<label for>`; ajuda e erro ligados com `aria-describedby`; grupo de rádios em `<fieldset><legend>`; botão de mostrar código com `aria-pressed`; "Mostrar tudo" com `aria-expanded`.
- **Semântica**: botões são `<button>`, formulários `<form>`, lista de passos `<ol>` (oculta ao leitor porque a frase já diz o mesmo), `<time datetime>` no horário. ARIA só onde não há elemento nativo.
- **Movimento**: o pulso do selo e as reticências do andamento ficam dentro de `@media (prefers-reduced-motion: no-preference)`; a regra global que já zera animações continua valendo.
- **Autenticação**: o campo do código aceita colar e gerenciador de senhas (WCAG 3.3.8); nenhuma prova cognitiva.
- **Zoom e texto grande**: textos em `rem`, `overflow-wrap: anywhere` em tudo que vem do coletor; nada com altura fixa em pixels exceto `max-height` com rolagem. Conferir a 320 px e com texto a 200%.

## O que o dev precisa implementar

1. `index.html`: `<script type="module" src="/app.js">`; botão e linha de andamento de Nova sessão; `#banner-coletor`; `<dialog id="dlg-nova">` e `<dialog id="dlg-codigo">`; rodapé "Este aparelho"; `<div id="anuncios" class="so-leitor" aria-live="polite">`.
2. `public/cofre.js` (novo): `guardar({kid, chave})`, `obter()`, `esquecer()` sobre o IndexedDB (banco `moises`, armazém `chaves`, registro `comandos`). `app.js` importa `./assinatura.js` e `./cofre.js`. `enviarComando(tipo, sessao, dados)`: se `obter()` não devolve chave, abre o diálogo do código e continua depois; acrescenta `visto: {projeto, nome}` da sessão exibida e, em `aprovar`, o `vistoHash` de `hashVisto(ferramenta, entrada)` sobre o texto exibido; assina, `POST /api/comando`, guarda o comando em `pendentesLocais`, acelera a consulta para 2 s enquanto houver `pendente` ou `recebido` (e volta a 15 s depois). Sair do painel chama `esquecer()`.
3. Selo por `estado` com a tabela do item 1 e queda para `status`; contador no resumo; título da aba; anúncios.
4. Detalhe do cartão na nova ordem, criado uma vez e atualizado no lugar (textarea e foco preservados); últimos 5 minutos do andamento; `comandoDe` continua escolhendo o comando mais novo por `chave`.
5. Bloco de permissão com `completo` e `sensivel` e todos os estados do item 4 (sem segunda etapa de aprovar).
6. Matriz de ações do item 5 (Retomar por `retomavel`), confirmações de Interromper, Encerrar (texto novo, rota nova) e Retomar. `POST /api/encerrar` some do código (a rota é removida na tarefa 4).
7. Diálogo Nova sessão com validação, teto `maxSessoes` e resumo; diálogo do código; rodapé com `kid` e rótulo; mapa de `motivo` → texto (item 6).
8. `style.css`: token `--permissao-borda` nos dois temas; `.selo-permissao`; `.cartao[data-status="permissao"]`; `.resposta`, `.entrada`, `.permissao`, `.permissao-aviso`, `.andamento`, `.passos`, `.mensagem-form`, `.campo-area`, `.campo-erro`, `.dialogo` (e `::backdrop`), `.so-leitor`, `select.campo` (`appearance` nativa mantida, altura 44 px) e o rodapé. Nada de estilo inline: toda variação por classe ou atributo `data-`.
9. **Nenhum `innerHTML`** (nem `insertAdjacentHTML`, `outerHTML`, `document.write`): todo elemento sai de `document.createElement` e `textContent`/`append`. A CSP passa a ter `require-trusted-types-for 'script'`; qualquer atribuição de string a um destino de HTML quebra a página. Atributos `href` nunca recebem conteúdo de sessão.

## Arquivos de apresentação afetados

`public/index.html`, `public/app.js`, `public/style.css` e o novo `public/cofre.js` (sem interface). `vercel.json` (CSP com `require-trusted-types-for 'script'`) é da tarefa 4, não da apresentação. Novo token global `--permissao-borda`: usado só pelos componentes novos; nenhum componente existente muda de aparência além do selo (rótulos) e do bloco de ação (substituído).

## Roteiro de conferência manual (dev e QA)

Não há simulador de coletor. O roteiro usa o painel local com um coletor de verdade apontado para ele: `PORT=3800 node scripts/dev.js` e, em outro terminal, o coletor local com as variáveis do painel local, uma pasta temporária de configuração (lista de projetos só com `~/moises-sandbox`, `soPrefixo: 'moises-teste-'`) e o código de um aparelho gerado para o teste. O lead roda este roteiro junto com o teste de ponta a ponta (`npm run e2e`). Tenha uma sessão de teste aberta (uma aberta pelo painel e uma aberta à mão num terminal). Abra `http://localhost:3800`, entre com a senha, use o DevTools em 375 e depois 1280 px, nos temas claro e escuro. Marque também 320 px.

Passos marcados **[conferir no código]** dependem de estado difícil de provocar com um coletor real (relógio errado, pedido cortado, caractere invisível, ritmo, expiração). Para eles, leia o `app.js` e confirme que o ramo existe e que o texto bate com a spec; se quiser ver na tela, publique o retrato à mão pela API do painel local com o token do coletor.

1. Sem o coletor ligado: ver "O coletor ainda não enviou dados" no resumo e no banner; "Nova sessão" desabilitado com motivo escrito.
2. Coletor com `MOISES_COMANDOS=0`: motivo "desligada neste computador" nos botões. Com lista de projetos vazia: "Nenhum projeto permitido".
3. Sessões em estados diferentes (as que for possível provocar: `trabalhando`, `esperando_mensagem`, `esperando_permissao`, `encerrada`): conferir o selo (texto e forma) e a borda esquerda; só a de permissão em âmbar; resumo "1 esperando permissão"; título da aba "(1) …".
4. Abrir cada cartão e comparar com a matriz do item 5, para comandada e não comandada. Encerrada: Retomar só aparece quando o retrato traz `retomavel: true`.
5. Sessão comandada em `esperando_mensagem`: digitar uma mensagem, esperar 16 s (um ciclo de consulta) e confirmar que o texto e o foco continuam. Tocar "Enviar mensagem": o código do aparelho é pedido na primeira vez. Digitar o código de teste; a mensagem sai sozinha; ver Enviado → Recebido → Executado, texto limpo, foco no campo. Conferir no DevTools (Application → IndexedDB → `moises`) que há só `kid` e uma chave não extraível, e que `localStorage` não tem nada do código.
6. Código de outro aparelho (um código válido que o computador não conhece): o coletor recusa com o motivo `aparelho`; ver o texto do motivo, o botão "Digitar o código de novo" e a mensagem devolvida à caixa.
7. Pedido de permissão com entrada de várias linhas: ver ferramenta, entrada em monoespaçada com as quebras preservadas e rolagem; Negar e Aprovar com andamento. Pedido `sensivel` (por exemplo, ler um arquivo de `~/.config/moises`): o aviso aparece antes dos botões. **[conferir no código]** `completo: false`: só Negar, com o texto "Este pedido não coube inteiro no painel; só é possível negar."; entrada com caractere invisível: aparece como `\u{XXXX}`.
8. Dois pedidos na mesma sessão: dois blocos, cada um responde sozinho.
9. Interromper: confirmação com foco em Cancelar; confirmar e ver o andamento. Encerrar: confirmação com nome, aviso de sessão comandada e de não comandada; ver "Encerrada. Log salvo no Histórico." e o item no Histórico.
10. Sessão encerrada de projeto da lista (`retomavel: true`): Retomar com seus campos; de projeto fora da lista: só a linha explicativa.
11. Motivos de recusa. Fáceis de provocar: `aparelho` (passo 6), `desligado` (passo 2) e `verbo`/`formato` pela API. **[conferir no código]**: `relogio`, `expirado`, `repetido`, `ritmo`, `sem_chave`, `interno`, `falhou` e `expirado` no servidor (um texto por motivo no mapa do item 6; `recusado` e `falhou` com `role="alert"`).
12. Derrubar o coletor por mais de 2 min: banner, botões desabilitados com motivo e "Estado de HH:MM". Religar: tudo volta sem recarregar.
13. Nova sessão: tentar "Revisar" vazio (erros e foco no primeiro inválido); preencher; ver a linha de ajuda sobre sessão isolada no formulário e no resumo, o modo "Perguntar antes de agir" já marcado; "Voltar e editar" preserva valores; "Abrir sessão" fecha, foco no botão, andamento do "abrir" aparece. Com `abertas >= maxSessoes` (suba `maxSessoes` para 1 no coletor de teste e abra uma), botão desabilitado com motivo.
14. Rodapé: "Este aparelho" mostra o `kid` e o rótulo; "Esquecer este aparelho" remove a chave (IndexedDB vazio) e o próximo comando pede o código; "Sair" também esquece.
15. Só com teclado: Tab pelo cartão, diálogos presos no foco, Esc fecha, foco volta ao ponto de origem, Ctrl+Enter envia a mensagem.
16. Leitor de tela (VoiceOver ou TalkBack): chegada de pedido anuncia "<projeto>: pedindo permissão para usar Bash."; andamento anuncia cada mudança uma vez.
17. `prefers-reduced-motion: reduce` (DevTools, Rendering): sem pulso nem reticências animadas.
18. Rolagem horizontal ausente a 320 px, inclusive com entrada de 2.000 caracteres sem espaços.
19. `npm run lint && npm run build`; no console, nenhum erro de CSP nem de Trusted Types; `grep -n innerHTML public/*.js` sem resultado.

## Perguntas em aberto

1. **Enviar mensagem durante `trabalhando`.** Decisão confirmada pelo dono: continua desabilitado. Fica registrada aqui só para não ser reaberta sem motivo.
2. **Aviso de pedido `sensivel`.** A redação do item 4 é minha; vale uma leitura do `seguranca` para ver se o tom (aviso forte, sem botão vermelho) é o certo.
3. **Aparelho guardado que não está em `orquestracao.aparelhos`** (código revogado no computador). A spec só avisa no rodapé; o coletor recusa os comandos com o motivo `aparelho`. Se o dono preferir que o painel esqueça a chave sozinho nesse caso, é uma linha a mais no `app.js`.