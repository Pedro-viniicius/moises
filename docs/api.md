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
    "sessoes": [
      {
        "chave": "principal:4e00abb1-…",
        "sessionId": "4e00abb1-…",
        "conta": "principal",
        "projeto": "achadinho_turbo",
        "nome": "10_11",
        "tarefa": "Dashboard de sessões do Claude Code",
        "resumo": "Frase de resumo do que a sessão fez (pode ser null)",
        "status": "ativa | aguardando | ociosa | encerrada",
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
    { "id": "c_…", "chave": "principal:…", "nome": "…", "estado": "pendente | feito | falhou | expirado", "erro": null, "criadoEm": 1794356795887 }
  ]
}
```
- `retrato` é `null` até o coletor mandar o primeiro.
- `sessoes` vem ordenada por `custo`, do maior para o menor. `sugestao` pode faltar. `modelosSemPreco` lista modelos sem preço na tabela (o custo deles entra como zero).
- `recebidoEm` é quando o servidor recebeu o último envio do coletor. Se tiver mais de 2 min, o coletor está parado.

## `POST /api/encerrar`
Corpo `{"chave": "...", "nome": "AAAA-MM-DD projeto – resumo"}`. Cria um pedido que o coletor executa em até ~20 s; o pedido expira em 2 min.
- `200 {"id": "c_…"}`
- `400` sem `chave`; `415` corpo não JSON; `404` sessão não está no retrato; `409` sessão já encerrada ou com pedido pendente. O `nome` é cortado em 140 caracteres.

## `GET /api/logs?q=texto`
`200 {"logs": [ { "id", "chave", "nome", "projeto", "conta", "tarefa", "resumo", "iniciadaEm", "encerradaEm", "duracaoMs", "modelo", "esforco", "porModelo", "tokens", "custo", "criadoEm" } ]}`, do mais recente para o mais antigo (guarda os 500 mais recentes); `q` filtra por nome, projeto ou resumo.

## `PATCH /api/logs`
Corpo `{"id": "...", "nome": "..."}` → `200 {"ok": true}`; `404` se não existir.

## `POST /api/ingest` (só o coletor)
Corpo `{"retrato": {...} | null, "acks": [{"id", "ok", "erro", "log"}]}` → `200 {"comandos": [{"id", "tipo": "encerrar", "chave", "nome", "idadeMs"}]}` com os pedidos pendentes. Do `log` de cada ack só são gravados os campos listados em `GET /api/logs`.
