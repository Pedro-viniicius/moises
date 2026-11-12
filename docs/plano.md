# Plano

## Decisões
- **ADR-1 Coletor local + site na Vercel.** A Vercel não vê a máquina: o coletor envia o retrato e, na mesma resposta, recebe os pedidos de encerrar.
- **ADR-2 Custo calculado no coletor.** O transcript não sai da máquina; a tabela de preços foi conferida contra o `cost-state` do Claude Code.
- **ADR-3 Upstash Redis em vez de Postgres.** Um usuário, dados pequenos (um retrato, poucos pedidos, logs): chave-valor basta, cobra por comando e não tem limite de horas de computação. Envio a cada 20 s (≈130 mil por mês); com sessão ativa o retrato muda quase todo ciclo (SET + HGETALL), mais o painel aberto lendo a cada 15 s: ~400 a 450 mil comandos/mês no pior caso, perto do limite grátis de 500 mil. Se encostar, subir o intervalo para 30 s (`MOISES_INTERVALO_MS`).
- **ADR-4 Site sem framework.** HTML/JS estático + funções `api/*.js`, sem build e sem dependências.
- **ADR-5 Senha única.** Hash scrypt em variável de ambiente, cookie HttpOnly/Secure/SameSite=Strict assinado (30 dias), 5 tentativas por IP a cada 15 min, contadas antes de conferir. Sem trava global: qualquer um conseguiria trancar o dono, e a senha gerada (~79 bits) já torna a força bruta inviável.
- **ADR-6 Encerrar com conferência tripla e expiração de 2 min.** Só o meu clique cria o pedido. Limites locais (5 por hora, sem repetir pedido, chave para desligar) contêm o estrago se o Redis ou a Vercel forem comprometidos.
- **ADR-7 Ideias com Haiku isolado.** `--strict-mcp-config --disable-slash-commands --setting-sources "" --system-prompt … --tools ""` derruba o custo de US$ 0,38 para US$ 0,0001 por chamada.

- **ADR-8 Orquestração de sessões.** Abrir, conversar, aprovar permissão, interromper, encerrar e retomar pelo painel, com comandos assinados no aparelho e conferidos no coletor. Essa decisão amplia as ADR-1 e ADR-6: o coletor passa a receber comandos de vários verbos (não só encerrar), e o Encerrar também exige assinatura. Decisão, comparação dos caminhos e riscos em [`docs/orquestracao/ADR-001-orquestracao.md`](orquestracao/ADR-001-orquestracao.md); plano de implementação em [`docs/orquestracao/PLANO.md`](orquestracao/PLANO.md).

## Entregas
- v1: sessões, gasto, modelo e esforço.
- v2: encerrar e histórico de logs.
- v3: ideias e recomendação de modelo/esforço.
- v4: orquestração de sessões (ADR-8; plano em [`docs/orquestracao/PLANO.md`](orquestracao/PLANO.md)).

## Riscos
| Risco | Mitigação |
|---|---|
| Formato do transcript muda | Parser tolerante; linha ruim é contada e ignorada |
| Custo subestimado em sessões abertas (~5%: títulos, resumos, compactação não vão ao transcript) | Corrigido pelo `cost-state` quando existe; marcado com "≈" |
| Encerrar o processo errado | ADR-6 |
| Vazar segredo num resumo | `collector/redigir.js` + teste |
| Comando forjado por quem controla o Redis, o cookie ou o token; texto de sessão sem cifra na Vercel e no Upstash | ADR-8: assinatura por aparelho, limites locais e `MOISES_SUBIR_TEXTO=0`; riscos que restam em [`docs/orquestracao/ACHADOS.md`](orquestracao/ACHADOS.md) |
