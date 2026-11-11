# Contrato da API do painel

Todas as rotas respondem JSON. As do painel exigem o cookie `moises` (definido no login); sem ele respondem `401 {"erro": "..."}`. A rota de ingestão usa `Authorization: Bearer <MOISES_TOKEN>` e só é chamada pelo coletor local.

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
- `retrato` é `null` até o coletor mandar o primeiro.
- `sessoes` vem ordenada por `custo`, do maior para o menor. `sugestao` pode faltar. `modelosSemPreco` lista modelos sem preço na tabela (o custo deles entra como zero).
- Campos da orquestração, preenchidos pelo coletor (o servidor só repassa o retrato; um coletor antigo não os envia, então trate cada um como opcional):
  - Em cada sessão:
    - `estado`: `trabalhando`, `esperando_mensagem`, `esperando_permissao`, `parada` (viva, sem atividade há mais de 15 min) ou `encerrada`. O campo antigo `status` continua valendo.
    - `ultimaResposta` e `ultimaRespostaEm`: o último texto do Claude (mascarado, até 1.200 caracteres) e quando saiu. Ficam `null` com `MOISES_SUBIR_TEXTO=0` ou quando não há resposta ainda.
    - `tarefa` e `tarefaOrigem`: a `tarefa` vem do título, do resumo, do primeiro pedido ou do nome da sessão, nesta ordem; `tarefaOrigem` diz de qual (`titulo`, `resumo`, `pedido`, `nome`) ou é `null` se não houver nenhum.
    - `gerenciada`: a sessão foi aberta ou retomada pelo painel e é conduzida pelo coletor (só ela aceita `mensagem`, `permissao` e `interromper`).
    - `retomavel`: está `encerrada` e a pasta dela está na lista de projetos do coletor (aceita `retomar`).
    - `permissoes`: pedidos de permissão pendentes, `{pedido, ferramenta, entrada, completo, sensivel, criadoEm}`; lista vazia se não houver. `entrada` é o texto mascarado (até 4.000 caracteres, quebras de linha preservadas, caracteres invisíveis trocados por `\u{…}`) e vem vazia com `MOISES_SUBIR_TEXTO=0`. `completo` é falso se o pedido foi cortado, mascarado ou escapado, ou se o nome da ferramenta é estranho: nesse caso só dá para negar. `sensivel` marca pedido que menciona arquivos do Moisés, SSH, variáveis de ambiente, configurações do Claude, hooks do git ou credenciais.
    - `erro`: texto curto (mascarado) quando uma sessão comandada terminou sozinha com falha; fica no retrato por 10 min. `null` nas demais.
  - No topo do retrato, `orquestracao`: `ativa` (falso se o coletor não tem aparelho autorizado ou está com `MOISES_COMANDOS=0`) e `motivo` (`sem_chave`, `desligado` ou `null`); `projetos`, `contas`, `modelos`, `esforcos` e `modos` são as listas que `abrir` aceita; `maxSessoes` e `abertas` são o teto e o número de sessões comandadas vivas; `aparelhos` lista `kid` e `rotulo` dos aparelhos autorizados.
- `recebidoEm` é quando o servidor recebeu o último envio do coletor. Se tiver mais de 2 min, o coletor está parado.
- Cada chamada confere os comandos: o `pendente` com 2 min ou mais desde a chegada ao servidor vira `expirado` na hora (o painel não espera o coletor) e **perde `dados` e `assinatura`** no Redis.
- `comandos` vem do mais recente para o mais antigo. Nunca traz `dados` nem `assinatura`. `estado` segue `pendente` → `recebido` → `feito` | `falhou`, ou `pendente` → `recusado` | `expirado`. `erro` (até 200 caracteres) vem em `falhou` e `recusado`; `motivo` só em `recusado`, quando o coletor informa um motivo válido (ex.: `assinatura` ou `aparelho` pedem o código do aparelho de novo; `expirado` e `relogio` pedem para conferir a hora). `criadoEm` é o relógio do aparelho que assinou.
- Cada chamada grava `moises:painelVistoEm` com a hora do servidor; o coletor recebe esse valor no `ingest`.

## `POST /api/comando`
Transporta um comando assinado no aparelho. O servidor não tem a chave e **não confere a assinatura**: confere só formato e tamanho. Quem aceita ou recusa é o coletor. Exige o cookie e `content-type: application/json`; corpo de até 40.000 bytes.

```json
{ "v": 1, "kid": "ab2cd3", "id": "c_0123456789abcdef", "tipo": "mensagem", "chave": "principal:<uuid>",
  "criadoEm": 1794387000000, "dados": "{\"texto\":\"...\",\"visto\":{\"projeto\":\"x\",\"nome\":\"y\"}}",
  "assinatura": "<43 caracteres base64url>" }
```

| Campo | Regra |
|---|---|
| `v` | número `1` |
| `kid` | `/^[a-z0-9]{6}$/` |
| `id` | `/^c_[0-9a-f]{16}$/`, gerado pelo aparelho |
| `tipo` | `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar` ou `retomar` |
| `chave` | `null` em `abrir`; nos outros, `/^[a-z0-9]{1,20}:<uuid em minúsculas>$/` |
| `criadoEm` | inteiro seguro (relógio do aparelho) |
| `dados` | string com um objeto JSON, até 8.000 caracteres |
| `assinatura` | `/^[A-Za-z0-9_-]{43}$/` |

Campo fora da tabela também dá `400`. O comando expira se o coletor não o buscar em 2 min (contados da chegada ao servidor); ao receber um comando novo, o servidor também expira os pendentes vencidos, para não guardar conteúdo além da validade nem ocupar vaga.

**Assinatura e `dados` (conferidos só pelo coletor).** `assinatura` é o HMAC-SHA256, em base64url sem `=`, de `JSON.stringify(['moises-cmd-v1', kid, id, tipo, chave ?? '', criadoEm, dados])`, com a chave derivada do código do aparelho (PBKDF2-SHA256, 210.000 iterações). O coletor recusa assinatura errada, aparelho desconhecido, comando com mais de 2 min ou com data mais de 30 s no futuro, id repetido, verbo ou versão desconhecidos e mais de 30 comandos por minuto. `dados` é o objeto JSON, em texto, deste verbo (campo fora da tabela é recusado):

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
- `409` se já existe comando com esse `id`; `429` se já há 20 comandos `pendente`; `413` corpo grande demais; `415` corpo não JSON; `401` sem login.

`POST /api/encerrar` saiu: encerrar agora é `POST /api/comando` com `tipo: "encerrar"` e `dados` `{"nome"?, "visto"}`.

## `GET /api/logs?q=texto`
`200 {"logs": [ { "id", "chave", "nome", "projeto", "conta", "tarefa", "resumo", "iniciadaEm", "encerradaEm", "duracaoMs", "modelo", "esforco", "porModelo", "tokens", "custo", "criadoEm" } ]}`, do mais recente para o mais antigo (guarda os 500 mais recentes); `q` filtra por nome, projeto ou resumo.

## `PATCH /api/logs`
Corpo `{"id": "...", "nome": "..."}` → `200 {"ok": true}`; `404` se não existir.

## `POST /api/ingest` (só o coletor)
Corpo `{"retrato": {...} | null, "acks": [...]}` → `200 {"comandos": [{"v", "kid", "id", "tipo", "chave", "criadoEm", "dados", "assinatura", "idadeMs"}], "painelVistoEm": 1794356795887 | null}`.
- `comandos`: os pendentes, no máximo 20, do mais antigo para o mais novo, inteiros como o aparelho assinou. `idadeMs` conta da chegada ao servidor (não do relógio do aparelho). Pendente com 2 min ou mais vira `expirado` e não é entregue.
- `painelVistoEm`: a última vez que o painel chamou `GET /api/estado` (hora do servidor), ou `null`.
- Ack: `{"id", "estado": "recebido" | "feito" | "falhou" | "recusado", "erro", "motivo", "log", "chaveNova"}`. Por compatibilidade, também `{"id", "ok", "erro", "log"}` (`ok: true` vale `feito`; `false`, `falhou`).
  - Qualquer ack de um comando conhecido apaga `dados` e `assinatura` do Redis; a expiração também.
  - O estado só anda para a frente (ack atrasado não desfaz `feito`); um comando `expirado` ainda aceita o ack do coletor.
  - `erro` é cortado em 200 caracteres. `motivo` só é guardado se casar com `/^[a-z_]{1,20}$/`.
  - `chaveNova` (formato de `chave`) vira a `chave` do comando quando o `tipo` é `abrir`.
  - `recebido` há mais de 10 min sem outro ack vira `falhou` com o erro "O coletor não confirmou o resultado.".
  - Comando que já terminou (ou expirou) é apagado do Redis depois de 24 h, na chamada do coletor.
  - O log do Histórico só é gravado em `feito` de `encerrar` com `log`; dele só entram os campos listados em `GET /api/logs`.
