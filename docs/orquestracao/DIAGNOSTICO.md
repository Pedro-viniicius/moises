# Diagnóstico: o Moisés antes da orquestração

Feito em 11/11/2026 no commit `5212719` (ramo `main`), lendo o código inteiro. Onde o briefing e o código divergem, vale o que está aqui.

## 1. Stack

- Node.js >= 22 (a máquina roda v22.23.0), ESM puro, **zero dependências** e sem etapa de build. `package.json` só tem `test`, `coletor`, `retrato` e `configurar`: não existem scripts de lint nem de build.
- **Painel:** funções serverless da Vercel em `api/` (7 arquivos, ~290 linhas) e site estático em `public/` (HTML, CSS e JS sem framework; `app.js` tem 702 linhas). CSP `default-src 'self'` em `vercel.json`.
- **Dados:** Upstash Redis pela API REST. Não é Next.js nem Postgres. Chaves: `moises:retrato` (texto JSON), `moises:recebidoEm`, `moises:cmds` (hash id → pedido), `moises:logs` (hash id → log) e `moises:login:<ip>` (contador).
- **Coletor:** `collector/` (~900 linhas), serviço systemd do usuário (`moises-coletor.service`), ativo agora. **Ele roda a partir da pasta do repositório** (`WorkingDirectory=%h/Documentos/saas/moises`): trocar de ramo nessa pasta muda o código que a produção executa no próximo reinício. Por isso o trabalho está num worktree separado (`.claude/worktrees/orquestracao`) e a pasta principal continua em `main`.

## 2. Como o coletor lê as sessões e o custo

- `diretoriosDeConfig()` lista `~/.claude` e todo `~/.claude-*` que tenha `sessions/` ou `projects/`. O nome da conta é o sufixo da pasta (`.claude` → `principal`, `.claude-conta2` → `conta2`).
- **Sessões abertas:** `<dir>/sessions/<pid>.json`, o registro que o próprio Claude Code grava: `pid`, `sessionId`, `cwd`, `procStart`, `kind`, `name`, `status` (`busy`, `idle`, `waiting`), `waitingFor` (`permission prompt`, `input needed`) e `statusUpdatedAt`. O coletor confere se o processo está vivo comparando `procStart` com o campo 22 de `/proc/<pid>/stat`.
- **Histórico e custo:** `<dir>/projects/<projeto>/<sessionId>.jsonl` (transcript) e `<sessionId>/subagents/*.jsonl`, lidos de forma incremental em blocos de 4 MB (`transcript.js`). Cada resposta conta uma vez (chave `message.id|requestId`); o preço vem de `precos.js`; resposta copiada por retomada fica com a sessão de origem; o `cost-state` do Claude Code corrige o total quando cobre a sessão inteira.
- **Status de hoje** (`statusDe`): `busy`/`shell`/`running` → `ativa`; texto com `wait`/`perm`/`input` → `aguardando`; parada há mais de 15 min → `ociosa`; processo morto → `encerrada`. O `waitingFor` **é lido mas não é enviado**: o painel não distingue "esperando permissão" de "esperando mensagem".
- **Tarefa:** `ai-title` do transcript, senão o resumo `away_summary`. Sessão sem os dois aparece como "Sem tarefa registrada". O primeiro pedido e a última resposta do Claude não são lidos.
- Todo texto livre passa por `redigir.js` (mascara segredos, e-mail, telefone, CPF, CNPJ) antes de sair da máquina.

### As duas contas

O coletor enxerga **seis** diretórios, não dois: `.claude` (principal), `.claude-conta`, `.claude-conta1`, `.claude-conta2`, `.claude-conta3` e `.claude-conta5`. A conta padrão e a `conta2` estão cobertas (`.claude-conta2` tem 6 projetos e nenhuma sessão aberta agora). `claude auth status` responde `loggedIn=true` nas duas e um `claude -p` de teste funcionou em cada uma.

Achado do teste: para a conta padrão **não se deve definir `CLAUDE_CONFIG_DIR=~/.claude`**. Com a variável definida, o Claude Code procura a configuração em `~/.claude/.claude.json` em vez de `~/.claude.json`, avisa que não achou e cria um arquivo novo. O teste criou esse arquivo e eu o apaguei em seguida; `~/.claude.json` não foi tocado. Regra para o código: conta `principal` → variável ausente; outras contas → `CLAUDE_CONFIG_DIR=<pasta>`.

## 3. Como os dados chegam ao painel

```
coletor ──POST /api/ingest (Bearer MOISES_TOKEN) a cada 20 s──▶ Vercel ──▶ Redis
   ▲   corpo: { retrato | null, acks }                                      │
   └── resposta: { comandos pendentes }                                     │
celular ──GET /api/estado (cookie) a cada 15 s──▶ Vercel ◀──────────────────┘
```

- O coletor **só chama para fora**; nenhuma porta fica aberta na máquina. Ele só aceita URL `https` (ou `http` em `localhost`), não segue redirecionamento e recusa resposta maior que 200 KB.
- O retrato só é enviado quando muda (ou a cada 5 min, como sinal de vida). `recebidoEm` com mais de 2 min faz o painel mostrar o coletor como parado.

## 4. "Encerrar sessão" de ponta a ponta

1. Painel: `POST /api/encerrar` com `{chave, nome}`; exige cookie e `content-type: application/json`.
2. Servidor: confere se a sessão está no último retrato e aberta e se não há pedido pendente; grava `{id, tipo: "encerrar", chave, nome, estado: "pendente", criadoEm}` em `moises:cmds`.
3. Coletor: no próximo `ingest` (até 20 s) recebe os pendentes com `idadeMs` calculada pelo servidor. O laço trata como encerrar **todo pedido sem `tipo` ou com `tipo: "encerrar"`** e ignora os outros tipos.
4. `executarEncerrar` recusa pedido repetido (ids gravados em `~/.local/state/moises/encerrar.json`), pedido com mais de 2 min, mais de 5 por hora, conta desconhecida, registro sem `procStart`, processo que não confere e executável que não é o Claude Code. Só então manda `SIGTERM` ao pid e espera até 10 s.
5. No ciclo seguinte o coletor devolve o `ack` com o log; o servidor marca `feito`/`falhou` e grava o log no Histórico.

Esse é o canal que a orquestração vai estender. O que ele já tem: sentido único (coletor busca), expiração, bloqueio de repetição e limites locais. O que falta para carregar verbos mais perigosos:

- **O coletor não autentica o pedido.** Ele confia em tudo que vier na resposta do `ingest`. Quem controlar o Redis, a Vercel ou o cookie do painel cria pedidos. Para encerrar, o estrago é limitado; para "abrir sessão com um pedido" isso seria execução remota de código.
- A idade do pedido é informada pelo servidor (`idadeMs`), não por algo que o coletor possa conferir.
- Não há registro de auditoria local; só a linha no `journalctl` e o hash no Redis.
- Latência de até 20 s por pedido, mais 20 s para o resultado aparecer.

## 5. Login

Senha única. `PANEL_PASSWORD_HASH` (scrypt) em variável de ambiente; `POST /api/login` conta a tentativa antes de conferir (5 por IP a cada 15 min); cookie `moises` = `<exp>.<HMAC-SHA256(SESSION_SECRET, exp)>`, `HttpOnly; Secure; SameSite=Strict`, 30 dias. As rotas de escrita exigem JSON, o que barra formulário de outro site. O coletor usa `Authorization: Bearer MOISES_TOKEN`, comparado em tempo constante. O cookie não tem identificador nem revogação: não dá para derrubar uma sessão do painel sem trocar `SESSION_SECRET`.

## 6. Testes

- `npm test` → `node --test test/*.test.js`: 27 testes (`test/api.test.js` com 5, `test/coletor.test.js` com 22), com Redis falso em memória (`scripts/redis-memoria.js`).
- **Linha de base em 11/11/2026: 23 passam e 4 falham**, todos no `encerrar` do coletor, com "Pedido repetido; já foi tratado.".
- Causa: `test/coletor.test.js` define `process.env.MOISES_LIMITES_ARQ` na linha 2, mas em ESM os `import` são avaliados antes. `collector/encerrar.js` lê a variável ao ser importado, então **os testes usam o arquivo real `~/.local/state/moises/encerrar.json`**, o mesmo do coletor de produção. Os ids fixos dos testes ficaram gravados lá numa execução anterior e agora são recusados como repetidos. Além de falhar, cada execução dos testes gasta a cota de 5 encerramentos por hora do coletor de produção.
- Não há teste de interface, nem teste de ponta a ponta com o Claude Code de verdade.

## 7. O que está frágil

| # | Ponto | Risco |
|---|---|---|
| F1 | Coletor não autentica pedidos (seção 4) | Com verbos novos, vira execução remota de código |
| F2 | Testes gravam no estado de produção (seção 6) | 4 testes falhando e cota de encerrar consumida |
| F3 | Serviço roda da pasta do repositório | Trocar de ramo ali muda a produção no reinício |
| F4 | Pedido sem `tipo` é tratado como encerrar | Um coletor antigo encerraria a sessão alvo de um verbo novo sem `tipo`; os verbos novos precisam manter o campo `tipo` |
| F5 | `scripts/configurar.js` troca `MOISES_TOKEN` e `SESSION_SECRET` a cada execução | Rodar de novo derruba o coletor até publicar; segredo novo precisa de script separado |
| F6 | `api/logs.js` apaga logs antigos dentro de um `GET` | Efeito colateral em leitura; fora do escopo |
| F7 | Redis falso não simula expiração (`EXPIRE` é ignorado) | Limite de login não é testado no tempo |
| F8 | Sem scripts de lint e build | Nada verifica sintaxe do que a Vercel vai carregar |
| F9 | Latência de 20 s | Ruim para conversa e para responder permissão |

## 8. O que a versão instalada do Claude Code oferece

`claude --version` → `2.1.322 (Claude Code)`, em `~/.local/bin/claude`. Conferido com `claude --help` e com testes na pasta sandbox `~/moises-sandbox`:

| Item da seção 6 do briefing | Situação na 2.1.322 |
|---|---|
| `claude agents --json`, `--all`, `--cwd` | Confirmado. Interativas trazem `pid`, `status`, `waitingFor`; as de segundo plano trazem `id` e `state` (`working`, `blocked`, `done`, `stopped`). Sessões `claude -p` também aparecem, como `kind: "interactive"` |
| `claude --bg`, `attach`, `logs`, `stop`, `rm`, `respawn` | Confirmado. `--bg` exige que a pasta já tenha sido aceita no diálogo de confiança. `logs` devolve a tela crua do terminal (sequências de controle), não texto estruturado |
| `claude -p` com `--resume`, `--session-id`, `--input-format stream-json`, `--output-format stream-json`, `--include-hook-events`, `--max-budget-usd`, `--permission-prompts host\|none` | Confirmado |
| `--name`, `--worktree`, `--model`, `--effort`, `--permission-mode` | Confirmado. Modos: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` |
| `--remote-control [nome]` | Confirmado; entrega um endereço `claude.ai/code/session_…` |
| Hooks | `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop` e `SessionEnd` dispararam nos testes |

Fatos novos que o briefing não trazia:

- Não existe `tmux` nesta máquina (o caminho C não pôde ser testado e não foi instalado nada).
- Não existe comando para **enviar mensagem** a uma sessão já aberta (`claude send` não existe).
- `--permission-prompt-tool stdio` não aparece no `--help`, mas funciona: é o protocolo que o Agent SDK usa por baixo.
- Sessões interativas desta conta abrem em **modo automático** de permissão ("auto mode on") por padrão; em `-p` o padrão é `default`.
- Processos filhos de uma sessão do Claude Code herdam variáveis (`CLAUDE_CODE_CHILD_SESSION` e outras) que desligam a gravação do transcript. Quem abre sessões a partir de outro processo deve limpar as variáveis `CLAUDE*` do ambiente.
- O coletor de produção enxerga as sessões de teste da sandbox como qualquer outra: elas aparecem no painel publicado enquanto existirem.
