# Perguntas e suposições

Dúvidas que não impediram o trabalho. Em cada uma segui a suposição mais conservadora (regra 10 do briefing). Corrija o que estiver errado.

| # | Dúvida | Suposição adotada |
|---|---|---|
| P1 | O `CLAUDE.md` manda mostrar o plano e esperar aprovação antes de implementar; o briefing manda não parar para perguntar. | Vale o pedido mais recente e específico (o `/goal` e a regra 10): segui sem parar. Plano, ADR e esta lista ficam para você conferir depois; nada saiu da máquina. |
| P2 | O briefing estava em `docs/BRIEFING.md`, não em `docs/orquestracao/`. | Movi para `docs/orquestracao/BRIEFING.md`, como o próprio arquivo pede, e ele entrou no ramo `feat/orquestracao`. A pasta principal ficou limpa. |
| P3 | O coletor de produção roda da pasta do repositório. | Não troquei o ramo dali: o trabalho está no worktree `.claude/worktrees/orquestracao`. A linha `.claude/worktrees/` foi para `.git/info/exclude` (arquivo local, sem commit em `main`). |
| P4 | O projeto não tem lint nem build, e a condição pede que os dois terminem com código 0. | Criei `npm run lint` (checagem de sintaxe de todos os `.js` com `node --check`) e `npm run build` (confere `vercel.json` e que cada rota de `api/` carrega e exporta uma função). Sem dependência nova. |
| P5 | Quais modos de permissão o painel pode pedir? | `manual`, `acceptEdits` e `plan`. `bypassPermissions` nunca. `auto` e `dontAsk` ficam de fora por padrão; `auto` só entra se você ligar num arquivo da máquina. |
| P6 | O Encerrar que já existe também passa a exigir a assinatura? | Sim: a regra 6 diz "todo comando". Depois de publicar, o aparelho precisa do código de comandos até para encerrar. |
| P7 | O que é "parada"? | Sessão viva sem atividade há mais de 15 min (a "ociosa" de hoje). "Encerrada" é a que não tem processo. |
| P8 | Como preencher a tarefa? | Título dado pelo Claude, senão o resumo, senão o primeiro pedido, senão o nome da sessão. O campo editável no painel ficou em `IDEIAS.md`. |
| P9 | A última resposta e o pedido de permissão passam a sair da máquina. | Passam, mascarados por `redigir.js` e cortados (resposta em 1.200 caracteres, pedido de permissão em 2.000), porque o MVP pede para vê-los no painel. O `README.md` foi atualizado para dizer isso. |
| P10 | Projetos permitidos: onde fica a lista? | Em `~/.config/moises/projetos.json`, na máquina. Sem o arquivo, nenhum projeto pode ser aberto pelo painel. Você cria o arquivo; eu não li nem escrevi em `~/.config/moises/`. |
| P11 | Sessões de teste aparecem no painel publicado? | Sim, enquanto existirem: o coletor de produção lê todas as sessões da máquina. Somem do retrato no dia seguinte ao de serem apagadas. Não alterei nada no painel de produção. |
| P12 | O teste de `CLAUDE_CONFIG_DIR=~/.claude` criou `~/.claude/.claude.json`. | Apaguei o arquivo logo depois (ele não existia antes). `~/.claude.json` não foi tocado. |
| P13 | Aceitei o diálogo de confiança do Claude Code para `~/moises-sandbox`. | Necessário para testar `claude --bg`. A entrada é removida no fim com `claude purge ~/moises-sandbox`. |
| P14 | `tmux` não está instalado. | Não instalei; o caminho C ficou sem teste real e a ADR diz isso. |
| P15 | Retomar sessão aberta à mão: vale para qualquer pasta? | Só se a pasta da sessão estiver na lista de projetos permitidos e a sessão não tiver processo vivo. |
