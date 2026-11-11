# Plano de implementação: orquestração de sessões

> **Para quem executa:** siga `superpowers:subagent-driven-development` (ou `superpowers:executing-plans`), tarefa por tarefa, com teste antes do código (`superpowers:test-driven-development`). Os passos usam `- [ ]`.

**Objetivo:** o painel do Moisés abre, acompanha e dirige sessões do Claude Code na máquina do dono, com um canal de comandos que a nuvem não consegue forjar.

**Arquitetura:** o coletor abre cada sessão comandada como um processo `claude -p` em `stream-json` e conversa com ele por stdin/stdout (ADR-001, caminho B). Os comandos saem do navegador assinados com uma chave que só existe no aparelho e na máquina; o servidor e o Redis só transportam; o coletor confere assinatura, validade e repetição, registra em auditoria local e executa um verbo fixo.

**Stack:** Node.js >= 22, ESM, zero dependências, `node:test`. WebCrypto no navegador, `node:crypto` no coletor. Funções da Vercel em `api/`, site estático em `public/`, Upstash Redis por REST.

**Especificação:** `docs/orquestracao/BRIEFING.md`, `docs/orquestracao/ADR-001-orquestracao.md`, `docs/orquestracao/DIAGNOSTICO.md` e, para a interface, `docs/orquestracao/SPEC-interface.md`.

## Restrições globais

- Zero dependência nova. Nada de CDN, script ou estilo inline (CSP `default-src 'self'`).
- Nunca `bypassPermissions`, `--dangerously-skip-permissions` nem `--allow-dangerously-skip-permissions`, em código, teste ou opção de tela.
- O coletor só chama para fora. Nenhum `listen` em interface que não seja `127.0.0.1`, e só nos scripts de desenvolvimento.
- Nenhum texto vindo do painel vira argumento de linha de comando, nome de variável de ambiente ou caminho. Tudo passa por lista fechada ou expressão regular definida aqui.
- Segredos fora do repositório. Testes geram os próprios segredos em tempo de execução. Ninguém lê nem escreve em `~/.config/moises/` nem em `.env*` durante o desenvolvimento.
- Testes nunca tocam em `~/.local/state/moises`, `~/.claude*` nem em sessões reais. `npm test` não chama o `claude` de verdade.
- Texto livre que sai da máquina passa por `redigir()`. Nada de dado de sessão em log ou mensagem de erro.
- Redis: só chave ou campo novo. O campo do verbo continua se chamando `tipo` (um coletor antigo trata pedido sem `tipo` como encerrar).
- Identificadores, mensagens e comentários em português, no estilo do código existente. Commits pequenos, em português, só no ramo `feat/orquestracao`. Sem push.
- Linha de base: `npm test` → 27 testes, 23 passam, 4 falham (causa na tarefa 1).

## Critérios de aceite

- **CA1** `npm test`, `npm run lint` e `npm run build` terminam com código 0.
- **CA2** O coletor recusa comando sem assinatura, com assinatura errada, expirado, com data no futuro, repetido, de verbo desconhecido, e todos quando não há chave ou quando `MOISES_COMANDOS=0`.
- **CA3** Cada comando aceito e cada recusado geram uma linha em `auditoria.jsonl` (quando, quem, sessão, verbo, decisão, motivo ou resultado), sem o texto da mensagem; o arquivo tem permissão 600.
- **CA4** O servidor nunca devolve `dados` nem `assinatura` de um comando ao painel, e apaga os dois do Redis quando o coletor confirma o recebimento.
- **CA5** Toda sessão do retrato traz `estado` (`trabalhando`, `esperando_mensagem`, `esperando_permissao`, `parada`, `encerrada`), `ultimaResposta` e `tarefa` preenchida pela ordem: título, resumo, primeiro pedido, nome.
- **CA6** `abrir` só aceita projeto da lista local, conta conhecida, modelo, esforço e modo de permissão das listas fechadas, e monta os argumentos do `claude` sem nenhum texto do painel.
- **CA7** `mensagem`, `permissao` (aprovar e negar), `interromper`, `encerrar` e `retomar` funcionam numa sessão comandada; o processo filho não herda variáveis `CLAUDE*` nem `MOISES_*`.
- **CA8** O pedido de permissão chega ao painel com ferramenta, entrada e MAC; o painel só habilita "Aprovar" se o MAC conferir.
- **CA9** O painel mostra, por comando, enviado → recebido pelo coletor → executado (ou recusado, falhou, expirado), e desabilita as ações quando o coletor está fora do ar.
- **CA10** Encerrar e interromper pedem confirmação; abrir mostra um resumo do que vai ser aberto antes de enviar.
- **CA11** `npm run e2e` sobe painel e coletor locais, cria uma sessão `moises-teste-` na sandbox e imprime "passou" ou "falhou" para cada uma das cinco capacidades.

## Foco de revisão

1. **Comando assinado válido, repetido dentro da janela por quem controla o Redis.** Esperado: executa uma vez só; a segunda cópia é recusada e auditada. Teste na tarefa 3.
2. **Pedido de permissão respondido duas vezes ou depois de a sessão seguir em frente.** Esperado: a segunda resposta devolve erro claro e não afeta outro pedido. Teste na tarefa 6.
3. **Coletor reinicia com sessões comandadas abertas.** Esperado: os filhos morrem com ele, as sessões aparecem como encerradas e "Retomar" funciona; nada fica órfão. Teste na tarefa 6 (`fechar()`).
4. **Saída do `claude` fora do esperado** (linha que não é JSON, linha gigante, pedido de controle desconhecido, saída antes de responder). Esperado: o coletor não cai, responde erro ao pedido desconhecido e reporta a falha. Teste na tarefa 6.
5. **Relógio do celular errado.** Esperado: o comando é recusado com mensagem que diz para acertar o relógio, não com "assinatura inválida". Teste na tarefa 3.

## Mapa de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `collector/encerrar.js` | carrega os limites só no primeiro uso | 1 |
| `scripts/lint.js`, `scripts/build.js`, `package.json` | `npm run lint`, `npm run build`, `npm run e2e` | 1 |
| `public/assinatura.js` | derivar chave, assinar comando, conferir MAC (WebCrypto; módulo ES que também roda no Node) | 2 |
| `collector/assinatura.js` | o mesmo com `node:crypto`, síncrono | 2 |
| `collector/auditoria.js` | registro de auditoria local | 3 |
| `collector/comandos.js` | `Porteiro`: decide se um comando é aceito | 3 |
| `api/comando.js` (novo), `api/ingest.js`, `api/estado.js`, `api/_lib.js`; `api/encerrar.js` sai | transporte dos comandos | 4 |
| `collector/transcript.js`, `collector/sessoes.js` | primeiro pedido, última resposta, `estado` | 5 |
| `collector/orquestrador.js` | processos `claude` comandados e os seis verbos | 6 |
| `test/fixtures/claude-falso.js` | imita o protocolo `stream-json` nos testes | 6 |
| `collector/index.js`, `scripts/configurar-comandos.js` | laço, ritmo, configuração local | 7 |
| `public/index.html`, `public/app.js`, `public/style.css` | interface | 8 |
| `test/e2e/orquestracao.e2e.js` | prova com o Claude Code de verdade | 9 |
| `README.md`, `docs/api.md`, `docs/plano.md` | documentação | 10 |

Grupos para trabalho em paralelo (arquivos disjuntos): **G1** = tarefa 1; **G2** = tarefa 2; **G3** = tarefas 3, 4 e 5; **G4** = tarefas 6 e 8; **G5** = tarefa 7; **G6** = tarefas 9 e 10. Tarefas **sensíveis** (dev com `model: opus`, revisão do `seguranca`): 2, 3, 4, 6 e 7.

## Contrato comum

**Comando** (o que o navegador envia e o coletor recebe):

```json
{ "id": "c_0123456789abcdef", "tipo": "mensagem", "chave": "principal:<uuid>", "criadoEm": 1794387000000,
  "dados": "{\"texto\":\"...\"}", "assinatura": "<43 caracteres base64url>" }
```

- `id`: `/^c_[0-9a-f]{16}$/`. `tipo`: um de `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar`, `retomar`. `chave`: `null` em `abrir`; nos outros, `/^[a-z0-9]{1,20}:[0-9a-f-]{36}$/`. `criadoEm`: inteiro, relógio do navegador. `dados`: **string** JSON de até 20.000 caracteres. `assinatura`: HMAC-SHA256 em base64url sem `=`.
- Texto assinado: `['v1', id, tipo, chave ?? '', String(criadoEm), dados].join('\n')`.
- Chave: PBKDF2-SHA256 do código normalizado (minúsculas, só `[a-z0-9]`), sal `moises-comandos-v1`, 210.000 iterações, 32 bytes.
- MAC de permissão: HMAC-SHA256 de `['perm-v1', chave, pedido, ferramenta, entrada].join('\n')`.
- "Quem" na auditoria: `painel:` + 12 primeiros hexadecimais de SHA-256 de `'moises-quem-v1\n'` seguido dos bytes da chave.

**Dados por verbo** (depois do `JSON.parse`; campo fora da lista é erro de formato):

| Verbo | Dados |
|---|---|
| `abrir` | `projeto` (nome na lista local), `pedido` (1 a 8.000 caracteres), `conta?` (padrão `principal`), `modelo?` (`haiku`, `sonnet`, `opus`, `fable`), `esforco?` (`low`, `medium`, `high`, `xhigh`, `max`), `modoPermissao?` (`manual`, `acceptEdits`, `plan`; padrão `manual`), `worktree?` (booleano), `nome?` (`/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/`) |
| `mensagem` | `texto` (1 a 8.000 caracteres) |
| `permissao` | `pedido` (id do pedido, 1 a 80 caracteres), `decisao` (`aprovar` ou `negar`) |
| `interromper` | `{}` |
| `encerrar` | `nome?` (até 140 caracteres, nome do log) |
| `retomar` | `modoPermissao?`, `modelo?`, `esforco?` |

**Estados de um comando no servidor:** `pendente` → `recebido` → `feito` \| `falhou`; ou `pendente` → `recusado` \| `expirado`.

**Campos novos do retrato:** em cada sessão, `estado`, `ultimaResposta`, `ultimaRespostaEm`, `gerenciada` (booleano) e `permissoes` (lista de `{pedido, ferramenta, entrada, cortado, mac}`; vazia se não houver). No topo, `orquestracao: { ativa, projetos: [nomes], contas: [nomes], modelos, esforcos, modos, maxSessoes, abertas }`.

---

### Tarefa 1: testes isolados da produção, lint e build

**Arquivos:** modificar `collector/encerrar.js`, `test/coletor.test.js`, `package.json`; criar `scripts/lint.js`, `scripts/build.js`, `test/scripts.test.js`.

**Interfaces — produz:** `npm run lint`, `npm run build`, `npm run e2e` (`node test/e2e/orquestracao.e2e.js`); `collector/encerrar.js` passa a ler `MOISES_LIMITES_ARQ` no primeiro uso, não na importação.

- [ ] **Passo 1: teste que falha.** Em `test/coletor.test.js`, novo teste `encerrar usa o arquivo de limites definido depois da importação`: define `process.env.MOISES_LIMITES_ARQ` para um arquivo numa pasta temporária, executa um `executarEncerrar` com id novo e confere que esse arquivo passou a existir. Hoje falha (o módulo já fixou o caminho real).
- [ ] **Passo 2:** `node --test test/coletor.test.js` → o teste novo e os 4 antigos falham.
- [ ] **Passo 3:** em `collector/encerrar.js`, trocar a leitura no topo do módulo por uma função interna que carrega `executados` e `recentes` na primeira chamada de `executarEncerrar`, lendo `process.env.MOISES_LIMITES_ARQ` nesse momento. Exportar `reiniciarLimites()` (esquece o que está em memória; uso em teste).
- [ ] **Passo 4:** `node --test test/coletor.test.js` → 23 testes, 0 falhas.
- [ ] **Passo 5: lint e build.** `scripts/lint.js`: percorre `api/`, `collector/`, `public/`, `scripts/` e `test/`, roda `node --check` em cada `.js` e sai com 1 se algum falhar, imprimindo `lint: N arquivos, 0 erros`. `scripts/build.js`: confere que `vercel.json` é JSON válido com `outputDirectory: "public"`, que `public/index.html` e `public/login.html` existem, que todo `<script src>` e `<link href>` locais apontam para arquivo existente e que cada `api/*.js` que não começa com `_` importa e tem `default` do tipo função; imprime `build: ok (N rotas, M arquivos estáticos)`. Teste `test/scripts.test.js`: executa os dois com `execFileSync` e confere código 0 e a linha final.
- [ ] **Passo 6:** `npm test && npm run lint && npm run build` → código 0.
- [ ] **Passo 7:** commit `Testes deixam de gravar no estado de produção; lint e build sem dependências`.

### Tarefa 2 (sensível): assinatura no navegador e no coletor

**Arquivos:** criar `public/assinatura.js`, `collector/assinatura.js`, `test/assinatura.test.js`.

**Interfaces — produz:**

```js
// public/assinatura.js (módulo ES; usa só globalThis.crypto)
export async function derivarChave(codigo)                       // → Uint8Array(32)
export function textoDoComando({ id, tipo, chave, criadoEm, dados }) // → string
export async function assinarComando(chaveBytes, { tipo, chave = null, dados = {} }, agora = Date.now())
  // → { id, tipo, chave, criadoEm, dados: JSON.stringify(dados), assinatura }
export function textoDaPermissao({ chave, pedido, ferramenta, entrada }) // → string
export async function conferirMac(chaveBytes, texto, mac)        // → boolean
export function paraHex(bytes) / export function deHex(hex)

// collector/assinatura.js (node:crypto, síncrono)
export function derivarChave(codigo)            // → Buffer(32)
export function textoDoComando(cmd)             // mesma regra
export function assinaturaConfere(chave, cmd)   // → boolean; timingSafeEqual; false para qualquer formato inválido
export function textoDaPermissao(p)             // mesma regra
export function mac(chave, texto)               // → base64url
export function quem(chave)                     // → 'painel:<12 hex>'
```

- [ ] **Passo 1: testes que falham** em `test/assinatura.test.js`: (a) `derivarChave('abcd-efgh-jkmn-pqrs')` dá o mesmo resultado nos dois módulos e ignora maiúsculas, espaços e hífens; (b) um comando assinado por `public/assinatura.js` passa em `assinaturaConfere`; (c) trocar um caractere de `dados`, de `tipo`, de `chave` ou de `criadoEm` faz falhar; (d) `assinaturaConfere` devolve `false`, sem lançar, para assinatura ausente, vazia, de tamanho errado ou que não é string; (e) `mac` do coletor confere em `conferirMac` do navegador e falha se a `entrada` mudar; (f) `textoDoComando` com `chave: null` usa string vazia.
- [ ] **Passo 2:** `node --test test/assinatura.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar os dois módulos conforme o "Contrato comum".
- [ ] **Passo 4:** `node --test test/assinatura.test.js` → passa.
- [ ] **Passo 5:** commit `Assinatura de comandos: mesma regra no navegador e no coletor`.

### Tarefa 3 (sensível): porteiro e auditoria

**Arquivos:** criar `collector/auditoria.js`, `collector/comandos.js`, `test/canal-comandos.test.js`.

**Interfaces — consome:** `collector/assinatura.js`. **Produz:**

```js
// collector/auditoria.js
export class Auditoria {
  constructor({ arquivo, agora = () => Date.now(), maxBytes = 5_000_000 })
  registrar({ id, tipo, chave, quem, decisao, motivo = null, resultado = null }) // uma linha JSON; nunca lança
}
// linha: { em: ISO, id, tipo, sessao, quem, decisao: 'aceito'|'recusado'|'feito'|'falhou', motivo, resultado }
// arquivo criado com modo 0o600; ao passar de maxBytes vira <arquivo>.1 (substitui o anterior)

// collector/comandos.js
export const TIPOS; export const JANELA_MS = 120_000; export const FOLGA_FUTURO_MS = 30_000;
export class Porteiro {
  constructor({ chave /* Buffer | null */, pastaEstado, auditoria, agora = () => Date.now(), maxPorMinuto = 30 })
  conferir(cmd) // → { ok: true, dados } | { ok: false, motivo, erro }
  concluir(cmd, { ok, erro })   // audita 'feito' ou 'falhou'
}
```

Ordem das conferências e `motivo` de cada recusa: `MOISES_COMANDOS=0` → `desligado`; sem chave → `sem_chave`; `id`, `tipo`, `criadoEm` ou `dados` fora do formato → `formato`; `assinatura` ausente → `sem_credencial`; verbo fora de `TIPOS` → `verbo`; assinatura não confere → `assinatura`; `agora - criadoEm >= JANELA_MS` → `expirado`; `criadoEm - agora > FOLGA_FUTURO_MS` → `relogio` (erro: "O relógio do aparelho está adiantado; acerte a hora e tente de novo."); id já visto → `repetido`; mais de `maxPorMinuto` aceitos no último minuto → `ritmo`; `dados` não é JSON de objeto ou foge da tabela do verbo → `formato`. Os ids aceitos ficam em `<pastaEstado>/comandos-vistos.json` (gravação por arquivo temporário e `rename`; guarda os 2.000 mais recentes) e são relidos na construção. Campos de texto que vão para a auditoria são cortados em 80 caracteres e têm caracteres de controle removidos; `dados` nunca é registrado.

- [ ] **Passo 1: testes que falham** em `test/canal-comandos.test.js`, com chave e pasta temporárias e relógio injetado. Um teste por linha: `recusa comando sem credencial`; `recusa assinatura feita com outra chave`; `recusa comando expirado (criado há 120 s)`; `recusa comando com data 31 s no futuro e diz que é o relógio`; `aceita uma vez e recusa o mesmo comando repetido`; `a repetição é recusada mesmo depois de reiniciar o porteiro` (segunda instância na mesma pasta); `recusa verbo desconhecido mesmo com assinatura válida`; `recusa tudo sem chave configurada`; `recusa tudo com MOISES_COMANDOS=0`; `recusa dados fora da tabela do verbo` (campo extra, `pedido` vazio, `modoPermissao: 'bypassPermissions'`, `projeto` com `/`); `recusa o 31º comando aceito no mesmo minuto`; `cada comando aceito fica na auditoria com quem, quando, sessão, verbo e decisão`; `cada recusa fica na auditoria com o motivo`; `a auditoria não contém o texto da mensagem`; `o arquivo de auditoria tem permissão 600`; `concluir registra feito ou falhou`; `auditoria gira o arquivo ao passar do limite`.
- [ ] **Passo 2:** `node --test test/canal-comandos.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar `Auditoria` e `Porteiro`.
- [ ] **Passo 4:** `node --test test/canal-comandos.test.js` → passa.
- [ ] **Passo 5:** commit `Porteiro dos comandos: assinatura, validade, repetição e auditoria local`.

### Tarefa 4 (sensível): transporte no servidor

**Arquivos:** criar `api/comando.js`; modificar `api/ingest.js`, `api/estado.js`, `api/_lib.js`, `scripts/redis-memoria.js` (se faltar comando), `test/api.test.js`, `docs/api.md`; apagar `api/encerrar.js`.

**Interfaces — produz:**

- `POST /api/comando` (cookie e JSON obrigatórios). Corpo: o comando do "Contrato comum". `400` se algum campo foge do formato (o servidor confere formato e tamanho; **não** confere assinatura, pois não tem a chave); `409` se o `id` já existe; `429` se já há 20 comandos `pendente`; `200 {"id"}`. Grava `{id, tipo, chave, criadoEm, dados, assinatura, estado: 'pendente', erro: null, recebidoNoServidorEm}`.
- `POST /api/ingest`: devolve `{comandos: [{id, tipo, chave, criadoEm, dados, assinatura, idadeMs}], painelVistoEm}`; `idadeMs` conta de `recebidoNoServidorEm` (ou de `criadoEm`, se o campo não existir). Aceita acks `{id, estado: 'recebido'|'feito'|'falhou'|'recusado', erro, log, chaveNova}` e, por compatibilidade, `{id, ok, erro, log}`. Em qualquer ack, apaga `dados` e `assinatura` do comando guardado. `chaveNova` (formato de `chave`) é gravada no comando como `chave` quando o `tipo` é `abrir`. Comando `recebido` há mais de 10 min vira `falhou` com erro "O coletor não confirmou o resultado.". O log do Histórico continua valendo só para `encerrar` com `log`.
- `GET /api/estado`: grava `moises:painelVistoEm` e devolve `comandos: [{id, tipo, chave, estado, erro, criadoEm}]`.
- `K.painelVistoEm = 'moises:painelVistoEm'` em `api/_lib.js`.

- [ ] **Passo 1: testes que falham** em `test/api.test.js`: `comando exige cookie e JSON`; `comando recusa formato inválido` (id, tipo fora da lista, `dados` que não é string, `dados` com 20.001 caracteres, assinatura curta, `chave` ausente em `mensagem`, `chave` presente em `abrir`); `comando com id repetido dá 409`; `o 21º comando pendente dá 429`; `ingest entrega o comando com dados e assinatura e o estado nunca os devolve`; `ack recebido apaga dados e assinatura do Redis`; `ack feito de abrir grava a chave nova`; `ack recusado guarda o erro`; `comando recebido há 10 min sem resultado vira falhou`; `estado grava painelVistoEm e o ingest devolve`; adaptar o teste do fluxo de encerrar para `POST /api/comando` com `tipo: 'encerrar'` e conferir o log no Histórico; adaptar o teste de expiração.
- [ ] **Passo 2:** `node --test test/api.test.js` → falhas novas.
- [ ] **Passo 3:** implementar. Remover `api/encerrar.js`.
- [ ] **Passo 4:** `node --test test/api.test.js` → passa. `npm run build` → ok.
- [ ] **Passo 5:** atualizar `docs/api.md` (rota nova, acks, campos novos do retrato, remoção de `/api/encerrar`).
- [ ] **Passo 6:** commit `API: rota única de comandos assinados e estados recebido/recusado`.

### Tarefa 5: estado ao vivo, última resposta e tarefa

**Arquivos:** modificar `collector/transcript.js`, `collector/sessoes.js`, `test/coletor.test.js`.

**Interfaces — produz:**

```js
// transcript.js: novoEstado() ganha primeiroPedido, ultimaResposta, ultimaRespostaEm (null no início)
// sessoes.js
export function estadoDe(reg, vivo, agora = Date.now())
  // → 'trabalhando' | 'esperando_permissao' | 'esperando_mensagem' | 'parada' | 'encerrada'
Coletor.prototype.cwdDe(chavePainel) // → caminho absoluto do registro vivo ou do transcript, ou null
// cada sessão do retrato ganha: estado, ultimaResposta (redigir, 1200), ultimaRespostaEm, gerenciada: false, permissoes: []
// tarefa = redigir(tituloIA || resumo || primeiroPedido || nome, 140)
```

Regras: `primeiroPedido` é o texto da primeira linha `type: "user"` do transcript principal que não seja `isSidechain`, nem `isMeta`, cujo conteúdo seja string ou tenha bloco `text` (blocos `tool_result` não contam) e que não comece com `<`. `ultimaResposta` é o último bloco `text` de uma linha `assistant` do principal, fora de `isSidechain` e com modelo diferente de `<synthetic>`. Os dois são cortados em 4.000 caracteres ao ler. `estadoDe`: processo morto → `encerrada`; `status` `busy`, `shell` ou `running` → `trabalhando`; `status` `waiting` com `waitingFor` contendo `perm`, `sandbox` ou `worker` → `esperando_permissao`; outro `waiting` → `esperando_mensagem`; demais: parado há mais de 15 min → `parada`, senão `esperando_mensagem`. `status` (campo antigo) não muda.

- [ ] **Passo 1: testes que falham** em `test/coletor.test.js`: `estado ao vivo a partir do registro` (uma asserção por regra acima); `transcript guarda o primeiro pedido e a última resposta` (com linhas de `tool_result`, sidechain e meta no meio, que não podem contar); `tarefa cai para o primeiro pedido e depois para o nome`; `última resposta sai mascarada e cortada em 1200` (texto com `sk-…` e 3.000 caracteres); `cwdDe devolve a pasta da sessão viva e da encerrada`.
- [ ] **Passo 2:** `node --test test/coletor.test.js` → falhas novas.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `node --test test/coletor.test.js` → passa.
- [ ] **Passo 5:** commit `Coletor: estado ao vivo, última resposta e tarefa pelo primeiro pedido`.

### Tarefa 6 (sensível): orquestrador

**Arquivos:** criar `collector/orquestrador.js`, `test/fixtures/claude-falso.js`, `test/orquestrador.test.js`; modificar `collector/encerrar.js` (exportar a montagem do log).

**Interfaces — consome:** `Coletor` (`dirs`, `sessaoDe`, `cwdDe`, `registros`), `nomeConta`, `executarEncerrar`, `mac`, `textoDaPermissao`, `redigir`. **Produz:**

```js
export const MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODOS = ['manual', 'acceptEdits', 'plan'];
export class Orquestrador {
  constructor({ coletor, chaveMac, projetos /* () => ({ nome: caminho }) */, claudeBin = 'claude', argsExtra = [],
                maxSessoes = 4, soPrefixo = null, agora = () => Date.now(), esperaAberturaMs = 30_000 })
  async executar(cmd, dados)  // → { ok: true, chaveNova?, log? } | { ok: false, erro }
  aplicar(retrato)            // marca gerenciada, estado e permissoes nas sessões comandadas; preenche retrato.orquestracao; devolve o retrato
  abertas()                   // → número de processos vivos
  async fechar()              // encerra todos os filhos (fim do serviço)
}
// collector/encerrar.js
export function logDeEncerramento(sessao, nome, fim) // o objeto `log` que executarEncerrar já monta
```

Decisões que não cabem na assinatura:

- **Argumentos do filho**, nesta ordem: `-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`, depois `--session-id <uuid gerado>` (abrir) ou `--resume <sessionId>` (retomar), `--permission-mode <modo>`, e, se vierem, `--model`, `--effort`, `--name`, `-w <nome>`; por fim `argsExtra`. Na construção, o orquestrador lança erro se `argsExtra` contiver `bypassPermissions`, `--dangerously-skip-permissions` ou `--allow-dangerously-skip-permissions`. O pedido inicial nunca vai em argumento: vai pelo stdin.
- **Ambiente do filho:** cópia de `process.env` sem as chaves que começam com `CLAUDE` ou `MOISES_`; `CLAUDE_CONFIG_DIR=<pasta>` só quando a conta não é `principal`.
- **Pasta:** `fs.realpathSync` do caminho da lista; tem de ser diretório. Em `retomar`, a pasta da sessão (`cwdDe`) resolvida tem de ser igual a um caminho da lista ou estar dentro de `<caminho>/.claude/worktrees/`.
- **Nome do worktree:** o `nome` com tudo fora de `[A-Za-z0-9._-]` trocado por `-`; sem `nome`, `moises-<8 hex do uuid>`.
- **Entrada:** `{"type":"user","message":{"role":"user","content":<texto>}}` por linha.
- **Saída:** uma linha JSON por evento. `control_request` com `request.subtype === 'can_use_tool'` entra na lista de permissões pendentes (`pedido` = `request_id`); qualquer outro `control_request` recebe `{"type":"control_response","response":{"subtype":"error","request_id":…,"error":"não suportado"}}`. `result` → `esperando_mensagem`. Linha que não é JSON é ignorada e contada; linha com mais de 5 MB é descartada. Do stderr ficam os últimos 2.000 caracteres.
- **Estado de uma sessão comandada:** `trabalhando` depois de cada mensagem enviada; `esperando_permissao` enquanto houver pedido pendente; `esperando_mensagem` depois de `result`.
- **Permissão publicada:** `entrada` = o comando, se a ferramenta for `Bash`, senão `JSON.stringify(input)`; passa por `redigir(…, 2000)`; `cortado` é verdadeiro se o texto original tinha mais de 2.000 caracteres; `mac` = `mac(chaveMac, textoDaPermissao({chave, pedido, ferramenta, entrada}))`.
- **Respostas:** aprovar → `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":<input original>}}}`; negar → `"response":{"behavior":"deny","message":"Negado pelo painel."}`. Interromper → `{"type":"control_request","request_id":"int_<hex>","request":{"subtype":"interrupt"}}`; as permissões pendentes são descartadas.
- **Abrir** resolve com `{ok: true, chaveNova: '<conta>:<uuid>'}` quando chega o primeiro evento do filho; falha com o fim do stderr mascarado se o filho sair antes; falha depois de `esperaAberturaMs`, matando o filho.
- **Retomar** resolve quando chega o primeiro evento ou depois de 5 s com o filho vivo.
- **Encerrar** sessão comandada: fecha o stdin; se não sair em 10 s, `SIGTERM`; mais 5 s, `SIGKILL`; devolve `log` por `logDeEncerramento`. Sessão que não é comandada: delega a `executarEncerrar(coletor, {id, chave, nome, idadeMs})`.
- **Recusas com `erro` em português:** projeto fora da lista; conta desconhecida; teto de sessões (`maxSessoes`) atingido; sessão não é comandada (para `mensagem`, `permissao`, `interromper`); pedido de permissão que não está mais pendente; sessão ainda aberta (para `retomar`); com `soPrefixo`, qualquer sessão cujo nome não comece pelo prefixo (em `abrir`, o `nome` é obrigatório e tem de começar por ele).

`test/fixtures/claude-falso.js`: executável Node que grava seus `argv` e seu ambiente num arquivo indicado por `FALSO_REGISTRO`, lê linhas do stdin e responde: texto com `permissao:<comando>` → emite `can_use_tool` para `Bash` e, com `allow`, um `result` "feito", com `deny`, um `result` "negado"; texto `demora` → não responde até receber `interrupt`, então emite `result` com `subtype: "error_during_execution"`; texto `lixo` → emite uma linha que não é JSON e um `control_request` de subtipo desconhecido antes do `result`; texto `morre` → sai com código 3 escrevendo no stderr; qualquer outro texto → `system/init` e `result` com o próprio texto. Com `FALSO_SAI_NA_HORA=1`, sai com código 2 antes de ler.

- [ ] **Passo 1: testes que falham** em `test/orquestrador.test.js` (com `claudeBin` apontando para o falso e pastas temporárias): `abrir monta os argumentos sem texto do painel e sem bypass`; `o filho não herda CLAUDE* nem MOISES_*, e a conta secundária recebe CLAUDE_CONFIG_DIR`; `abrir recusa projeto fora da lista, conta desconhecida e o que passa do teto`; `mensagem chega ao filho e o estado volta a esperando_mensagem`; `pedido de permissão aparece com ferramenta, entrada e MAC que confere`; `aprovar e negar respondem ao pedido certo`; `responder duas vezes ao mesmo pedido dá erro`; `interromper devolve a sessão a esperando_mensagem`; `encerrar fecha o filho e devolve o log`; `encerrar de sessão não comandada delega ao encerrar antigo` (com `kill` injetado); `retomar recusa sessão aberta e pasta fora da lista`; `retomar usa --resume com o mesmo id`; `saída inesperada não derruba o orquestrador`; `filho que morre no meio some das abertas e o erro é reportado`; `fechar encerra todos os filhos`; `soPrefixo recusa sessão de outro nome`; `argsExtra com bypass faz o construtor lançar`.
- [ ] **Passo 2:** `node --test test/orquestrador.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `node --test test/orquestrador.test.js` → passa; `npm test` → tudo passa.
- [ ] **Passo 5:** commit `Orquestrador: sessões comandadas por stream-json e os seis verbos`.

### Tarefa 7 (sensível): laço do coletor e configuração local

**Arquivos:** modificar `collector/index.js`; criar `scripts/configurar-comandos.js`, `test/laco.test.js`.

**Interfaces — consome:** `Porteiro`, `Auditoria`, `Orquestrador`, `derivarChave`. **Produz:**

```js
// collector/index.js
export function lerProjetos(arquivo)   // → { nome: caminho }; {} se o arquivo faltar ou for inválido; só nomes /^[A-Za-z0-9._-]{1,60}$/ e caminhos absolutos
export function proximoIntervalo({ painelVistoEm, abertas, acksPendentes, agora, lento, rapido }) // → ms
export async function tratarComandos({ comandos, porteiro, orquestrador, acks, aoTerminar }) // enfileira acks; não bloqueia o laço
```

Decisões:

- Configuração lida de `coletor.env` (ou do ambiente): `MOISES_CHAVE_COMANDOS` (64 hexadecimais; qualquer outro valor conta como ausente), `MOISES_PROJETOS` (padrão `~/.config/moises/projetos.json`), `MOISES_MAX_SESSOES` (padrão 4), `MOISES_INTERVALO_RAPIDO_MS` (padrão 3.000), `MOISES_CLAUDE_ARGS_EXTRA` (lista JSON de strings; só do ambiente do processo), `MOISES_SO_PREFIXO`. A lista de projetos é relida a cada `abrir`.
- `proximoIntervalo`: `rapido` se o painel foi visto há menos de 60 s, se há sessão comandada aberta ou se há ack na fila; senão `lento`.
- `tratarComandos`: para cada comando, `porteiro.conferir`; recusado → ack `{id, estado: 'recusado', erro}`; aceito → ack `{id, estado: 'recebido'}` na hora e execução sem esperar; ao terminar, ack `{id, estado: 'feito'|'falhou', erro, log, chaveNova}`, `porteiro.concluir` e `aoTerminar()` (acorda o laço). Comando sem `tipo` é recusado (não é mais tratado como encerrar).
- O retrato passa por `orquestrador.aplicar` antes do envio; a assinatura de mudança do retrato inclui `estado`, `ultimaRespostaEm` e os ids das permissões. Com `MOISES_SO_PREFIXO`, o retrato só leva sessões cujo nome começa pelo prefixo.
- `SIGTERM` e `SIGINT`: `orquestrador.fechar()` e sair.
- `scripts/configurar-comandos.js`: gera o código (4 grupos de 4 do alfabeto `abcdefghjkmnpqrstuvwxyz23456789`, com `crypto.randomInt`), grava `codigo-comandos.txt` (600), acrescenta ou troca **só** a linha `MOISES_CHAVE_COMANDOS=` em `coletor.env`, cria `projetos.json` com `{}` se não existir e imprime os caminhos (nunca o código). Pasta em `MOISES_PASTA_CONF` (padrão `~/.config/moises`). Com `--manter`, reaproveita o código existente.

- [ ] **Passo 1: testes que falham** em `test/laco.test.js`: `lerProjetos ignora nome ou caminho inválido e arquivo ausente`; `proximoIntervalo` (quatro casos); `tratarComandos recusa sem credencial e não executa` (orquestrador espião); `tratarComandos confirma o recebimento antes do resultado e depois o resultado`; `comando sem tipo é recusado`; `configurar-comandos grava os três arquivos com permissão 600, preserva as outras linhas do coletor.env e não imprime o código` (rodando o script com `MOISES_PASTA_CONF` temporária); `a chave gravada é a derivada do código gravado`.
- [ ] **Passo 2:** `node --test test/laco.test.js` → falha.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test && npm run lint && npm run build` → código 0.
- [ ] **Passo 5:** commit `Coletor: comandos assinados no laço, ritmo rápido com o painel aberto e configuração local`.

### Tarefa 8: interface

**Arquivos:** modificar `public/index.html`, `public/app.js`, `public/style.css`. Segue `docs/orquestracao/SPEC-interface.md`.

**Interfaces — consome:** `public/assinatura.js`, `POST /api/comando`, campos novos do retrato e de `comandos`.

Decisões: `app.js` passa a ser carregado com `type="module"`. A chave derivada fica onde a spec e a revisão de segurança definirem (ver `ACHADOS.md`); o código nunca é guardado. Todo comando sai por uma função única `enviarComando(tipo, chave, dados)`, que pede o código se o aparelho ainda não tem a chave. O botão "Aprovar" só é habilitado depois de `conferirMac` devolver verdadeiro; se falhar, o bloco mostra "Não foi possível conferir este pedido" e só deixa negar. Encerrar e interromper pedem confirmação. Com o coletor fora do ar (`recebidoEm` com mais de 2 min) ou `orquestracao.ativa` falso, as ações ficam desabilitadas com o motivo escrito.

- [ ] **Passo 1:** implementar conforme a spec.
- [ ] **Passo 2:** `npm run lint && npm run build` → ok; conferir no navegador com `node scripts/dev.js` (roteiro na spec).
- [ ] **Passo 3:** commit `Painel: estado ao vivo, mensagem, permissão, ações e nova sessão`.

### Tarefa 9: prova de ponta a ponta

**Arquivos:** criar `test/e2e/orquestracao.e2e.js`; ajustar `scripts/dev.js` para não exigir `~/.config/moises/vercel.env` quando as variáveis já vêm do ambiente.

Sobe `scripts/dev.js` e `collector/index.js` como processos filhos, com segredos gerados na hora, `MOISES_ESTADO` temporário, `MOISES_PROJETOS` apontando só para `~/moises-sandbox`, `MOISES_SO_PREFIXO=moises-teste-`, `MOISES_IDEIAS_TETO_DIA=0`, intervalos de 1 s e `MOISES_CLAUDE_ARGS_EXTRA` com Haiku, sem ferramentas além de `Bash`, sem configurações do usuário e `--max-budget-usd 0.30`. Fala com o painel só por HTTP (login, `POST /api/comando` assinado por `public/assinatura.js`, `GET /api/estado`). Imprime uma linha por capacidade: `1. abrir sessão com um pedido: passou`, `2. ver estado e última resposta`, `3. enviar mensagem e ver a resposta`, `4. aprovar e negar um pedido de permissão`, `5. interromper e encerrar`, mais o custo somado. Sai com 1 se algum item falhar. No fim, encerra os filhos e confere que não sobrou processo da sessão.

- [ ] **Passo 1:** escrever e rodar `npm run e2e` → cinco linhas "passou".
- [ ] **Passo 2:** commit `Teste de ponta a ponta das cinco capacidades com o Claude Code de verdade`.

### Tarefa 10: documentação

**Arquivos:** `README.md` (como funciona, o que sai da máquina, configuração dos comandos e da lista de projetos, `npm run e2e`), `docs/api.md` (conferir), `docs/plano.md` (apontar para a ADR-001), `CLAUDE.md` (comandos de verificação e número de testes).

- [ ] **Passo 1:** atualizar e conferir os comandos citados rodando cada um.
- [ ] **Passo 2:** commit `Docs: orquestração, canal de comandos e o que sai da máquina`.
