# Plano

## Decisões
- **ADR-1 Coletor local + site na Vercel.** A Vercel não vê a máquina: o coletor envia o retrato e, na mesma resposta, recebe os pedidos de encerrar.
- **ADR-2 Custo calculado no coletor.** O transcript não sai da máquina; a tabela de preços foi conferida contra o `cost-state` do Claude Code.
- **ADR-3 Upstash Redis em vez de Postgres.** Um usuário, dados pequenos (um retrato, poucos pedidos, logs): chave-valor basta, cobra por comando e não tem limite de horas de computação. Envio a cada 20 s com retrato só quando muda → ~260 mil comandos/mês, dentro do plano grátis.
- **ADR-4 Site sem framework.** HTML/JS estático + funções `api/*.js`, sem build e sem dependências.
- **ADR-5 Senha única.** Hash scrypt em variável de ambiente, cookie HttpOnly/Secure/SameSite=Strict assinado (30 dias), 5 erros por IP e 30 no total a cada 15 min.
- **ADR-6 Encerrar com conferência tripla e expiração de 2 min.** Só o meu clique cria o pedido.
- **ADR-7 Ideias com Haiku isolado.** `--strict-mcp-config --disable-slash-commands --setting-sources "" --system-prompt … --tools ""` derruba o custo de US$ 0,38 para US$ 0,0001 por chamada.

## Entregas
- v1: sessões, gasto, modelo e esforço.
- v2: encerrar e histórico de logs.
- v3: ideias e recomendação de modelo/esforço.

## Riscos
| Risco | Mitigação |
|---|---|
| Formato do transcript muda | Parser tolerante; linha ruim é contada e ignorada |
| Custo subestimado em sessões abertas (~5%: títulos, resumos, compactação não vão ao transcript) | Corrigido pelo `cost-state` quando existe; marcado com "≈" |
| Encerrar o processo errado | ADR-6 |
| Vazar segredo num resumo | `collector/redigir.js` + teste |
