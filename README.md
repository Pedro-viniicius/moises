# moises

Painel pessoal das minhas sessões do Claude Code, para abrir no celular: o que cada sessão está fazendo, quanto gasta, com qual modelo e esforço; encerrar uma sessão pelo site com log nomeado; ideias de próximo passo e recomendação de modelo/esforço.

## Como funciona

```
[coletor local: collector/]  lê ~/.claude*/sessions e ~/.claude*/projects (transcripts + subagentes)
        │  POST /api/ingest a cada 20 s (só metadados; texto livre passa por redigir.js)
        ▼
[Vercel: api/ + public/]  ←→  Upstash Redis (retrato, pedidos, logs)
        ▲
   eu no celular (login por senha)
```

- **Nada de código, prompt, segredo ou variável de ambiente sai da máquina.** Sobem: nome da pasta do projeto, título e resumo gerados pelo Claude (com segredos, e-mails e telefones mascarados), status, horários, modelo, esforço, tokens e custo.
- **Custo** é estimado em preço de API (`collector/precos.js`), contando cada resposta uma vez — inclusive quando uma sessão retomada copia o histórico de outra: a resposta fica com a sessão de origem — e somando os subagentes. Quando a sessão tem o `cost-state` oficial do Claude Code, ele corrige o total (inclui chamadas que não vão para o transcript). Valores sem essa conferência aparecem com "≈".
- **Status**: `busy`/`shell` → ativa; `idle` há menos de 15 min → aguardando você; mais de 15 min → ociosa; processo morto → encerrada.
- **Encerrar** grava um pedido; o coletor só manda `SIGTERM` se pid, `sessionId`, início do processo (`procStart`, obrigatório) e executável do Claude Code baterem, e o pedido expira em 2 min. Limites locais, que o site não consegue mudar: no máximo 5 encerramentos por hora (`MOISES_ENCERRAR_POR_HORA`), pedido repetido é ignorado e `MOISES_ENCERRAR=0` desliga a função. Depois grava o log (nome editável, resumo, duração, modelo, custo) no Histórico, que guarda os 500 mais recentes.
- **Ideias e recomendação** (v3): o coletor chama `claude -p --model haiku` com contexto mínimo (~US$ 0,0002 por chamada), só para sessões abertas, só quando título/resumo mudam e no máximo a cada 10 min por sessão (teto de 80/dia). A recomendação de modelo/esforço sai de regras fixas em `collector/ideias.js`. O gasto aparece no painel.

## Uso

```bash
npm test                      # testes do coletor e da API
PORT=3800 node scripts/dev.js # painel local com Redis em memória (sem Vercel)
npm run retrato               # imprime o retrato atual, sem enviar
node scripts/configurar.js https://<painel>.vercel.app   # gera senha, token e segredos em ~/.config/moises/
systemctl --user enable --now moises-coletor              # depois de copiar collector/systemd/ para ~/.config/systemd/user/
journalctl --user -u moises-coletor -f
```

Rodar `configurar.js` de novo gera **outro** `MOISES_TOKEN` e `SESSION_SECRET` (a senha é mantida): é preciso atualizar as variáveis na Vercel e publicar de novo.

Onde ficam os dados: Vercel (função em `iad1`) e Upstash Redis (região `iad1`, EUA). Sobem só metadados e resumos com segredos, e-mails, telefones, CPF e CNPJ mascarados; o retrato é sobrescrito a cada envio e os logs ficam até sair dos 500 mais recentes. O deploy é pela CLI (`vercel deploy --prod`): o repositório não está ligado à Vercel.

Variáveis na Vercel: `PANEL_PASSWORD_HASH`, `SESSION_SECRET`, `MOISES_TOKEN` (de `~/.config/moises/vercel.env`) e `KV_REST_API_URL`/`KV_REST_API_TOKEN` (da integração Upstash). A senha do painel fica em `~/.config/moises/senha-painel.txt`.

Contrato da API: [`docs/api.md`](docs/api.md). Plano e decisões: [`docs/plano.md`](docs/plano.md).
