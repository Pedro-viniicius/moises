# Briefing: orquestração de sessões no Moisés

Este arquivo é o contexto do objetivo definido com `/goal`. Leia inteiro antes de começar.
Salvar em: `docs/orquestracao/BRIEFING.md`, na raiz do repositório `moises`.

## 1. O que o Moisés é hoje (visto de fora)

Isto veio de uma captura de tela de 11/11/2026, não do código. O código manda: se algo aqui
estiver errado, corrija no `DIAGNOSTICO.md` e siga o código.

- Painel web publicado na Vercel (`moises-iota.vercel.app`), com login. Abas "Sessões" e "Histórico".
- Um coletor na minha máquina alimenta o painel ("coletor ok · atualizado 05:38").
- Mostra o total gasto no dia, o projeto que mais gastou e um cartão por sessão do Claude Code:
  projeto, tarefa ("Sem tarefa registrada"), estado ("Ativa"), modelo e esforço, última atividade,
  nome da sessão e ramo, início, duração, tokens (entrada, saída, cache lido, cache escrito) e
  custo por modelo.
- A única ação que existe é o botão "Encerrar sessão". Ou seja: já há algum caminho do painel
  até a máquina. Descubra como ele funciona; é o ponto de partida.

## 2. Aonde quero chegar

Hoje o Moisés mostra. Quero que ele comande: cada terminal de agente que eu tenho rodando
deve poder ser acompanhado e dirigido pelo painel, inclusive pelo celular.

MVP, em ordem de prioridade:

1. **Estado ao vivo.** Cada sessão mostra o que está fazendo agora: trabalhando, esperando
   mensagem minha, esperando permissão, parada ou encerrada. Mostra também a última resposta
   do Claude e a tarefa (hoje aparece "Sem tarefa registrada": preencher pelo nome da sessão,
   pelo primeiro pedido ou por um campo editável no painel).
2. **Enviar mensagem.** Escrever um pedido no painel e ele chegar à sessão escolhida.
3. **Responder permissão.** Quando a sessão pedir permissão, aprovar ou negar pelo painel,
   vendo exatamente o que ela quer fazer.
4. **Interromper, encerrar e retomar.**
5. **Abrir sessão nova.** Escolher projeto (de uma lista permitida), pedido inicial, modelo,
   esforço e modo de permissão; opcionalmente em worktree.

Fora do MVP. Não implementar; anotar em `docs/orquestracao/IDEIAS.md` com uma linha cada:
fila e encadeamento ("quando a A terminar, começa a B"), mandar o mesmo pedido para várias
sessões, teto de gasto com pausa automática, aviso no Telegram quando uma sessão fica
esperando, gráficos novos no Histórico.

## 3. Regras que valem mais do que tudo

O painel está na internet e vai passar a mandar comandos para a minha máquina. Um erro aqui
vira execução remota de código. Por isso:

1. **Não tocar nas minhas sessões reais.** Há sessões abertas agora (achadinho_turbo e outras).
   Não envie mensagem, não encerre e não reinicie nenhuma sessão que você não criou. Todo teste
   usa sessões criadas por você, com nome começando por `moises-teste-`, numa pasta sandbox
   fora dos meus projetos (crie uma, com `git init`), no modelo mais barato disponível e com
   pedidos mínimos. Teto de gasto das sessões de teste somadas: US$ 2. Apague-as no fim.
2. **Nada sai da máquina sem o meu "pode".** Sem `git push`, sem merge em `main`, sem publicar
   na Vercel (nem prévia), sem alterar variáveis de ambiente nem dados de produção. Commits
   locais no ramo `feat/orquestracao` estão liberados.
3. **Banco e dados.** Só mudança aditiva (tabela ou coluna nova). Nada de apagar ou reescrever
   o que o painel de produção usa. Teste contra banco local ou de teste, nunca o de produção.
4. **O coletor só chama para fora.** Ele busca os comandos no servidor; não abra porta na
   minha máquina para a internet.
5. **Comandos são verbos fixos**, nunca shell livre vindo do painel: abrir, enviar mensagem,
   responder permissão, interromper, encerrar, retomar. Projeto só de uma lista permitida que
   fica na máquina, não no painel.
6. **Todo comando exige autenticação e fica num registro de auditoria** (quem, quando, qual
   sessão, qual verbo, resultado). Comando expira se não for buscado em pouco tempo e não é
   executado duas vezes.
7. **Nunca `bypassPermissions`** nem equivalente, nem como opção no painel.
8. **Segredos fora do repositório.** Nada de token ou chave em código, teste ou documento.
9. **Não instale plugin, MCP nem skill global.** Use o que já existe.
10. **Não pare para me perguntar.** Dúvida que não impede o trabalho: registre em
    `docs/orquestracao/PERGUNTAS.md` com a suposição mais conservadora e siga. Dúvida que
    impede: escreva `BLOQUEADO:` como manda o `/goal`.
11. O `CLAUDE.md` do projeto, se existir, vale mais do que este briefing nas convenções de
    código; as regras 1 a 8 acima valem mais do que qualquer coisa.

## 4. Fases

### Fase 1: diagnóstico (só leitura)
Leia o repositório inteiro e escreva `docs/orquestracao/DIAGNOSTICO.md`: stack, como o coletor
lê as sessões e o custo, como os dados chegam ao painel, como o "Encerrar sessão" funciona de
ponta a ponta, como é o login, que testes existem, e o que está frágil. Rode `claude --version`
e `claude --help` e anote o que a versão instalada oferece (ver seção 6).

Tenho duas contas do Claude Code nesta máquina: a padrão (`~/.claude`) e a segunda
(`CLAUDE_CONFIG_DIR=~/.claude-conta2`). Verifique se o coletor enxerga as duas e registre.

### Fase 2: decisão e plano
Escreva `docs/orquestracao/ADR-001-orquestracao.md` comparando, com teste real na sandbox e
não só leitura, os caminhos para comandar uma sessão:

- A. sessões em segundo plano do próprio Claude Code (`claude --bg`, `claude agents --json`,
  `attach`, `logs`, `stop`) mais hooks para o estado;
- B. sessões que o coletor conduz em modo não interativo (`claude -p` com `--resume` e
  `stream-json`, ou o Agent SDK);
- C. tmux (`send-keys`, `capture-pane`) para terminais interativos;
- D. o Remote Control nativo (`--remote-control`).

A pergunta que a ADR tem de responder com evidência: **dá para enviar mensagem e responder
permissão numa sessão que eu abri à mão num terminal comum?** Se não der, diga isso sem
rodeios e defina o que muda no meu jeito de abrir sessões (por exemplo, abrir pelo Moisés ou
por um atalho) e o que continua valendo para as abertas à mão (ver e encerrar).

Critérios: funciona nas duas contas, aguenta atualização do Claude Code, segurança, custo,
quanto código novo exige. Depois escreva `docs/orquestracao/PLANO.md` em tarefas pequenas,
cada uma com o teste que a prova.

### Fase 3: construção
Ramo `feat/orquestracao`. Teste antes do código. Ordem: canal de comandos seguro (regras 4 a
6) → estado ao vivo → enviar mensagem → permissão → interromper, encerrar e retomar → abrir
sessão → interface. Commits pequenos.

Interface: manter a identidade atual (escura, coluna estreita, pensada para o celular). No
cartão da sessão: estado em destaque, última resposta, caixa de mensagem, e o pedido de
permissão como um bloco que não dá para confundir com o resto. Ação destrutiva pede
confirmação. O painel deve deixar claro quando um comando foi enviado, recebido pelo coletor e
executado, e quando o coletor está fora do ar.

### Fase 4: prova
Um teste de ponta a ponta que sobe o painel e o coletor localmente e prova, numa sessão
`moises-teste-`, as cinco capacidades do MVP, uma a uma, com saída legível ("passou" ou
"falhou" por item). Mais um teste que prova a recusa de comando sem credencial, de comando
expirado e de comando repetido.

### Fase 5: revisão e segurança
Rode as revisões da seção 5, corrija o que for alto ou crítico, registre o resto em
`docs/orquestracao/ACHADOS.md` com a decisão tomada.

## 5. Skills por fase

Chame a skill pelo nome; não faça de memória o que ela faz.

| Fase | Skill | Para quê |
|---|---|---|
| 1 e 2 | `/superpowers:brainstorming` | Discutir o desenho antes de programar. As respostas às perguntas dela estão neste briefing; o que faltar segue a regra 10. |
| 1 e 2 | agentes do projeto, se existirem em `.claude/agents/` (produto, arquiteto, seguranca) | Diagnóstico e ADR. Se não existirem, siga sem eles; não rode a `iniciar-equipe`. |
| 2 | `/superpowers:writing-plans` | Escrever o `PLANO.md`. |
| 2 e 3 | context7 (escreva "use context7" no pedido) | Documentação atual das bibliotecas da stack. Para o Claude Code em si, vale o `claude --help` da máquina e a documentação oficial. |
| 2 e 3 | `/claude-api` | Só se a ADR escolher o Agent SDK. |
| 3 | `/superpowers:using-git-worktrees` | Isolar o trabalho no ramo `feat/orquestracao`. |
| 3 | `/superpowers:test-driven-development` | Teste antes do código, em toda tarefa do plano. |
| 3 | `/superpowers:subagent-driven-development` ou `/superpowers:executing-plans` | Executar o plano; com os agentes dev e qa, se existirem. |
| 3 | `/superpowers:systematic-debugging` | Qualquer erro ou teste que falha, antes de propor correção. |
| 3 | `/ui-ux-pro-max:ui-ux-pro-max` | Só o visual dos controles novos: estados, hierarquia, toque no celular, acessibilidade. Direção: painel de operação, sóbrio, o mesmo tema escuro de hoje. Não redesenhar o que já existe. |
| 3 e 4 | `/vercel:nextjs`, `/vercel:env`, `/vercel:status` | Se a stack for Next.js na Vercel: consulta e leitura. `/vercel:deploy` está proibido pela regra 2. |
| 4 | `/run` e `/vercel:verification` | Subir o app e conferir o fluxo de ponta a ponta de verdade, não só nos testes. |
| 5 | `/differential-review:diff-review` | Segurança de tudo que mudou no ramo. |
| 5 | `/insecure-defaults:audit` | Uma vez só, nas pastas do coletor e do canal de comandos (gasta mais). |
| 5 | `/sharp-edges:sharp-edges` | A API de comandos: o que é fácil de usar errado. |
| 5 | `/supply-chain-risk-auditor:supply-chain-risk-auditor` | Só se entrou dependência nova. |
| 5 | `/code-review` e `/simplify` | Corretude e limpeza do que mudou. |
| 5 | `/superpowers:requesting-code-review`, com o agente revisor se existir | Conferir o trabalho contra este briefing. |
| fim | `/superpowers:verification-before-completion` | Rodar cada verificação e colar a saída antes de dizer "pronto". |

Não usar aqui: `equipe_marketingskills`, `ux-landing-achadinhos`, `instagram-tweet-carousel`,
`humanizer`, `rodar_localmente` (são de outros projetos), os plugins do Figma e do Telegram.
A `/superpowers:finishing-a-development-branch` pode orientar o fechamento, mas a regra 2
decide: o ramo fica local, sem merge.

## 6. O que já se sabe do Claude Code

Conferido no pacote `@anthropic-ai/claude-code` 2.1.322 em 11/11/2026. Confirme na versão
instalada antes de se apoiar em qualquer item:

- `claude agents --json` imprime as sessões ativas, interativas e em segundo plano, como JSON
  (`--all` inclui as concluídas; `--cwd <pasta>` filtra).
- `claude --bg` abre a sessão em segundo plano e devolve um id; `claude attach <id>` abre no
  terminal, `claude logs <id>` mostra a saída recente, `claude stop <id>` encerra mantendo a
  conversa, `claude rm <id>` apaga, `claude respawn` reinicia.
- `claude -p` aceita `--resume <id>`, `--session-id <uuid>`, `--input-format stream-json`,
  `--output-format stream-json`, `--include-hook-events`, `--max-budget-usd` e
  `--permission-prompts host|none`.
- Na abertura: `--name`, `--worktree`, `--model`, `--effort`, `--permission-mode`.
- `--remote-control [nome]` abre a sessão com o Remote Control nativo.
- Existem hooks para `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Notification`,
  `PermissionRequest`, `PreToolUse`, `PostToolUse`, `Stop` e `SubagentStop`.

## 7. Relatório final (escrever na conversa, em português simples)

1. O que foi feito, em até 10 linhas.
2. Tabela: cada item da condição do `/goal`, o comando que prova e o fim da saída.
3. O que a ADR decidiu e o que isso muda no meu dia a dia (como passo a abrir as sessões).
4. Como eu testo à mão, em até 6 passos.
5. O que depende do meu "pode": push, merge, publicação, variáveis de ambiente, migração do
   banco de produção. Para cada um, o comando pronto.
6. Achados de segurança em aberto e perguntas registradas.
7. Quanto as sessões de teste gastaram e a confirmação de que foram apagadas.
