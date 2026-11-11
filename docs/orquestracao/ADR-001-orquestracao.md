# ADR-001: como o Moisés comanda uma sessão do Claude Code

- **Data:** 11/11/2026 · **Estado:** aceita (decisão tomada sem parar para perguntar, como manda a regra 10 do briefing; as suposições estão em `PERGUNTAS.md`)
- **Versão testada:** Claude Code 2.1.322, Linux, contas `principal` e `conta2`
- **Onde foram os testes:** pasta sandbox `~/moises-sandbox`, só sessões `moises-teste-…` criadas para isso, modelo Haiku. Gasto somado dos testes desta ADR: menos de US$ 0,05.
- **Revisão:** o canal de comandos foi revisto no mesmo dia, depois da revisão de segurança do desenho (`ACHADOS.md`). A escolha do caminho B não mudou.

## A pergunta

> Dá para enviar mensagem e responder permissão numa sessão que eu abri à mão num terminal comum?

**Enviar mensagem: não.** Não existe comando nem interface pública para outro processo entregar um pedido a uma sessão interativa que está parada no prompt. O que existe e por que não serve:

- `claude --bg --resume <id> "texto"` com a sessão aberta **cria uma cópia** com outro id (testado: "this started a copy as 8e77c974"); a conversa original não recebe nada.
- O hook `Stop` consegue devolver `{"decision":"block","reason":"…"}` e o Claude trata o texto como instrução (testado). Mas ele só roda **quando um turno termina**: serve para enfileirar uma mensagem atrás do trabalho em andamento, não para acordar uma sessão parada.
- Cada sessão abre um socket de mensagens entre sessões (`CLAUDE_CODE_MESSAGING_SOCKET`). O formato não é documentado, a mensagem chega como "mensagem de outra sessão" e pode ficar retida, e não responde permissão. Não foi usado.
- O Remote Control nativo faz exatamente isso, mas só pelo app do Claude e por `claude.ai/code`; não há interface para o Moisés usar.

**Responder permissão: sim, com uma condição.** Um hook `PermissionRequest` recebe a ferramenta e a entrada exata e pode devolver aprovar ou negar. Testado numa sessão interativa aberta num pseudo-terminal, em modo manual: o hook esperou uma decisão gravada de fora, devolveu `allow` e o comando rodou sem ninguém tocar no terminal; com `deny`, o comando não rodou. A condição: o hook precisa estar instalado nas configurações da conta (`~/.claude/settings.json`), o que mexe em todas as suas sessões reais. Isso **não foi feito** e não entra neste MVP; fica como próximo passo que depende do seu "pode" (`IDEIAS.md`). Além disso, suas sessões interativas abrem em modo automático, em que quase nada chega a pedir permissão.

### O que muda no seu dia a dia

- **Para comandar pelo painel, a sessão tem de nascer no Moisés** (botão "Nova sessão") ou ser **retomada por ele** depois de fechada no terminal (botão "Retomar"). Essas sessões rodam sem janela de terminal, conduzidas pelo coletor, e isoladas: sem seus plugins, MCP, hooks e skills (ver "Sessões comandadas nascem isoladas").
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

Esta parte foi revista depois da revisão de segurança do desenho (achados S1 a S13, em `ACHADOS.md`).

- **Verbos fixos** no campo `tipo`: `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar`, `retomar`. Nada de texto de shell vindo do painel. Comando sem verbo ou sem assinatura é recusado, inclusive o Encerrar antigo.
- **Credencial que não mora na nuvem, uma por aparelho.** Um "código do aparelho" é gerado na máquina por um script novo e digitado uma vez em cada aparelho. Dele sai uma chave (PBKDF2-SHA256) que fica num arquivo 600 do coletor e, no navegador, como chave **não extraível** (o navegador assina com ela, mas não consegue lê-la nem copiá-la). Todo comando sai assinado (HMAC-SHA256) sobre aparelho, id, verbo, sessão, horário e dados. Cada aparelho pode ser revogado sozinho, apagando uma linha do arquivo.
- **O que essa assinatura garante e o que não garante.** Quem tiver só o Redis, só o cookie de login ou só o token do coletor **não consegue criar um comando**. Quem tomar a conta da Vercel consegue trocar o código do painel e, a partir daí, **assinar comandos enquanto o painel estiver aberto num aparelho autorizado** (não consegue levar a chave embora). Esse resto de risco é contido pelos limites locais abaixo e fica registrado como achado em aberto (S1).
- **Validade e repetição conferidas na máquina.** O horário de criação faz parte da assinatura; o coletor recusa comando com mais de 2 min ou com data no futuro além de 30 s, e guarda em disco os ids já aceitos por 10 min (poda por tempo, nunca por quantidade; se não conseguir gravar, recusa).
- **O que você viu é o que vale.** Todo comando sobre uma sessão leva o projeto e o nome que o cartão mostrava; o coletor recusa se a sessão real for outra. Em "Aprovar", o comando leva a impressão digital (SHA-256) do pedido que apareceu na tela, e o coletor só aprova se for igual ao pedido que está pendente. Se o pedido não coube inteiro, teve trecho mascarado ou tem caractere invisível, o painel só oferece "Negar". A resposta à sessão é montada pelo coletor, vale para aquele pedido só e nunca cria regra permanente.
- **Auditoria local**, em `~/.local/state/moises/auditoria.jsonl` (permissão 600): quando, quem (aparelho), sessão, verbo, se foi aceito ou recusado e o resultado. O texto das mensagens não entra.
- **Limites locais**, que o painel não muda: lista de projetos em arquivo na máquina; modos de permissão aceitos (`manual`, `acceptEdits`, `plan`; `bypassPermissions` é recusado sempre e desligado nas configurações da sessão); teto de sessões abertas (4), de aberturas por dia (20), de comandos por minuto (30) e de gasto por sessão (US$ 5, pelo `--max-budget-usd` do próprio Claude Code); pedido de permissão sem resposta em 30 min é negado; e a chave `MOISES_COMANDOS=0`, que desliga tudo.
- **Rapidez.** Com o painel aberto (o servidor informa quando foi visto), o coletor busca a cada 3 s em vez de 20 s.

### Sessões comandadas nascem isoladas

Uma sessão aberta pelo painel roda com `--restricted --tools=Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config --disable-slash-commands` e um `--settings` fixo do coletor. Na prática: **não carrega seus plugins, servidores MCP, hooks, skills, comandos de barra nem regras de permissão**; só o `CLAUDE.md` do projeto e as seis ferramentas básicas. O motivo é que uma sessão dirigida de fora não pode herdar uma regra "permitir sempre" nem um hook que aprove sozinho. Testado na sandbox (spike B6): o `init` mostrou só as seis ferramentas, nenhum MCP, nenhuma skill; `/help` respondeu que não está disponível; mensagem começando com `!` virou texto comum e pediu permissão; a leitura de `~/.config/moises/` foi negada pela regra fixa; em `acceptEdits`, arquivo comum foi escrito sem pedir, mas `.claude/settings.local.json` e `.git/hooks/pre-commit` pediram permissão.

O coletor confere cada `init` da sessão e a encerra se o modo de permissão ou a lista de ferramentas não for o esperado. O processo recebe um ambiente mínimo (sem `MOISES_*`, sem agente de SSH, sem variáveis `CLAUDE*` herdadas). A lista de ferramentas pode ser ampliada por configuração local, nunca pelo painel (P16 em `PERGUNTAS.md`).

### O que passa a sair da máquina

Hoje sobem só metadados e resumos. Para comandar, passam a subir também, sempre mascarados por `redigir.js` e cortados: a última resposta do Claude (1.200 caracteres), o primeiro pedido (como tarefa, 140) e o conteúdo do pedido de permissão (4.000, com as quebras de linha). Descem pelo painel: o pedido inicial e as mensagens que você digitar. O texto de um comando é apagado do Redis quando o coletor confirma o recebimento ou quando o comando expira. **Esse conteúdo não é cifrado**: a Vercel e o Upstash conseguem lê-lo enquanto passa (achado S10, em aberto; a cifra está em `IDEIAS.md`). Para não subir texto nenhum, `MOISES_SUBIR_TEXTO=0` no coletor: o painel continua comandando, mas sem mostrar resposta, e pedido de permissão só pode ser negado.

## Consequências

- **Bom:** as cinco capacidades do MVP funcionam e são testáveis com o Claude Code de verdade; zero dependência nova; Redis, cookie e token do coletor deixam de bastar para comandar a máquina.
- **Custo:** sessões comandadas não têm janela de terminal; para vê-las "ao vivo" no computador é preciso retomar no terminal. Elas não usam seus plugins, MCP nem skills. Um aparelho novo exige digitar o código dele. Reiniciar o coletor encerra as sessões comandadas (dá para retomar depois).
- **Riscos que ficam com você** (detalhe em `ACHADOS.md`): a conta da Vercel tomada consegue comandar enquanto o painel estiver aberto (S1); o que o painel mostra de estado pode ser adulterado ou atrasado por quem controla o Redis, embora os comandos não (S6); o texto que passa pelo painel não é cifrado (S10); um comando aprovado roda com o seu usuário, que lê os seus arquivos (S4).
- **Risco aceito:** o protocolo de controle (`can_use_tool`, `interrupt`) não está no `--help`. Mitigação: o teste de ponta a ponta exercita as cinco capacidades contra o Claude Code instalado; rode-o depois de cada atualização. Se o protocolo mudar, o plano B é trocar o módulo por um turno por processo (`claude -p --resume`) com hook `PermissionRequest`, ambos documentados.
- **Fora desta decisão:** instalar o hook de permissão nas sessões abertas à mão, fila de mensagens pelo hook `Stop`, cifrar o conteúdo de ponta a ponta. Estão em `IDEIAS.md`.
