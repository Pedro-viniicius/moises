# ADR-001: como o Moisés comanda uma sessão do Claude Code

- **Data:** 11/11/2026 · **Estado:** aceita (decisão tomada sem parar para perguntar, como manda a regra 10 do briefing; as suposições estão em `PERGUNTAS.md`)
- **Versão testada:** Claude Code 2.1.322, Linux, contas `principal` e `conta2`
- **Onde foram os testes:** pasta sandbox `~/moises-sandbox`, só sessões `moises-teste-…` criadas para isso, modelo Haiku. Gasto somado dos testes desta ADR: menos de US$ 0,02.

## A pergunta

> Dá para enviar mensagem e responder permissão numa sessão que eu abri à mão num terminal comum?

**Enviar mensagem: não.** Não existe comando nem interface pública para outro processo entregar um pedido a uma sessão interativa que está parada no prompt. O que existe e por que não serve:

- `claude --bg --resume <id> "texto"` com a sessão aberta **cria uma cópia** com outro id (testado: "this started a copy as 8e77c974"); a conversa original não recebe nada.
- O hook `Stop` consegue devolver `{"decision":"block","reason":"…"}` e o Claude trata o texto como instrução (testado). Mas ele só roda **quando um turno termina**: serve para enfileirar uma mensagem atrás do trabalho em andamento, não para acordar uma sessão parada.
- Cada sessão abre um socket de mensagens entre sessões (`CLAUDE_CODE_MESSAGING_SOCKET`). O formato não é documentado, a mensagem chega como "mensagem de outra sessão" e pode ficar retida, e não responde permissão. Não foi usado.
- O Remote Control nativo faz exatamente isso, mas só pelo app do Claude e por `claude.ai/code`; não há interface para o Moisés usar.

**Responder permissão: sim, com uma condição.** Um hook `PermissionRequest` recebe a ferramenta e a entrada exata e pode devolver aprovar ou negar. Testado numa sessão interativa aberta num pseudo-terminal, em modo manual: o hook esperou uma decisão gravada de fora, devolveu `allow` e o comando rodou sem ninguém tocar no terminal; com `deny`, o comando não rodou. A condição: o hook precisa estar instalado nas configurações da conta (`~/.claude/settings.json`), o que mexe em todas as suas sessões reais. Isso **não foi feito** e não entra neste MVP; fica como próximo passo que depende do seu "pode" (`IDEIAS.md`). Além disso, suas sessões interativas abrem em modo automático, em que quase nada chega a pedir permissão.

### O que muda no seu dia a dia

- **Para comandar pelo painel, a sessão tem de nascer no Moisés** (botão "Nova sessão") ou ser **retomada por ele** depois de fechada no terminal (botão "Retomar"). Essas sessões rodam sem janela de terminal, conduzidas pelo coletor.
- **Uma sessão é do terminal ou do Moisés, nunca dos dois ao mesmo tempo.** Para trazer uma sessão do Moisés para o terminal: encerre no painel e rode `claude --resume <id>`. Para o caminho inverso: feche no terminal e toque em "Retomar".
- **Sessões abertas à mão continuam com ver e encerrar**, e ganham estado ao vivo (trabalhando, esperando mensagem, esperando permissão), tarefa e última resposta, porque isso sai do registro e do transcript que o coletor já lê.
- Para mandar mensagem do celular a uma sessão aberta à mão, o caminho que funciona hoje é o do próprio Claude Code: digite `/rc` nela (ou abra com `claude --remote-control`) e use o app do Claude.

## Os caminhos comparados

| Critério | A. `claude --bg` + hooks | B. `claude -p` com `stream-json` | C. tmux | D. Remote Control |
|---|---|---|---|---|
| Abrir com um pedido | sim | sim | — | sim, mas pelo terminal |
| Estado ao vivo | sim (`agents --json`: `working`, `blocked`, `done`) | sim (eventos no stdout e o mesmo registro) | — | no app do Claude |
| Última resposta | `claude logs` devolve tela crua de terminal; teria de ler o transcript | evento `result` e transcript | captura de tela | no app |
| Enviar mensagem na mesma conversa | **não**: com a sessão aberta cria cópia; depois de `stop`, só sem nenhuma flag | **sim**: uma linha JSON no stdin | digitando no painel do tmux | sim, pelo app |
| Responder permissão | só com `attach` (precisa de terminal) ou hook | **sim**: pedido `can_use_tool` com ferramenta e entrada; resposta `allow`/`deny` | digitando "1" ou "3" numa tela | sim, pelo app |
| Interromper | não há comando; só `stop` | **sim**: pedido `interrupt`; a sessão segue viva | `Esc` por teclas | sim, pelo app |
| Encerrar / retomar | `stop`, `rm`, `--resume` | fechar o stdin; `--resume <id>` com o mesmo id | matar o painel | — |
| Duas contas | sim (`CLAUDE_CONFIG_DIR`) | sim, testado nas duas | sim | sim |
| Aguenta atualização | comandos documentados; a regra da cópia já é sutil | flags documentadas; o protocolo de controle é o do Agent SDK, não descrito no `--help` | frágil: depende do desenho da tela | sem interface para terceiros |
| Segurança | o serviço de fundo guarda as opções da sessão; pasta precisa de confiança prévia | o coletor é dono do processo e vê cada pedido de permissão antes de rodar | qualquer texto digitado vira tecla; fácil injetar | passa pelos servidores da Anthropic; fora do controle do Moisés |
| Custo | igual ao de uma sessão normal | igual; teste com Haiku: US$ 0,0005 por turno | igual | igual |
| Código novo | médio, e ainda precisaria de hooks para mensagem e permissão | médio: um módulo que conversa por stdin/stdout | alto e frágil | nenhum, mas não atende |
| Testado aqui | sim | sim | **não: `tmux` não está instalado** e nada foi instalado | sim (abriu e entregou o endereço) |

### Evidência por caminho

- **A.** `claude --bg` recusou a pasta nova ("Workspace not trusted") até a confiança ser aceita uma vez num terminal. Depois abriu (`backgrounded · 3c7180ec`), apareceu em `agents --json` como `working` → `done`, e criou o arquivo pedido sem perguntar (modo automático). Em `--permission-mode manual` ficou `state: "blocked", waitingFor: "permission prompt"` e não há comando para responder. Segunda mensagem: criou cópia.
- **B.** Um processo só, mantido aberto, recebeu quatro mensagens seguidas; o pedido de permissão chegou como `control_request`/`can_use_tool` com `tool_name`, `input` e `tool_use_id`; `allow` criou o arquivo, `deny` não criou e o Claude foi avisado do motivo; `interrupt` no meio de um `sleep` de 50 s devolveu `terminal_reason: "aborted_tools"` em menos de um segundo e a sessão respondeu à mensagem seguinte; fechar o stdin encerrou com código 0; `claude -p --resume <id>` em outro processo lembrou do primeiro comando. Durante o trabalho a sessão apareceu em `claude agents --json` como `busy` e depois `idle`. `--permission-mode manual`, `--effort` e `--worktree` funcionam em `-p`.
- **C.** Não testado: `tmux` não existe na máquina e instalar programa não faz parte do combinado. Mesmo instalado, só alcançaria sessões abertas dentro dele, e aprovar permissão seria apertar tecla numa tela que muda a cada versão.
- **D.** `claude --remote-control moises-teste-rc` abriu e mostrou "remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_…". A documentação não oferece interface para um site de terceiros.

## Decisão

1. **Sessões comandadas usam o caminho B.** O coletor abre `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`, guarda o processo e conversa com ele por stdin/stdout. Sem dependência nova (o Agent SDK faria o mesmo trazendo um pacote e uma cópia própria do Claude Code).
2. **Sessões abertas à mão ficam em ver e encerrar**, com estado ao vivo, tarefa e última resposta lidos do registro e do transcript.
3. **O canal de comandos continua sendo o que o Encerrar já usa** (o coletor busca; nada escuta na máquina), com três mudanças: assinatura de ponta a ponta, auditoria local e busca mais rápida quando o painel está aberto.

### Canal de comandos

- **Verbos fixos** no campo `tipo` (o mesmo campo de hoje, para um coletor antigo ignorar o que não conhece): `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar`, `retomar`. Nada de texto de shell vindo do painel.
- **Credencial que não mora na nuvem.** Um "código de comandos" é gerado na máquina por um script novo e digitado uma vez em cada aparelho. Dele sai uma chave (PBKDF2-SHA256) que fica no coletor e no navegador. Todo comando sai do navegador assinado (HMAC-SHA256) sobre versão, id, tipo, sessão, horário de criação e dados. A Vercel e o Redis só transportam: **quem tomar o painel, o Redis ou a Vercel não consegue criar um comando que o coletor aceite**. Sem chave configurada no coletor, todo comando é recusado.
- **Validade e repetição conferidas na máquina.** O horário de criação faz parte da assinatura; o coletor recusa comando com mais de 2 min ou com data no futuro além de 30 s, e guarda em disco os ids já vistos.
- **Auditoria local**, em `~/.local/state/moises/auditoria.jsonl` (permissão 600): quando, quem (impressão digital da chave), sessão, verbo, se foi aceito ou recusado e o resultado. O texto das mensagens não entra.
- **Limites locais**, que o painel não muda: lista de projetos em arquivo na máquina, modos de permissão aceitos (`manual`, `acceptEdits`, `plan`; `bypassPermissions` é recusado sempre), teto de sessões comandadas abertas, teto de comandos por minuto e a chave `MOISES_COMANDOS=0` que desliga tudo.
- **Pedido de permissão conferível.** O coletor assina o que a sessão quer fazer (ferramenta e entrada) com a mesma chave; o painel só libera o botão "Aprovar" se a assinatura conferir. Assim ninguém no meio troca o comando mostrado.
- **Rapidez.** Com o painel aberto (o servidor informa quando foi visto), o coletor busca a cada 3 s em vez de 20 s.

### O que passa a sair da máquina

Hoje sobem só metadados e resumos. Para comandar, passam a subir também, sempre por `redigir.js` e cortados: a última resposta do Claude, o primeiro pedido (como tarefa) e o conteúdo do pedido de permissão. Descem pelo painel: o pedido inicial e as mensagens que você digitar. O texto de um comando é apagado do Redis assim que o coletor confirma o recebimento.

## Consequências

- **Bom:** as cinco capacidades do MVP funcionam e são testáveis com o Claude Code de verdade; zero dependência nova; a nuvem deixa de ser ponto de confiança para comandos.
- **Custo:** sessões comandadas não têm janela de terminal; para vê-las "ao vivo" no computador é preciso retomar no terminal. Um aparelho novo exige digitar o código de comandos.
- **Risco aceito:** o protocolo de controle (`can_use_tool`, `interrupt`) não está no `--help`. Mitigação: o teste de ponta a ponta exercita as cinco capacidades contra o Claude Code instalado; rode-o depois de cada atualização. Se o protocolo mudar, o plano B é trocar o módulo por um turno por processo (`claude -p --resume`) com hook `PermissionRequest`, ambos documentados.
- **Fora desta decisão:** instalar o hook de permissão nas sessões abertas à mão, fila de mensagens pelo hook `Stop`, cifrar o conteúdo de ponta a ponta. Estão em `IDEIAS.md`.
