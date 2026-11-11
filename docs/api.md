# Contrato da API do painel

Todas as rotas respondem JSON. As do painel exigem o cookie `moises` (definido no login); sem ele respondem `401 {"erro": "..."}`. A rota de ingestão usa `Authorization: Bearer <MOISES_TOKEN>` e só é chamada pelo coletor local. As rotas de comandos (`/api/comando`) e de pedido de autorização de aparelho (`/api/aparelho`) só transportam: quem confere assinatura e autoriza aparelho é o coletor, no computador.

Horários são milissegundos desde a época (UTC); o painel mostra em `America/Sao_Paulo`. Custos em US$ (estimativa em preço de API).

## `POST /api/login`
Corpo `{"senha": "..."}`.
- `200 {"ok": true}` e grava o cookie (HttpOnly, Secure, SameSite=Strict, 30 dias).
- `401 {"erro": "Senha incorreta."}`
- `429 {"erro": "...", "tenteEmS": 900}` depois de 5 tentativas do mesmo IP em 15 min.
- `415` se o corpo não for JSON.

## `POST /api/logout`
`200 {"ok": true}` e apaga o cookie.

## `GET /api/estado`
```json
{
  "recebidoEm": 1794356795887,
  "retrato": {
    "geradoEm": 1794356795000,
    "dia": "2026-11-10",
    "totalDia": 442.84,
    "porModeloDia": { "claude-opus-5-5": { "custo": 300.1, "tokens": 123456 } },
    "custoIdeiasHoje": 0.03,
    "orquestracao": {
      "ativa": true,
      "motivo": null,
      "projetos": ["moises"],
      "contas": ["principal"],
      "modelos": ["haiku", "sonnet", "opus", "fable"],
      "esforcos": ["low", "medium", "high", "xhigh", "max"],
      "modos": ["manual", "acceptEdits", "plan"],
      "maxSessoes": 4,
      "abertas": 1,
      "aparelhos": [{ "kid": "ab2cd3", "rotulo": "Celular" }]
    },
    "sessoes": [
      {
        "chave": "principal:4e00abb1-…",
        "sessionId": "4e00abb1-…",
        "conta": "principal",
        "projeto": "achadinho_turbo",
        "nome": "10_11",
        "tarefa": "Dashboard de sessões do Claude Code",
        "tarefaOrigem": "titulo | resumo | pedido | nome | null",
        "resumo": "Frase de resumo do que a sessão fez (pode ser null)",
        "status": "ativa | aguardando | ociosa | encerrada",
        "estado": "trabalhando | esperando_mensagem | esperando_permissao | parada | encerrada",
        "ultimaResposta": "Último texto do Claude, mascarado e cortado em 1.200 caracteres (null sem texto)",
        "ultimaRespostaEm": 1794356790000,
        "gerenciada": false,
        "retomavel": false,
        "permissoes": [],
        "erro": null,
        "tipo": "interactive | bg",
        "iniciadaEm": 1794337403667,
        "ultimaAtividade": 1794356795887,
        "modelo": "claude-opus-5-5",
        "esforco": "high",
        "custo": 45.04,
        "custoHoje": 29.35,
        "custoConferido": false,
        "tokens": { "input": 0, "output": 0, "read": 0, "w5m": 0, "w1h": 0 },
        "porModelo": { "claude-opus-5-5": { "custo": 40.1, "tokens": 999 } },
        "sugestao": {
          "ideias": ["…", "…"],
          "recomendacao": { "adequado": false, "modelo": "claude-sonnet-5-5", "esforco": "medium", "motivo": "Tarefa mecânica em modelo caro." },
          "geradaEm": 1794356795887
        }
      }
    ]
  },
  "comandos": [
    { "id": "c_…", "tipo": "encerrar", "chave": "principal:…", "estado": "pendente | recebido | feito | falhou | recusado | expirado", "erro": null, "motivo": null, "criadoEm": 1794356795887 }
  ]
}
```
- `retrato` é `null` até o coletor mandar o primeiro, e volta a ser `null` se o coletor ficar 24 h sem mandar outro: o Redis o guarda com validade de 24 h, renovada a cada envio.
- `sessoes` vem ordenada por `custo`, do maior para o menor. `sugestao` pode faltar. `modelosSemPreco` lista modelos sem preço na tabela (o custo deles entra como zero).
- Campos da orquestração, preenchidos pelo coletor (o servidor só repassa o retrato; um coletor antigo não os envia, então trate cada um como opcional):
  - Em cada sessão:
    - Texto de conversa (`ultimaResposta`, `ultimaRespostaEm` e a `tarefa` tirada do primeiro pedido) só vem de sessão `gerenciada`. Na aberta à mão, `ultimaResposta` e `ultimaRespostaEm` são `null` e a `tarefa` que viria do pedido cai para o nome (`tarefaOrigem: "nome"`, ou `null` sem nome).
    - `estado`: `trabalhando`, `esperando_mensagem`, `esperando_permissao`, `parada` (viva, sem atividade há mais de 15 min) ou `encerrada`. O campo antigo `status` continua valendo.
    - `ultimaResposta` e `ultimaRespostaEm`: o último texto do Claude (mascarado, até 1.200 caracteres) e quando saiu. Ficam `null` com `MOISES_SUBIR_TEXTO=0` ou quando não há resposta ainda.
    - `tarefa` e `tarefaOrigem`: a `tarefa` vem do título, do resumo, do primeiro pedido ou do nome da sessão, nesta ordem; `tarefaOrigem` diz de qual (`titulo`, `resumo`, `pedido`, `nome`) ou é `null` se não houver nenhum.
    - `gerenciada`: a sessão foi aberta ou retomada pelo painel e é conduzida pelo coletor (só ela aceita `mensagem`, `permissao` e `interromper`).
    - `retomavel`: está `encerrada` e a pasta dela está na lista de projetos do coletor (aceita `retomar`).
    - `permissoes`: pedidos de permissão pendentes, `{pedido, ferramenta, entrada, completo, sensivel, criadoEm}`; lista vazia se não houver. `entrada` é o texto mascarado (até 4.000 caracteres, quebras de linha preservadas, caracteres invisíveis trocados por `\u{…}`) e vem vazia com `MOISES_SUBIR_TEXTO=0`. `completo` é falso se o pedido foi cortado, mascarado ou escapado, ou se o nome da ferramenta é estranho: nesse caso só dá para negar. `sensivel` marca pedido que menciona arquivos do Moisés (inclusive a pasta do coletor e as pastas de chaves, projetos e estado), SSH, o systemd do usuário, variáveis de ambiente, configurações do Claude, hooks do git ou credenciais, ou comando `Bash` com letra fora de ASCII ou jeito de ofuscar (`$(`, crase, `eval`, `base64`, `/proc/`, `environ`, interpretador com `-c`/`-e`); é heurística: só dá para negar pelo painel.
    - `erro`: texto curto (mascarado) quando uma sessão comandada terminou sozinha com falha; fica no retrato por 10 min. `null` nas demais.
  - No topo do retrato, `orquestracao`: `ativa` (falso se o coletor não tem aparelho autorizado, está com `MOISES_COMANDOS=0` ou achou o painel publicado diferente do `public/` do computador) e `motivo` (`sem_chave`, `desligado`, `painel_alterado` ou `null`); `projetos`, `contas`, `modelos`, `esforcos` e `modos` são as listas que `abrir` aceita; `maxSessoes` e `abertas` são o teto e o número de sessões comandadas vivas; `aparelhos` lista `kid` e `rotulo` dos aparelhos autorizados no computador (só os de chave pública; aparelho do formato antigo não aparece). O servidor só aceita comando de um `kid` desta lista (ver `POST /api/comando`).
- `recebidoEm` é quando o servidor recebeu o último envio do coletor. Se tiver mais de 2 min, o coletor está parado.
- Cada chamada confere os comandos: o `pendente` com 2 min ou mais desde a chegada ao servidor vira `expirado` na hora (o painel não espera o coletor) e **perde `dados` e `assinatura`** no Redis. Se o coletor confirmar o comando ao mesmo tempo, a confirmação prevalece sobre o `expirado` (ver "Comandos no Redis").
- `comandos` vem do mais recente para o mais antigo. Nunca traz `dados` nem `assinatura`. `estado` segue `pendente` → `recebido` → `feito` | `falhou`, ou `pendente` → `recusado` | `expirado`. `erro` (até 200 caracteres) vem em `falhou` e `recusado`; `motivo` só em `recusado`, quando o coletor informa um motivo válido (`/^[a-z_]{1,20}$/`). Os que o coletor usa: `assinatura` e `aparelho` (a chave não confere ou o aparelho não está autorizado: pedem nova autorização do aparelho), `expirado`, `relogio` (relógio do aparelho **adiantado** ou **atrasado**: o `erro` diz qual; os dois pedem para acertar a hora), `repetido`, `ritmo`, `desligado`, `sem_chave`, `formato`, `verbo`, `interno` e `painel_alterado` (o painel publicado não é igual ao `public/` do computador; os comandos ficam desligados até a próxima conferência, a cada 10 min). `criadoEm` é o relógio do aparelho que assinou.
- A chamada grava `moises:painelVistoEm` com a hora do servidor, **no máximo a cada 30 s** (se o valor guardado tem menos de 30 s, não é regravado; no futuro ou que não é número, é); o coletor recebe esse valor no `ingest` e acelera o envio quando ele tem menos de 60 s.

## `POST /api/comando`
Transporta um comando assinado no aparelho. O servidor não tem a chave e **não confere a assinatura**: confere só formato e tamanho. Quem aceita ou recusa é o coletor. Exige o cookie e `content-type: application/json`; corpo de até 40.000 bytes.

```json
{ "v": 1, "kid": "ab2cd3", "id": "c_0123456789abcdef", "tipo": "mensagem", "chave": "principal:<uuid>",
  "criadoEm": 1794387000000, "dados": "{\"texto\":\"...\",\"visto\":{\"projeto\":\"x\",\"nome\":\"y\"}}",
  "assinatura": "<86 caracteres base64url>" }
```

| Campo | Regra |
|---|---|
| `v` | número `1` |
| `kid` | `/^[0-9a-f]{6}$/` (os 6 primeiros hexadecimais do SHA-256 da chave pública, como em `POST /api/aparelho`) |
| `id` | `/^c_[0-9a-f]{16}$/`, gerado pelo aparelho |
| `tipo` | `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar` ou `retomar` |
| `chave` | `null` em `abrir`; nos outros, `/^[a-z0-9]{1,20}:<uuid em minúsculas>$/` |
| `criadoEm` | inteiro seguro (relógio do aparelho) |
| `dados` | string com um objeto JSON, até 8.000 caracteres |
| `assinatura` | `/^[A-Za-z0-9_-]{86}$/` (ECDSA P-256 em IEEE P1363, 64 bytes) |

Campo fora da tabela também dá `400`. Depois do formato, o servidor confere só se o coletor anunciou o aparelho: o `kid` tem de estar em `retrato.orquestracao.aparelhos` do último retrato. O comando expira se o coletor não o buscar em 2 min (contados da chegada ao servidor); ao receber um comando novo, o servidor também expira os pendentes vencidos, para não guardar conteúdo além da validade nem ocupar vaga.

**Assinatura e `dados` (conferidos só pelo coletor).** `assinatura` é a assinatura ECDSA P-256 com SHA-256, no formato IEEE P1363 (`r || s`, 64 bytes) em base64url sem `=` (86 caracteres), de `JSON.stringify(['moises-cmd-v1', kid, id, tipo, chave ?? '', criadoEm, dados])`. A chave privada nasce no navegador do aparelho, não é extraível e nunca sai dele; o coletor confere com a chave pública que o dono autorizou no computador (`POST /api/aparelho` e `scripts/configurar-comandos.js`). O `kid` é a identificação do aparelho: os 6 primeiros hexadecimais do SHA-256 da chave pública. O servidor já recusa (`400`, campo `assinatura`) a HMAC de 43 caracteres do formato antigo. O coletor recusa assinatura errada, aparelho desconhecido, comando com mais de 2 min ou com data mais de 30 s no futuro, id repetido, verbo ou versão desconhecidos e mais de 30 comandos por minuto. `dados` é o objeto JSON, em texto, deste verbo (campo fora da tabela é recusado):

| Verbo | `dados` |
|---|---|
| `abrir` | `projeto` (nome na lista local), `pedido` (1 a 6.000 caracteres); opcionais: `conta` (padrão `principal`), `modelo` (`haiku`, `sonnet`, `opus`, `fable`), `esforco` (`low`, `medium`, `high`, `xhigh`, `max`), `modoPermissao` (`manual`, `acceptEdits`, `plan`; padrão `manual`), `worktree` (booleano), `nome` (`/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/`) |
| `mensagem` | `texto` (1 a 6.000 caracteres), `visto` |
| `permissao` | `pedido` (id do pedido), `decisao` (`aprovar` ou `negar`), `vistoHash` (SHA-256 em hexadecimal de `ferramenta + "\n" + entrada`; obrigatório em `aprovar`), `visto` |
| `interromper` | `visto` |
| `encerrar` | `nome` (opcional, até 140 caracteres, vira o nome do log), `visto` |
| `retomar` | `modoPermissao`, `modelo`, `esforco` (todos opcionais), `visto` |

`visto` é `{"projeto": "...", "nome": "..." | null}`: o que o cartão mostrava quando você tocou. O coletor recusa se a sessão real for outra.
- `200 {"id": "c_…"}`
- `400 {"erro": "Comando inválido (<campo>)."}`: a mensagem cita só o nome do campo, nunca o conteúdo.
- `403 {"erro": "Este aparelho não está autorizado neste computador."}` se o `kid` não está nos aparelhos que o coletor anunciou (inclusive quando o último retrato é de um coletor antigo, sem a lista).
- `503 {"erro": "O coletor ainda não mandou o estado deste computador. Tente de novo em instantes."}` se não há retrato legível no Redis (coletor nunca enviou, ou parado há mais de 24 h): sem ele o servidor não sabe quais aparelhos existem.
- `409` se já existe comando com esse `id`; `429` se já há 20 comandos `pendente`; `413` corpo grande demais; `415` corpo não JSON; `401` sem login.

`POST /api/encerrar` saiu: encerrar agora é `POST /api/comando` com `tipo: "encerrar"` e `dados` `{"nome"?, "visto"}`.

## `POST /api/aparelho`
Pedido de autorização de um aparelho novo. O navegador gerou um par ECDSA P-256 com a chave privada não extraível e manda só a chave pública, o `kid` e um nome. **Nada aqui autoriza coisa alguma**: o servidor guarda o pedido e o ingest o entrega ao coletor, que o grava no computador; quem autoriza é o dono, no terminal, conferindo a impressão digital (`node scripts/configurar-comandos.js --pedidos` e `--autorizar <kid> <impressão>`). Exige o cookie e `content-type: application/json`; corpo de até 2.000 bytes.

```json
{ "kid": "a1b2c3", "publica": "<87 caracteres base64url>", "rotulo": "Celular" }
```

| Campo | Regra |
|---|---|
| `kid` | `/^[0-9a-f]{6}$/` e igual aos 6 primeiros hexadecimais do SHA-256 da chave pública `raw` |
| `publica` | chave pública P-256 `raw` (65 bytes: `0x04`, x e y) em base64url canônico, sem `=`, 87 caracteres, com o ponto na curva |
| `rotulo` | de 1 a 40 caracteres (contados por caractere, depois de `trim`), sem controle, formatação, separador de linha ou de parágrafo |

Campo fora da tabela também dá `400`.
- `200 {"kid": "a1b2c3"}`: o pedido foi guardado.
- `400 {"erro": "Pedido de autorização inválido (<campo>)."}`: a mensagem cita só o nome do campo (`corpo`, `campo desconhecido`, `publica`, `kid` ou `rotulo`), nunca o conteúdo.
- `429` se já há 5 pedidos de **outros** aparelhos esperando. O mesmo aparelho (mesmo `kid`) pedindo de novo substitui o próprio pedido e não ocupa vaga.
- `415` corpo não JSON; `413` corpo grande demais; `401` sem login; `405` outro método.

Os pedidos ficam no hash do Redis `moises:aparelhos-pedidos` (um campo por `kid`), **no máximo 5 e cada um por 1 h**: os vencidos são apagados nas chamadas seguintes (deste endpoint e do ingest). O servidor não confere se o aparelho é seu; o coletor e o script conferem tudo de novo (o `kid` ser o da própria chave, o ponto na curva e o nome) antes de mostrar o pedido, e a impressão digital exigida em `--autorizar` é o que prende a chave gravada à que o aparelho mostra.

## `GET /api/logs?q=texto`
`200 {"logs": [ { "id", "chave", "nome", "projeto", "conta", "tarefa", "resumo", "iniciadaEm", "encerradaEm", "duracaoMs", "modelo", "esforco", "porModelo", "tokens", "custo", "criadoEm" } ]}`, do mais recente para o mais antigo (guarda os 500 mais recentes); `q` filtra por nome, projeto ou resumo.

## `PATCH /api/logs`
Corpo `{"id": "...", "nome": "..."}` → `200 {"ok": true}`; `404` se não existir.

## `POST /api/ingest` (só o coletor)
Corpo `{"protocolo": 2, "retrato": {...} | null, "acks": [...]}` → `200 {"comandos": [{"v", "kid", "id", "tipo", "chave", "criadoEm", "dados", "assinatura", "idadeMs"}], "painelVistoEm": 1794356795887 | null, "aparelhosPedidos": [{"kid", "publica", "rotulo", "criadoEm"}]}`.
- Corpo JSON que não é objeto (`null`, número, lista, texto) → `400 {"erro": "Corpo inválido."}`, sem gravar nada.
- `protocolo`: só o coletor que confere assinatura manda `2`. **Sem `protocolo: 2`, o servidor não entrega comando nenhum** (`comandos: []`, e também sem `aparelhosPedidos`): um coletor antigo executaria `encerrar` sem conferir assinatura. Os comandos pendentes continuam guardados até expirar ou até um coletor novo buscar.
- `retrato`: guardado em `moises:retrato` com validade de 24 h (`EX`), renovada a cada retrato recebido.
- `comandos`: os pendentes, no máximo 20, do mais antigo para o mais novo, inteiros como o aparelho assinou. `idadeMs` conta da chegada ao servidor (não do relógio do aparelho). Pendente com 2 min ou mais vira `expirado` e não é entregue.
- `painelVistoEm`: a última vez que o painel chamou `GET /api/estado` (hora do servidor, com precisão de 30 s: ele só é regravado a cada 30 s), ou `null`.
- `aparelhosPedidos`: os pedidos de autorização de aparelho de `POST /api/aparelho` ainda dentro de 1 h, do mais antigo para o mais novo. O coletor confere cada um de novo (o servidor não é confiável) e grava os válidos, no máximo 5, em `aparelhos-pedidos.json` (600) na pasta de estado, para `--pedidos` listar. Os pedidos vencidos são apagados do Redis nesta chamada.
- Ack: `{"id", "estado": "recebido" | "feito" | "falhou" | "recusado", "erro", "motivo", "log", "chaveNova"}`. Por compatibilidade, também `{"id", "ok", "erro", "log"}` (`ok: true` vale `feito`; `false`, `falhou`).
  - Qualquer ack de um comando conhecido apaga `dados` e `assinatura` do Redis; a expiração também.
  - O estado só anda para a frente (ack atrasado não desfaz `feito`), mesmo com duas chamadas ao mesmo tempo (ver "Comandos no Redis"); um comando `expirado` ainda aceita o ack do coletor.
  - `erro` é cortado em 200 caracteres. `motivo` só é guardado se casar com `/^[a-z_]{1,20}$/`.
  - `chaveNova` (formato de `chave`) vira a `chave` do comando quando o `tipo` é `abrir`.
  - `recebido` há mais de 10 min sem outro ack vira `falhou` com o erro "O coletor não confirmou o resultado.".
  - Comando que já terminou (ou expirou) é apagado do Redis depois de 24 h, na chamada do coletor, junto com o recebido e o resultado dele.
  - O log do Histórico só é gravado em `feito` de `encerrar` com `log`, e uma vez só: um `feito` repetido não desfaz o nome editado em `PATCH /api/logs`. Dele só entram os campos listados em `GET /api/logs`.

## Comandos no Redis
O coletor pode reenviar um `ingest` (desistiu por tempo limite) enquanto o primeiro ainda roda, e o painel pode expirar um comando enquanto o coletor o confirma. Para o estado **só avançar**, cada etapa é gravada uma vez, de forma atômica, numa chave própria, e nenhuma gravação desfaz outra:

| Chave (hash, campo = `id`) | Valor | Gravado por |
|---|---|---|
| `moises:cmds` | o comando como o aparelho mandou, com `estado` `pendente` ou `expirado` e `recebidoNoServidorEm` | `POST /api/comando` (`HSETNX`); depois só é regravado **sem** `dados` e `assinatura` (ack ou expiração) |
| `moises:cmds-rec` | hora (ms) em que o coletor confirmou o recebimento | `HSETNX` no primeiro ack `recebido` |
| `moises:cmds-fim` | JSON `{estado, erro, motivo, feitoEm, chaveNova?}`, `estado` `feito`, `falhou` ou `recusado` | `HSETNX` no primeiro ack final, ou no `falhou` de "O coletor não confirmou o resultado." |

- Estado mostrado: o de `moises:cmds-fim` se existir; senão `recebido` se existir `moises:cmds-rec` (mesmo que o objeto diga `expirado`); senão o do objeto (`pendente` ou `expirado`). O primeiro resultado final vale: se o `feito` do coletor e o `falhou` do tempo limite chegarem juntos, fica o que gravou primeiro.
- Só é entregue ao coletor como pendente o comando sem `moises:cmds-rec` e sem `moises:cmds-fim`, e `POST /api/comando` só conta esses no limite de 20 (e dá `409` para um `id` que já tem registro em qualquer das três chaves).
- Uma chamada atrasada que leu o comando ainda com o conteúdo não consegue devolvê-lo: toda regravação do objeto tira `dados` e `assinatura`.
- Compatibilidade: comandos gravados antes destas chaves (o estado ficava no próprio objeto) continuam aparecendo com o estado do objeto e ainda aceitam o resultado do coletor.
- Registro em `moises:cmds-rec` ou `moises:cmds-fim` que sobrou sem comando é apagado depois de 24 h.
