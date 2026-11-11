# moises

Painel pessoal das minhas sessões do Claude Code, para abrir no celular: o que cada sessão está fazendo, quanto gasta, com qual modelo e esforço; abrir sessão, mandar mensagem, aprovar ou negar permissão, interromper e encerrar pelo site; histórico de logs; ideias de próximo passo e recomendação de modelo/esforço.

## Como funciona

```
[coletor local: collector/]  lê ~/.claude*/sessions e ~/.claude*/projects (transcripts + subagentes)
        │  POST /api/ingest a cada 20 s, ou a cada 3 s com o painel aberto
        │  (metadados e texto curto mascarado por redigir.js; volta com os comandos assinados)
        ▼
[Vercel: api/ + public/]  ←→  Upstash Redis (retrato, comandos, logs)
        ▲
   eu no celular (login por senha; comandos assinados com a chave do aparelho)
```

- **O que sai da máquina:** ver "O que sai da máquina e para onde", mais abaixo. Código, segredo e variável de ambiente nunca saem. Sobem metadados (nome da pasta do projeto, título e resumo gerados pelo Claude, status, horários, modelo, esforço, tokens e custo) e, para comandar, um pouco de texto: última resposta, primeiro pedido e pedido de permissão, **só das sessões comandadas pelo painel**.
- **Custo** é estimado em preço de API (`collector/precos.js`), contando cada resposta uma vez — inclusive quando uma sessão retomada copia o histórico de outra: a resposta fica com a sessão de origem — e somando os subagentes. Quando a sessão tem o `cost-state` oficial do Claude Code, ele corrige o total (inclui chamadas que não vão para o transcript). Valores sem essa conferência aparecem com "≈".
- **Status**: `busy`/`shell` → ativa; `idle` há menos de 15 min → aguardando você; mais de 15 min → ociosa; processo morto → encerrada.
- **Encerrar uma sessão aberta à mão** vira um comando assinado (como todos). O coletor só manda `SIGTERM` se pid, `sessionId`, início do processo (`procStart`, obrigatório) e executável do Claude Code baterem, e o pedido expira em 2 min. Limites locais, que o site não consegue mudar: no máximo 5 encerramentos por hora (`MOISES_ENCERRAR_POR_HORA`), pedido repetido é ignorado e `MOISES_ENCERRAR=0` desliga a função. Depois grava o log (nome editável, resumo, duração, modelo, custo) no Histórico, que guarda os 500 mais recentes.
- **Ideias e recomendação** (v3): o coletor chama `claude -p --model haiku` com contexto mínimo (~US$ 0,0002 por chamada), só para sessões abertas, só quando título/resumo mudam e no máximo a cada 10 min por sessão (teto de 80/dia). A recomendação de modelo/esforço sai de regras fixas em `collector/ideias.js`. O gasto aparece no painel.

## Orquestração: comandar sessões pelo painel

Decisão e comparação dos caminhos em [`docs/orquestracao/ADR-001-orquestracao.md`](docs/orquestracao/ADR-001-orquestracao.md); plano em [`docs/orquestracao/PLANO.md`](docs/orquestracao/PLANO.md).

- **Quem pode ser comandada.** Só a sessão que **nasce no painel** ("Nova sessão") ou que o painel **retoma** depois de fechada. Ela roda sem janela de terminal, como um processo `claude -p` em `stream-json` conduzido pelo coletor. Sessões abertas à mão no terminal continuam só com **ver e encerrar** (e ganham estado ao vivo; a última resposta e a tarefa tirada do primeiro pedido **não sobem**, só metadados, título e resumo). Uma sessão é do terminal ou do painel, nunca dos dois: para levar uma do painel ao terminal, encerre no painel e rode `claude --resume <id>`.
- **Seis verbos:** `abrir`, `mensagem`, `permissao` (aprovar ou negar), `interromper`, `encerrar` e `retomar`. Cada comando sai do aparelho **assinado** com uma chave privada que nasce no navegador do aparelho e **não pode ser copiada**; o computador guarda só a chave pública, e o servidor e o Redis só transportam. Nada secreto é digitado no painel: o aparelho **pede autorização** e você a dá no computador, pelo terminal (ver "Configuração local"). O coletor confere assinatura, validade (2 min), repetição e se a sessão é a que você viu na tela, e só então executa. Quem tiver só o Redis, o cookie ou o token do coletor não consegue comandar nada. Detalhes e riscos que ficam com o dono na ADR.
- **O painel publicado tem de ser igual ao `public/` deste computador.** A cada 10 min (e ao iniciar), o coletor baixa `/index.html`, `/app.js`, `/assinatura.js`, `/cofre.js` e `/style.css` do endereço em `MOISES_URL` e compara o SHA-256 com os de `public/` da pasta onde ele roda. Se algum divergir, ou não baixar, **os comandos ficam desligados** (motivo `painel_alterado`, e cada comando que chegar é recusado) até uma conferência bater. Se alguém trocar o código do painel na Vercel, os comandos são desligados em até 10 min; até lá, a troca ainda poderia assinar comandos enquanto o painel estivesse aberto num aparelho autorizado (por isso proteja a conta da Vercel com verificação em duas etapas). Consequência: ao publicar o painel, o `public/` do computador tem de ser o mesmo. `MOISES_CONFERIR_PAINEL=0` desliga a conferência (só para desenvolvimento).
- **Sessões do painel nascem isoladas.** Sem seus plugins, servidores MCP, hooks, skills, comandos de barra nem regras de permissão: só o `CLAUDE.md` do projeto e seis ferramentas (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`). Motivo: uma sessão dirigida de fora não pode herdar um "permitir sempre" ou um hook que aprove sozinho. Para mudar a lista de ferramentas, use `MOISES_FERRAMENTAS` no computador; o painel não muda isso. Nunca há `bypassPermissions`; os modos aceitos são `manual`, `acceptEdits` e `plan`. O processo filho recebe um ambiente mínimo (sem `MOISES_*`, sem agente de SSH) e o coletor encerra a sessão se o `init` vier com modo de permissão, MCP ou ferramentas diferentes do esperado.
- **Aprovar permissão** só é possível quando o pedido foi publicado inteiro e o painel assina a impressão digital do que você viu. O pedido aparece inteiro na tela, sem caixa com rolagem, e só pode ser **negado pelo celular** quando: foi cortado, teve trecho mascarado ou tem caractere invisível; tem jeito de esconder conteúdo (mais de 30 linhas, 3 ou mais linhas em branco seguidas, 16 ou mais espaços ou tabulações seguidos, ou espaço no fim de linha); ou é **sensível** (menciona `~/.config/moises`, `~/.local/state/moises`, `~/.ssh`, variáveis de ambiente, `.claude/settings`, `.git/hooks` ou credenciais, ou é um comando `Bash` com letra fora de ASCII). Para esses, aprove só no computador, ou negue. O coletor recusa a aprovação mesmo que ela chegue. Pedido sem resposta em 30 min é negado (`MOISES_PERMISSAO_EXPIRA_MIN`).
- **Limites locais**, que o painel não muda: 4 sessões comandadas abertas, 20 aberturas por dia, 30 comandos por minuto, US$ 5 de gasto por sessão (`--max-budget-usd` do Claude Code) e só projetos da lista local. **O painel não abre nem retoma sessão numa pasta que contenha o próprio Moisés** (a raiz do repositório onde o coletor roda, ou uma pasta acima dela): um agente comandado de fora não pode reescrever o coletor. `MOISES_COMANDOS=0` desliga tudo.
- **Auditoria local** (permissão 600, pasta `~/.local/state/moises` com permissão 700): `auditoria.jsonl` guarda o que foi aceito e o resultado de cada comando (na falha, só a primeira frase do erro); `auditoria-recusas.jsonl` guarda as recusas, num arquivo à parte para uma enxurrada delas não empurrar os aceitos para fora. Cada linha tem quando, qual aparelho (só depois de a assinatura conferir; antes disso, o `kid` que o comando dizia ter fica em `kidInformado`), sessão, verbo e o motivo. Cada arquivo gira sozinho em 5 MB. O texto das mensagens não entra.
- **Reiniciar o serviço encerra as sessões comandadas.** Elas aparecem como encerradas e dá para **retomar** pelo painel (se a pasta delas estiver na lista de projetos). Por elas rodarem no mesmo grupo do serviço, a unidade do systemd usa `MemoryHigh=4G`.

### O que sai da máquina e para onde

Tudo passa pela Vercel (função em `iad1`) e pelo Upstash Redis (região `iad1`, EUA), **sem cifra de ponta a ponta**: a Vercel e o Upstash conseguem ler o texto enquanto ele passa.

| Texto | Sobe? | Limite | Tratamento |
|---|---|---|---|
| Última resposta do Claude | **só de sessão comandada pelo painel** | 1.200 caracteres | mascarado por `redigir.js` |
| Primeiro pedido da sessão (vira a "tarefa" quando não há título nem resumo) | **só de sessão comandada pelo painel** (na aberta à mão, a tarefa cai para o nome da sessão) | 140 caracteres | mascarado; **não** vai para o Histórico nem para as ideias |
| Pedido de permissão (ferramenta e entrada) | sim (só existe em sessão comandada) | 4.000 caracteres, com quebras de linha | mascarado; caractere invisível vira `\u{…}` visível |
| Mensagem ou pedido inicial que você digita | desce, do painel ao coletor | 6.000 caracteres | sai do Redis quando o coletor confirma o recebimento ou o comando expira |
| O retrato inteiro (inclui título e resumo das sessões) | sim, a cada envio | — | **expira no Redis em 24 h** se o coletor ficar esse tempo sem mandar outro |

Mascarados: segredos, e-mails, telefones, CPF, CNPJ, cartão (número que passa no Luhn) e CEP. Para **não subir texto nenhum**, ponha `MOISES_SUBIR_TEXTO=0` no `coletor.env` (ou no ambiente do coletor, que vale por cima): o painel continua comandando, mas sem mostrar resposta nem primeiro pedido, e todo pedido de permissão só pode ser negado.

## Uso

```bash
npm test                      # testes do coletor, da API, do canal de comandos e do orquestrador
npm run lint                  # confere a sintaxe de todos os .js
npm run build                 # confere vercel.json e que cada rota de api/ carrega
npm run e2e                   # prova de ponta a ponta com o Claude Code de verdade (gasta centavos; ver abaixo)
PORT=3800 node scripts/dev.js # painel local com Redis em memória (sem Vercel)
npm run retrato               # imprime o retrato atual, sem enviar
node scripts/configurar.js https://<painel>.vercel.app   # gera senha, token e segredos em ~/.config/moises/
systemctl --user enable --now moises-coletor              # depois de copiar collector/systemd/ para ~/.config/systemd/user/
journalctl --user -u moises-coletor -f
```

Rodar `configurar.js` de novo gera **outro** `MOISES_TOKEN` e `SESSION_SECRET` (a senha é mantida): é preciso atualizar as variáveis na Vercel e publicar de novo.

Onde ficam os dados: Vercel (função em `iad1`) e Upstash Redis (região `iad1`, EUA). Sobem metadados e os textos da tabela acima, com segredos, e-mails, telefones, CPF e CNPJ mascarados; o retrato é sobrescrito a cada envio e expira em 24 h sem novo envio, o conteúdo de um comando é apagado do Redis na confirmação ou na expiração, e os logs ficam até sair dos 500 mais recentes. O deploy é pela CLI (`vercel deploy --prod`): o repositório não está ligado à Vercel.

Variáveis na Vercel: `PANEL_PASSWORD_HASH`, `SESSION_SECRET`, `MOISES_TOKEN` (de `~/.config/moises/vercel.env`) e `KV_REST_API_URL`/`KV_REST_API_TOKEN` (da integração Upstash). A senha do painel fica em `~/.config/moises/senha-painel.txt`.

## Configuração local da orquestração

Tudo isto é feito por você, no computador onde o coletor roda. O painel não consegue mudar nada daqui.

**1. Lista de projetos.** Sem ela, nenhum projeto pode ser aberto pelo painel. Crie `~/.config/moises/projetos.json` com `{"nome": "/caminho/absoluto"}`; o nome tem de casar com `[A-Za-z0-9._-]`, até 60 caracteres, e o caminho tem de ser absoluto:

```json
{ "site": "/home/<você>/projetos/site", "api": "/home/<você>/projetos/api" }
```

**Não ponha aqui a pasta do Moisés nem uma pasta que a contenha** (como `~/Documentos`): o painel recusa abrir ou retomar sessão nela ("Esta pasta contém o próprio Moisés; abra-a só pelo terminal."). Para trabalhar no próprio Moisés com o Claude Code, abra a sessão pelo terminal.

O coletor relê o arquivo a cada "abrir"; não precisa reiniciar. O `configurar-comandos.js` cria o arquivo com `{}` na primeira vez que você autoriza um aparelho, se ele não existir.

**2. Autorizar um aparelho.** Cada celular ou computador tem o seu par de chaves e pode ser revogado sozinho. **Nada secreto é digitado no painel**: o aparelho gera uma chave privada que não pode ser copiada, fica com ela e manda ao computador só a chave pública.

1. No aparelho, abra o painel, vá ao fim da página e toque em **"Autorizar este aparelho"**. Dê um nome ao aparelho (por exemplo, "Celular") e toque em "Pedir autorização". O painel mostra a **impressão digital** do aparelho (quatro grupos de quatro caracteres, como `a1b2-c3d4-e5f6-0718`) e o comando pronto para copiar.
2. No computador, o pedido chega no próximo ciclo do coletor (até 20 s; 3 s com o painel aberto) e vale por **1 hora**; há no máximo 5 pedidos esperando. Liste os pedidos e **confira se a impressão digital é a mesma que aparece no aparelho**:

```bash
node scripts/configurar-comandos.js --pedidos                        # kid, nome, impressão digital e hora de cada pedido
node scripts/configurar-comandos.js --autorizar <kid> <impressão>    # autoriza; a impressão digital é obrigatória
node scripts/configurar-comandos.js --listar                         # aparelhos autorizados: kid, nome, impressão digital e data
node scripts/configurar-comandos.js --revogar <kid>                  # tira o aparelho; vale no próximo comando, sem reiniciar
```

A impressão digital em `--autorizar` é o que garante que a chave gravada é a que o aparelho mostra: se o pedido tiver sido trocado no caminho, ela não confere, o script não grava nada e você **não deve autorizar**. A chave pública vai para `~/.config/moises/chaves-comandos.json` (600). Vale no próximo comando, sem reiniciar o coletor, e o painel passa a mostrar o aparelho como autorizado. Se já existir outro aparelho com o mesmo nome, o script avisa (revogue o antigo se for o mesmo aparelho de antes). "Esquecer este aparelho", no painel, apaga a chave no aparelho (o botão "Sair" do painel faz o mesmo); a autorização continua no computador até você rodar `--revogar <kid>`. Um aparelho esquecido só volta com uma nova autorização. Não toca em `coletor.env`, `vercel.env` nem `senha-painel.txt`. A pasta pode mudar com `MOISES_PASTA_CONF`, e a dos pedidos (`aparelhos-pedidos.json`) com `MOISES_ESTADO`.

**Aparelhos do formato antigo** (autorizados por código digitado, com `chave` em hexadecimal em `chaves-comandos.json`) **deixam de valer**: o coletor os ignora, avisa no log e `--listar` os marca como "formato antigo". Revogue cada um e autorize de novo pelo painel. Apague também os `codigo-<kid>.txt` que sobraram em `~/.config/moises/` (o script não os usa mais).

**3. Variáveis do coletor.** Vão em `~/.config/moises/coletor.env` (ou no ambiente, que tem precedência). Valor fora da faixa vale o padrão, com um aviso no log.

| Variável | Padrão | Faixa | O que faz |
|---|---|---|---|
| `MOISES_MAX_SESSOES` | 4 | 1 a 50 | sessões comandadas abertas ao mesmo tempo |
| `MOISES_MAX_ABRIR_DIA` | 20 | 0 a 1000 | aberturas pelo painel por dia (0 impede abrir) |
| `MOISES_TETO_SESSAO_USD` | 5 | 0,01 a 100 | gasto máximo de uma sessão comandada (`--max-budget-usd`) |
| `MOISES_FERRAMENTAS` | `Bash,Read,Edit,Write,Glob,Grep` | nomes separados por vírgula | ferramentas das sessões comandadas |
| `MOISES_PERMISSAO_EXPIRA_MIN` | 30 | 1 a 1440 | minutos até um pedido sem resposta ser negado |
| `MOISES_INTERVALO_MS` | 20000 | 1000 a 3600000 | intervalo normal de envio |
| `MOISES_INTERVALO_RAPIDO_MS` | 3000 | 1000 a 60000 | intervalo com o painel visto há menos de 60 s, com sessão comandada trabalhando ou esperando permissão, ou com confirmação a enviar |
| `MOISES_CHAVES_ARQ` | `~/.config/moises/chaves-comandos.json` | caminho | arquivo das chaves públicas dos aparelhos autorizados |
| `MOISES_PROJETOS` | `~/.config/moises/projetos.json` | caminho | lista de projetos que o painel pode abrir |
| `MOISES_CONFERIR_PAINEL` | ligado | `0` desliga | `0` desliga a conferência do painel publicado contra `public/` (só para desenvolvimento; sem ela, quem trocar o painel na Vercel não é percebido) |
| `MOISES_SO_PREFIXO` | (vazio) | texto | uso de teste: só vê e comanda sessões cujo nome começa por ele |

**Chaves de desligar.** Valem escritas no `coletor.env` (o ambiente do processo, se definido, vale por cima). O coletor as lê ao iniciar: depois de mudar o arquivo, reinicie o serviço.

| Variável | Padrão | O que faz |
|---|---|---|
| `MOISES_COMANDOS` | ligado | `0` recusa todo comando |
| `MOISES_SUBIR_TEXTO` | ligado | `0` não sobe resposta, primeiro pedido nem pedido de permissão |
| `MOISES_ENCERRAR` | ligado | `0` desliga o encerramento de sessões pelo painel |
| `MOISES_ENCERRAR_POR_HORA` | 5 | máximo de encerramentos por hora (`0` impede encerrar) |

Ao iniciar, o coletor registra no log se os comandos estão ligados ou desligados (e por quê), se sobe texto e se confere o painel (`journalctl --user -u moises-coletor -n 20`).

**4. Serviço.** A unidade em `collector/systemd/moises-coletor.service` usa `MemoryHigh=4G`. Se você instalou a versão antiga (400M), copie de novo para `~/.config/systemd/user/` e rode `systemctl --user daemon-reload`. Reiniciar o serviço encerra as sessões comandadas (retomáveis pelo painel). Para ver o que o coletor aceitou ou recusou: `~/.local/state/moises/auditoria.jsonl` (aceitos) e `auditoria-recusas.jsonl` (recusas).

## Ordem segura de publicação

O coletor novo, o painel novo e a autorização dos aparelhos precisam entrar nesta ordem:

1. **Atualize o código do coletor e reinicie-o** (`systemctl --user restart moises-coletor`; confira com `journalctl --user -u moises-coletor -n 20` a linha "comandos: desligados (sem_chave)" e, se ela aparecer, o aviso de aparelho do formato antigo ignorado).
2. **Publique o painel novo** (`vercel deploy --prod`), a partir da mesma versão do `public/` que está no computador do coletor. Se os dois diferirem, o coletor desliga os comandos (`painel_alterado`). Logo depois de publicar, a conferência pode levar até 10 min para religar; reiniciar o serviço confere na hora, mas encerra as sessões comandadas.
3. **Só então autorize os aparelhos** (passo 2 da configuração local): o aparelho pede pelo painel e você autoriza no computador com `--pedidos` e `--autorizar <kid> <impressão>`. Aparelhos do formato antigo precisam ser autorizados de novo.

Por quê: o coletor antigo executava `encerrar` **sem assinatura** e **não entende os verbos novos**. O servidor novo só entrega comandos a um coletor que anuncia o protocolo 2 (o que confere assinatura), então um coletor antigo diante do painel novo não recebe comando nenhum; mesmo assim, o certo é o coletor entrar primeiro. O coletor novo recusa todo comando enquanto não houver aparelho autorizado, e o servidor só aceita comando de aparelho que o coletor anunciou; por isso os aparelhos só são autorizados depois que ele está de pé e com o painel novo no ar. Entre os passos 1 e 2, o botão Encerrar do painel antigo é recusado (não tem assinatura); é um intervalo curto.

## Prova de ponta a ponta

`npm run e2e` exercita as cinco capacidades com o Claude Code de verdade. Sobe o painel local (`scripts/dev.js`, Redis em memória) e o coletor no próprio processo, com segredos e chave de aparelho gerados na hora (não lê `~/.config/moises` nem fala com o painel publicado), abre **uma** sessão `moises-teste-…` com Haiku e imprime uma linha `passou` ou `falhou` para cada item: abrir com um pedido, ver estado e última resposta, mandar mensagem e ver a resposta, aprovar e negar um pedido de permissão, interromper e encerrar, mais o custo da sessão. Sai com código 1 se algum falhar e confere no fim que não sobrou processo. Custa **alguns centavos de dólar** e leva alguns minutos.

Antes da primeira vez, crie a sandbox: **uma pasta própria, fora de `~/Documentos`, que seja repositório git**.

```bash
mkdir ~/moises-sandbox && cd ~/moises-sandbox && git init
```

O teste recusa outra pasta (`MOISES_E2E_SANDBOX` troca o caminho; `MOISES_E2E_VERBOSO=1` mostra a saída do painel). Rode-o depois de atualizar o Claude Code: o protocolo de controle que o coletor usa não está descrito no `--help`.

Contrato da API: [`docs/api.md`](docs/api.md). Plano e decisões: [`docs/plano.md`](docs/plano.md).
