# Plano de implementação: orquestração de sessões

> **Para quem executa:** siga `superpowers:subagent-driven-development` (ou `superpowers:executing-plans`), tarefa por tarefa, com teste antes do código (`superpowers:test-driven-development`). Os passos usam `- [ ]`.
>
> **Versão 2 (11/11/2026):** incorpora a revisão de segurança do desenho (achados S1 a S13 em `ACHADOS.md`). A tarefa 1 já está feita.

**Objetivo:** o painel do Moisés abre, acompanha e dirige sessões do Claude Code na máquina do dono, com um canal de comandos que o Redis, o cookie e o token do coletor não conseguem forjar.

**Arquitetura:** o coletor abre cada sessão comandada como um processo `claude -p` em `stream-json`, isolado das configurações do usuário (`--restricted`), e conversa com ele por stdin/stdout (ADR-001, caminho B). Os comandos saem do navegador assinados com uma chave por aparelho, que não pode ser extraída do navegador; o servidor e o Redis só transportam; o coletor confere assinatura, validade, repetição e o que o dono viu na tela, registra em auditoria local e executa um verbo fixo.

**Stack:** Node.js >= 22, ESM, zero dependências, `node:test`. WebCrypto e IndexedDB no navegador, `node:crypto` no coletor. Funções da Vercel em `api/`, site estático em `public/`, Upstash Redis por REST.

**Especificação:** `docs/orquestracao/BRIEFING.md`, `docs/orquestracao/ADR-001-orquestracao.md`, `docs/orquestracao/DIAGNOSTICO.md`, `docs/orquestracao/ACHADOS.md` e, para a interface, `docs/orquestracao/SPEC-interface.md`.

## Restrições globais

- Zero dependência nova. Nada de CDN, script ou estilo inline (CSP `default-src 'self'`).
- Nunca `bypassPermissions`, `--dangerously-skip-permissions` nem `--allow-dangerously-skip-permissions`, em código, teste ou opção de tela.
- O coletor só chama para fora. Nenhum `listen` em interface que não seja `127.0.0.1`, e só nos scripts de desenvolvimento.
- Nenhum texto vindo do painel vira argumento de linha de comando, nome de variável de ambiente ou caminho. Tudo passa por lista fechada ou expressão regular definida aqui. Todo argumento com valor usa a forma `--flag=valor`. `spawn` sempre sem shell.
- Segredos fora do repositório e fora de variáveis de ambiente: a chave de comandos só existe em arquivo com permissão 600. Testes geram os próprios segredos em tempo de execução. Ninguém lê nem escreve em `~/.config/moises/` nem em `.env*` durante o desenvolvimento.
- Testes nunca tocam em `~/.local/state/moises`, `~/.claude*` nem em sessões reais. `npm test` não chama o `claude` de verdade.
- Texto livre que sai da máquina passa por `redigir()` ou `redigirBloco()`. Nada de texto de sessão, de mensagem ou de pedido de permissão em log, em erro ou na auditoria.
- No painel: nenhum `innerHTML`, `outerHTML`, `insertAdjacentHTML` nem `href` montado com conteúdo; texto de sessão é sempre `textContent`.
- Redis: só chave ou campo novo. O campo do verbo continua se chamando `tipo`.
- Identificadores, mensagens e comentários em português, no estilo do código existente. Commits pequenos, em português, só no ramo `feat/orquestracao`, terminando com `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Sem push. Nunca `git add -A` (outros agentes trabalham na mesma pasta): adicione só os seus arquivos.
- Linha de base depois da tarefa 1: `npm test` → 33 testes, 0 falhas; `npm run lint` → 0 erros; `npm run build` → ok.

## Critérios de aceite

- **CA1** `npm test`, `npm run lint` e `npm run build` terminam com código 0.
- **CA2** O coletor recusa comando sem assinatura, com assinatura errada, de aparelho desconhecido, expirado, com data no futuro, repetido, de verbo desconhecido, de versão desconhecida, e todos quando não há chave ou quando `MOISES_COMANDOS=0`.
- **CA3** Cada comando aceito e cada recusado geram uma linha em `auditoria.jsonl` (quando, quem = aparelho, sessão, verbo, decisão, motivo ou resultado), sem o texto da mensagem; o arquivo tem permissão 600.
- **CA4** O servidor nunca devolve `dados` nem `assinatura` de um comando ao painel, e apaga os dois do Redis quando o coletor confirma o recebimento e quando o comando expira.
- **CA5** Toda sessão do retrato traz `estado` (`trabalhando`, `esperando_mensagem`, `esperando_permissao`, `parada`, `encerrada`), `ultimaResposta` e `tarefa` preenchida pela ordem: título, resumo, primeiro pedido, nome.
- **CA6** `abrir` só aceita projeto da lista local, conta conhecida, modelo, esforço e modo de permissão das listas fechadas; os argumentos do `claude` são montados sem nenhum texto do painel e sempre com `--restricted`, `--strict-mcp-config`, `--disable-slash-commands` e teto de gasto local.
- **CA7** `mensagem`, `permissao` (aprovar e negar), `interromper`, `encerrar` e `retomar` funcionam numa sessão comandada; o ambiente do filho é uma lista branca (sem `MOISES_*`, sem `CLAUDE*` além de `CLAUDE_CONFIG_DIR` de conta secundária, sem `SSH_AUTH_SOCK`).
- **CA8** Aprovar pelo painel só vale se o pedido foi publicado inteiro (`completo`) e se o `vistoHash` assinado bate com o que o coletor publicou; qualquer comando sobre uma sessão só vale se o projeto e o nome que o dono viu (`visto`) batem com a sessão real.
- **CA9** O painel mostra, por comando, enviado → recebido pelo coletor → executado (ou recusado, falhou, expirado), e desabilita as ações quando o coletor está fora do ar.
- **CA10** Encerrar e interromper pedem confirmação; abrir mostra um resumo do que vai ser aberto antes de enviar.
- **CA11** `npm run e2e` sobe painel e coletor locais, cria uma sessão `moises-teste-` na sandbox e imprime "passou" ou "falhou" para cada uma das cinco capacidades.

## Foco de revisão

1. **Comando assinado válido, repetido dentro da janela por quem controla o Redis**, inclusive depois de uma enxurrada de comandos lixo e depois de reiniciar o coletor. Esperado: executa uma vez só. Teste na tarefa 3.
2. **Pedido de permissão respondido duas vezes, depois de expirar ou depois de a sessão seguir em frente.** Esperado: erro claro; nenhum outro pedido é afetado. Teste na tarefa 6.
3. **Coletor reinicia com sessões comandadas abertas.** Esperado: os filhos morrem com ele, as sessões aparecem como encerradas e "Retomar" funciona. Teste na tarefa 6 (`fechar()`).
4. **Saída do `claude` fora do esperado** (linha que não é JSON, linha gigante, pedido de controle desconhecido, `init` com modo de permissão ou MCP inesperado, saída antes de responder). Esperado: o coletor não cai, encerra a sessão quando o `init` diverge e reporta a falha. Teste na tarefa 6.
5. **Relógio do celular errado.** Esperado: recusa com mensagem que manda acertar o relógio. Teste na tarefa 3.

## Mapa de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `collector/encerrar.js`, `scripts/lint.js`, `scripts/build.js`, `package.json` | feito | 1 ✔ |
| `public/assinatura.js` | derivar chave não extraível, assinar comando, `hashVisto` (WebCrypto; módulo ES que também roda no Node) | 2 |
| `collector/assinatura.js` | o mesmo com `node:crypto`, síncrono; gerar código | 2 |
| `collector/auditoria.js` | registro de auditoria local | 3 |
| `collector/comandos.js` | `Chaveiro` (chaves por aparelho) e `Porteiro` (decide se um comando é aceito) | 3 |
| `api/comando.js` (novo), `api/ingest.js`, `api/estado.js`, `api/_lib.js`, `vercel.json`; `api/encerrar.js` sai | transporte dos comandos | 4 |
| `collector/transcript.js`, `collector/sessoes.js`, `collector/redigir.js` | primeiro pedido, última resposta, `estado`, `redigirBloco` | 5 |
| `collector/orquestrador.js` | processos `claude` comandados e os seis verbos | 6 |
| `test/fixtures/claude-falso.js` | imita o protocolo `stream-json` nos testes | 6 |
| `collector/index.js`, `scripts/configurar-comandos.js`, `collector/systemd/moises-coletor.service` | laço, ritmo, configuração local | 7 |
| `public/index.html`, `public/app.js`, `public/style.css`, `public/cofre.js` | interface | 8 |
| `test/e2e/orquestracao.e2e.js`, `scripts/dev.js` | prova com o Claude Code de verdade (o lead escreve e roda) | 9 |
| `README.md`, `docs/api.md`, `docs/plano.md`, `CLAUDE.md` | documentação | 10 |

Grupos para trabalho em paralelo (arquivos disjuntos): **G2** = tarefa 2; **G3** = tarefas 3, 4 e 5; **G4** = tarefas 6 e 8; **G5** = tarefa 7; **G6** = tarefas 9 e 10. Tarefas **sensíveis** (dev com `model: opus`, revisão do `seguranca`): 2, 3, 4, 6 e 7.

## Contrato comum

**Código do aparelho** (gerado na máquina, digitado uma vez no aparelho): `<kid>-<4>-<4>-<4>-<4>`, com `kid` de 6 caracteres e quatro grupos de 4, todos do alfabeto `abcdefghjkmnpqrstuvwxyz23456789` (sorteio com `crypto.randomInt`). Normalização antes de derivar: minúsculas e só `[a-z0-9]`; os 6 primeiros caracteres normalizados são o `kid`; o código normalizado tem de ter 22 caracteres.

**Chave:** PBKDF2-SHA256 do código normalizado inteiro, sal `moises-comandos-v1`, 210.000 iterações, 32 bytes, usada como chave HMAC-SHA256. No navegador é um `CryptoKey` **não extraível** com uso `sign`.

**Comando** (o que o navegador envia e o coletor recebe):

```json
{ "v": 1, "kid": "ab2cd3", "id": "c_0123456789abcdef", "tipo": "mensagem", "chave": "principal:<uuid>",
  "criadoEm": 1794387000000, "dados": "{\"texto\":\"...\",\"visto\":{\"projeto\":\"x\",\"nome\":\"y\"}}",
  "assinatura": "<43 caracteres base64url>" }
```

| Campo | Regra (conferida no servidor e, de novo, no coletor antes da assinatura) |
|---|---|
| `v` | número `1` |
| `kid` | `/^[a-z0-9]{6}$/` |
| `id` | `/^c_[0-9a-f]{16}$/` |
| `tipo` | `abrir`, `mensagem`, `permissao`, `interromper`, `encerrar` ou `retomar` |
| `chave` | `null` em `abrir`; nos outros, `/^[a-z0-9]{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` |
| `criadoEm` | inteiro seguro, relógio do navegador |
| `dados` | **string** JSON de até 8.000 caracteres |
| `assinatura` | `/^[A-Za-z0-9_-]{43}$/` |

**Texto assinado:** `JSON.stringify(['moises-cmd-v1', kid, id, tipo, chave ?? '', criadoEm, dados])`, HMAC-SHA256, base64url sem `=`.

**Dados por verbo** (depois do `JSON.parse` da mesma string que foi verificada; o coletor copia só os campos da tabela e recusa campo fora dela):

| Verbo | Dados |
|---|---|
| `abrir` | `projeto` (nome na lista local), `pedido` (1 a 6.000 caracteres), `conta?` (padrão `principal`), `modelo?` (`haiku`, `sonnet`, `opus`, `fable`), `esforco?` (`low`, `medium`, `high`, `xhigh`, `max`), `modoPermissao?` (`manual`, `acceptEdits`, `plan`; padrão `manual`), `worktree?` (booleano), `nome?` (`/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/`) |
| `mensagem` | `texto` (1 a 6.000 caracteres), `visto` |
| `permissao` | `pedido` (id do pedido, 1 a 80 caracteres), `decisao` (`aprovar` ou `negar`), `vistoHash` (64 hexadecimais; obrigatório em `aprovar`), `visto` |
| `interromper` | `visto` |
| `encerrar` | `nome?` (até 140 caracteres, nome do log), `visto` |
| `retomar` | `modoPermissao?`, `modelo?`, `esforco?`, `visto` |

- `visto` = `{ "projeto": string, "nome": string | null }`: o que o cartão mostrava quando o dono tocou. O coletor compara com `projeto` e `nome` da sessão real (os mesmos valores que ele publica no retrato) e recusa se diferirem.
- `vistoHash` = SHA-256 em hexadecimal de `ferramenta + '\n' + entrada`, calculado pelo painel sobre o texto exibido.

**Estados de um comando no servidor:** `pendente` → `recebido` → `feito` \| `falhou`; ou `pendente` → `recusado` \| `expirado`.

**Motivo de recusa:** o ack `recusado` leva `motivo` (um dos motivos do porteiro, `/^[a-z_]{1,20}$/`), que o servidor guarda e devolve em `comandos` para o painel distinguir, por exemplo, `assinatura` e `aparelho` (pedir o código de novo) de `expirado`.

**Campos novos do retrato:** em cada sessão, `estado`, `ultimaResposta`, `ultimaRespostaEm`, `gerenciada` (booleano), `retomavel` (booleano: sessão encerrada cuja pasta está na lista de projetos) e `permissoes` (lista de `{pedido, ferramenta, entrada, completo, sensivel, criadoEm}`; vazia se não houver). No topo, `orquestracao: { ativa, motivo, projetos: [nomes], contas: [nomes], modelos, esforcos, modos, maxSessoes, abertas, aparelhos: [{kid, rotulo}] }`.

---

### Tarefa 1: testes isolados da produção, lint e build ✔

Feita nos commits `1291481` e `6250da1`. `reiniciarLimites()` existe em `collector/encerrar.js`.

### Tarefa 2 (sensível): assinatura no navegador e no coletor

**Arquivos:** criar `public/assinatura.js`, `collector/assinatura.js`, `test/assinatura.test.js`.

**Interfaces — produz:**

```js
// public/assinatura.js (módulo ES; usa só globalThis.crypto; nenhum acesso a DOM, IndexedDB ou rede)
export function normalizarCodigo(codigo)   // → string de 22 caracteres ou null se inválido
export async function derivarChave(codigo) // → { kid, chave: CryptoKey HMAC não extraível, usos ['sign'] }; lança Error('Código inválido.') se normalizarCodigo der null
export function textoDoComando({ kid, id, tipo, chave, criadoEm, dados }) // → string (regra do contrato)
export async function assinarComando({ kid, chave }, { tipo, chave: sessao = null, dados = {} }, agora = Date.now())
  // → { v: 1, kid, id, tipo, chave: sessao, criadoEm: agora, dados: JSON.stringify(dados), assinatura }
export async function hashVisto(ferramenta, entrada) // → 64 hexadecimais

// collector/assinatura.js (node:crypto, síncrono)
export const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
export function gerarCodigo()               // → 'kid-xxxx-xxxx-xxxx-xxxx' com crypto.randomInt
export function normalizarCodigo(codigo)    // mesma regra
export function derivarChave(codigo)        // → { kid, chave: Buffer(32) }; lança se inválido
export function textoDoComando(cmd)         // mesma regra
export function assinaturaConfere(chave, cmd) // → boolean; confere o tamanho antes de timingSafeEqual; false, sem lançar, para qualquer formato inválido
export function hashVisto(ferramenta, entrada) // → 64 hexadecimais
```

- [ ] **Passo 1: testes que falham** em `test/assinatura.test.js`: (a) `gerarCodigo` tem o formato do contrato e dois sorteios diferem; (b) `normalizarCodigo` aceita maiúsculas, espaços e hífens a mais e devolve `null` para tamanho errado; (c) um comando assinado por `public/assinatura.js` com a chave derivada de um código passa em `assinaturaConfere` com a chave derivada do mesmo código no coletor; (d) trocar um caractere de `dados`, `tipo`, `chave`, `kid`, `id` ou somar 1 em `criadoEm` faz falhar; (e) `assinaturaConfere` devolve `false`, sem lançar, para assinatura ausente, vazia, de tamanho errado ou que não é string; (f) a chave do navegador não é extraível (`crypto.subtle.exportKey('raw', chave)` rejeita); (g) `hashVisto` dá o mesmo valor nos dois módulos e muda se a entrada mudar; (h) `chave: null` assina como string vazia; (i) `derivarChave('curto')` lança nos dois módulos.
- [ ] **Passo 2:** `node --test test/assinatura.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar os dois módulos conforme o "Contrato comum".
- [ ] **Passo 4:** `node --test test/assinatura.test.js` → passa; `npm test && npm run lint` → código 0.
- [ ] **Passo 5:** commit `Assinatura de comandos: mesma regra no navegador e no coletor`.

### Tarefa 3 (sensível): chaveiro, porteiro e auditoria

**Arquivos:** criar `collector/auditoria.js`, `collector/comandos.js`, `test/canal-comandos.test.js`.

**Interfaces — consome:** `collector/assinatura.js`. **Produz:**

```js
// collector/auditoria.js
export class Auditoria {
  constructor({ arquivo, agora = () => Date.now(), maxBytes = 5_000_000, maxRecusasPorMinuto = 20 })
  registrar({ id, tipo, chave, quem, decisao, motivo = null, resultado = null }) // uma linha JSON; nunca lança
}
// linha: { em: ISO, id, tipo, sessao, quem, decisao: 'aceito'|'recusado'|'feito'|'falhou', motivo, resultado }
// arquivo criado com modo 0o600; ao passar de maxBytes vira <arquivo>.1 (substitui o anterior)
// recusas além de maxRecusasPorMinuto no mesmo minuto não viram linha: são contadas e saem numa linha única
//   { em, decisao: 'recusado', motivo: 'suprimidas', resultado: '<n> recusas' } na virada do minuto ou na próxima chamada

// collector/comandos.js
export const TIPOS; export const JANELA_MS = 120_000; export const FOLGA_FUTURO_MS = 30_000; export const GUARDA_IDS_MS = 600_000;
export class Chaveiro {
  constructor({ arquivo })      // JSON { "<kid>": { "rotulo": string, "chave": "<64 hex>", "criadaEm": ISO } }
  obter(kid)                    // → { chave: Buffer, rotulo } | null; relê o arquivo quando o mtime muda
  aparelhos()                   // → [{ kid, rotulo }]
}
export class Porteiro {
  constructor({ chaveiro, pastaEstado, auditoria, agora = () => Date.now(), maxPorMinuto = 30 })
  ativo()                       // → { ativa: boolean, motivo: string | null }
  conferir(cmd)                 // → { ok: true, dados, quem } | { ok: false, motivo, erro }
  concluir(cmd, { ok, erro })   // audita 'feito' ou 'falhou'
}
```

`Chaveiro`: arquivo ausente ou JSON inválido → nenhuma chave; arquivo com permissão mais aberta que 600 (`mode & 0o077`) → nenhuma chave e um aviso em `console.error` sem conteúdo; entrada com `kid` ou `chave` fora do formato é ignorada; `rotulo` cortado em 40 caracteres.

`Porteiro.conferir`, **nesta ordem**, com o `motivo` de cada recusa: `MOISES_COMANDOS=0` → `desligado`; chaveiro sem nenhuma chave → `sem_chave`; `assinatura` ausente → `sem_credencial`; qualquer campo fora da tabela do contrato (inclusive `v` diferente de 1) → `formato`; verbo fora de `TIPOS` → `verbo`; `kid` que o chaveiro não conhece → `aparelho` (erro: "Este aparelho não está autorizado neste computador."); assinatura não confere → `assinatura`; `agora - criadoEm >= JANELA_MS` → `expirado`; `criadoEm - agora > FOLGA_FUTURO_MS` → `relogio` (erro: "O relógio do aparelho está adiantado; acerte a hora e tente de novo."); id já visto → `repetido`; mais de `maxPorMinuto` comandos com assinatura válida no último minuto → `ritmo`; `dados` não é JSON de objeto ou foge da tabela do verbo → `formato`; falha ao gravar o id em disco → `interno` (recusa: falha fechada). Só depois de tudo o comando é aceito.

O id só entra no conjunto de vistos **depois** de a assinatura conferir e é gravado em disco **antes** de `conferir` devolver `ok`. O conjunto fica em `<pastaEstado>/comandos-vistos.json` como `{ id: criadoEm }`, gravado por arquivo temporário e `rename`, relido na construção, e é podado **por tempo**: sai o id com `criadoEm` mais velho que `GUARDA_IDS_MS`. Nunca por contagem. `dados` aceito é um objeto novo só com as chaves da tabela (nada de `__proto__` nem extras). `quem` = `'<kid> (<rótulo>)'`. Texto que vai para a auditoria é cortado em 80 caracteres e perde caracteres de controle; `dados` nunca é registrado.

- [ ] **Passo 1: testes que falham** em `test/canal-comandos.test.js`, com arquivo de chaves e pasta temporários e relógio injetado. Um teste por linha: `recusa comando sem credencial`; `recusa assinatura feita com outra chave`; `recusa aparelho desconhecido`; `recusa versão desconhecida`; `recusa comando expirado (criado há 120 s)`; `recusa comando com data 31 s no futuro e diz que é o relógio`; `aceita uma vez e recusa o mesmo comando repetido`; `a repetição é recusada mesmo depois de reiniciar o porteiro`; `300 comandos lixo sem assinatura válida não fazem um comando já executado ser aceito de novo`; `se o arquivo de vistos não puder ser gravado, o comando é recusado` (pasta de estado somente leitura); `recusa verbo desconhecido mesmo com assinatura válida`; `recusa tudo sem chave configurada`; `ignora arquivo de chaves com permissão 644`; `recusa tudo com MOISES_COMANDOS=0`; `recusa dados fora da tabela do verbo` (campo extra, `pedido` vazio, `modoPermissao: 'bypassPermissions'`, `nome: '-x'`, `worktree: 'x'`, `mensagem` sem `visto`, `aprovar` sem `vistoHash`, `dados` com `__proto__`); `o limite por minuto conta só comandos com assinatura válida`; `recusa o 31º comando válido no mesmo minuto`; `revogar um aparelho no arquivo passa a valer sem reiniciar`; `cada comando aceito fica na auditoria com quem, quando, sessão, verbo e decisão`; `cada recusa fica na auditoria com o motivo`; `a auditoria não contém o texto da mensagem`; `o arquivo de auditoria tem permissão 600`; `concluir registra feito ou falhou`; `auditoria gira o arquivo ao passar do limite`; `recusas em excesso viram uma linha de resumo`.
- [ ] **Passo 2:** `node --test test/canal-comandos.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar `Auditoria`, `Chaveiro` e `Porteiro`.
- [ ] **Passo 4:** `node --test test/canal-comandos.test.js` → passa; `npm test && npm run lint` → código 0.
- [ ] **Passo 5:** commit `Porteiro dos comandos: chave por aparelho, validade, repetição e auditoria local`.

### Tarefa 4 (sensível): transporte no servidor

**Arquivos:** criar `api/comando.js`; modificar `api/ingest.js`, `api/estado.js`, `api/_lib.js`, `vercel.json`, `scripts/redis-memoria.js` (se faltar comando), `test/api.test.js`, `docs/api.md`; apagar `api/encerrar.js`.

**Interfaces — produz:**

- `POST /api/comando` (cookie e JSON obrigatórios; corpo de até 12.000 bytes). Corpo: o comando do "Contrato comum". `400` se algum campo foge da tabela (o servidor confere formato e tamanho; **não** confere assinatura, pois não tem a chave); `409` se o `id` já existe; `429` se já há 20 comandos `pendente`; `200 {"id"}`. Grava `{v, kid, id, tipo, chave, criadoEm, dados, assinatura, estado: 'pendente', erro: null, recebidoNoServidorEm}`.
- `POST /api/ingest`: devolve `{comandos: [{v, kid, id, tipo, chave, criadoEm, dados, assinatura, idadeMs}], painelVistoEm}`, no máximo 20 comandos; `idadeMs` conta de `recebidoNoServidorEm` (ou de `criadoEm`, se o campo não existir). Aceita acks `{id, estado: 'recebido'|'feito'|'falhou'|'recusado', erro, motivo, log, chaveNova}` (`motivo` só é guardado se casar com `/^[a-z_]{1,20}$/`) e, por compatibilidade, `{id, ok, erro, log}`. Em qualquer ack **e ao marcar `expirado`**, apaga `dados` e `assinatura` do comando guardado. `chaveNova` (formato de `chave`) é gravada como `chave` do comando quando o `tipo` é `abrir`. Comando `recebido` há mais de 10 min vira `falhou` com erro "O coletor não confirmou o resultado.". O log do Histórico continua valendo só para `encerrar` com `log`. `erro` de ack é cortado em 200 caracteres.
- `GET /api/estado`: grava `moises:painelVistoEm` e devolve `comandos: [{id, tipo, chave, estado, erro, motivo, criadoEm}]`.
- `K.painelVistoEm = 'moises:painelVistoEm'` em `api/_lib.js`.
- `vercel.json`: a CSP ganha `; require-trusted-types-for 'script'` e entra o cabeçalho `Cross-Origin-Opener-Policy: same-origin`.

- [ ] **Passo 1: testes que falham** em `test/api.test.js`: `comando exige cookie e JSON`; `comando recusa formato inválido` (um caso por linha da tabela do contrato, mais `chave` ausente em `mensagem` e presente em `abrir`, e `dados` com 8.001 caracteres); `comando com id repetido dá 409`; `o 21º comando pendente dá 429`; `ingest entrega o comando com dados e assinatura e o estado nunca os devolve`; `ack recebido apaga dados e assinatura do Redis`; `comando expirado perde dados e assinatura`; `ack feito de abrir grava a chave nova`; `ack recusado guarda o erro e o motivo, e motivo fora do formato é descartado`; `comando recebido há 10 min sem resultado vira falhou`; `estado grava painelVistoEm e o ingest devolve`; `cabeçalhos: CSP com trusted types e COOP` (lendo `vercel.json`); adaptar o teste do fluxo de encerrar para `POST /api/comando` com `tipo: 'encerrar'` e conferir o log no Histórico; adaptar o teste de expiração.
- [ ] **Passo 2:** `node --test test/api.test.js` → falhas novas.
- [ ] **Passo 3:** implementar. Remover `api/encerrar.js`.
- [ ] **Passo 4:** `npm test && npm run lint && npm run build` → código 0.
- [ ] **Passo 5:** atualizar `docs/api.md` (rota nova, acks, campos novos do retrato, remoção de `/api/encerrar`).
- [ ] **Passo 6:** commit `API: rota única de comandos assinados e estados recebido/recusado`.

### Tarefa 5: estado ao vivo, última resposta, tarefa e redação de blocos

**Arquivos:** modificar `collector/transcript.js`, `collector/sessoes.js`, `collector/redigir.js`, `collector/encerrar.js`, `test/coletor.test.js`.

**Interfaces — produz:**

```js
// transcript.js: novoEstado() ganha primeiroPedido, ultimaResposta, ultimaRespostaEm (null no início)
// redigir.js
export function redigirBloco(texto, max = 4000) // → { texto, alterado }
// sessoes.js
export function estadoDe(reg, vivo, agora = Date.now())
  // → 'trabalhando' | 'esperando_permissao' | 'esperando_mensagem' | 'parada' | 'encerrada'
Coletor.prototype.cwdDe(chavePainel) // → caminho absoluto do registro vivo ou do transcript, ou null
// cada sessão do retrato ganha: estado, ultimaResposta (redigir, 1200), ultimaRespostaEm, gerenciada: false, permissoes: [],
//   tarefaOrigem: 'titulo' | 'resumo' | 'pedido' | 'nome' | null
// tarefa = redigir(tituloIA || resumo || primeiroPedido || nome, 140)
```

Regras:

- `primeiroPedido` é o texto da primeira linha `type: "user"` do transcript principal que não seja `isSidechain` nem `isMeta`, cujo conteúdo seja string ou tenha bloco `text` (blocos `tool_result` não contam) e que não comece com `<`. `ultimaResposta` é o último bloco `text` de uma linha `assistant` do principal, fora de `isSidechain` e com modelo diferente de `<synthetic>`. Os dois são cortados em 4.000 caracteres ao ler.
- `estadoDe`: processo morto → `encerrada`; `status` `busy`, `shell` ou `running` → `trabalhando`; `status` `waiting` com `waitingFor` contendo `perm`, `sandbox` ou `worker` → `esperando_permissao`; outro `waiting` → `esperando_mensagem`; demais: parado há mais de 15 min → `parada`, senão `esperando_mensagem`. O campo antigo `status` não muda.
- `redigirBloco` preserva quebras de linha e tabulações (não colapsa espaços); aplica os mesmos padrões de segredo de `redigir`; troca cada caractere de controle (exceto `\n` e `\t`), de direção de texto (U+202A a U+202E, U+2066 a U+2069, U+200E, U+200F) e de largura zero (U+200B a U+200D, U+2060, U+FEFF) por `\u{XXXX}` visível; corta em `max`. `alterado` é verdadeiro se qualquer uma dessas coisas mudou o texto.
- `redigir.js` ganha dois padrões: número de cartão (13 a 19 dígitos, com espaços ou hífens, que passa no algoritmo de Luhn) e CEP (`\d{5}-\d{3}`).
- Com `MOISES_SUBIR_TEXTO=0` no ambiente do coletor, `ultimaResposta` sai `null` e a tarefa não usa o primeiro pedido.
- `collector/encerrar.js`: o log de encerramento não leva `tarefa` quando `tarefaOrigem` é `pedido` (o texto de um pedido não vai para o Histórico). Exportar `logDeEncerramento(sessao, nome, fim)` com o objeto `log` que `executarEncerrar` já monta, e usar a função dentro dele.

- [ ] **Passo 1: testes que falham** em `test/coletor.test.js`: `estado ao vivo a partir do registro` (uma asserção por regra); `transcript guarda o primeiro pedido e a última resposta` (com `tool_result`, sidechain e meta no meio, que não podem contar); `tarefa cai para o primeiro pedido e depois para o nome, e diz a origem`; `última resposta sai mascarada e cortada em 1200`; `cwdDe devolve a pasta da sessão viva e da encerrada`; `redigirBloco preserva quebras de linha e marca alterado quando mascara, escapa ou corta` (um caso de cada, mais um texto limpo com `alterado: false`); `redigir mascara cartão válido e CEP e não mascara número que falha no Luhn`; `MOISES_SUBIR_TEXTO=0 não sobe resposta nem pedido`; `log de encerramento não leva tarefa vinda do pedido`.
- [ ] **Passo 2:** `node --test test/coletor.test.js` → falhas novas.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test && npm run lint` → código 0.
- [ ] **Passo 5:** commit `Coletor: estado ao vivo, última resposta, tarefa pelo primeiro pedido e redação de blocos`.

### Tarefa 6 (sensível): orquestrador

**Arquivos:** criar `collector/orquestrador.js`, `test/fixtures/claude-falso.js`, `test/orquestrador.test.js`.

**Interfaces — consome:** `Coletor` (`dirs`, `sessaoDe`, `cwdDe`, `registros`), `nomeConta`, `executarEncerrar`, `logDeEncerramento`, `hashVisto`, `redigirBloco`, `redigir`. **Produz:**

```js
export const MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODOS = ['manual', 'acceptEdits', 'plan'];
export const FERRAMENTAS_PADRAO = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];
export class Orquestrador {
  constructor({ coletor, projetos /* () => ({ nome: caminho }) */, pastaEstado, claudeBin = 'claude', argsExtra = [],
                ferramentas = FERRAMENTAS_PADRAO, tetoSessaoUsd = 5, maxSessoes = 4, maxAbrirPorDia = 20,
                permissaoExpiraMs = 30 * 60_000, soPrefixo = null, agora = () => Date.now(), esperaAberturaMs = 30_000 })
  async executar(cmd, dados)  // → { ok: true, chaveNova?, log? } | { ok: false, erro }
  aplicar(retrato)            // marca gerenciada, estado e permissoes nas sessões comandadas; devolve o retrato
  abertas()                   // → número de processos vivos
  async fechar()              // encerra todos os filhos (fim do serviço)
}
```

Decisões que não cabem na assinatura:

- **Argumentos do filho**, nesta ordem: `-p`, `--input-format=stream-json`, `--output-format=stream-json`, `--verbose`, `--permission-prompt-tool=stdio`, depois `--session-id=<uuid gerado>` (abrir) ou `--resume=<uuid>` (retomar), `--permission-mode=<modo>`, e, se vierem, `--model=`, `--effort=`, `--name=`, `--worktree=moises-<8 hex do uuid>`; depois os fixos `--restricted`, `--tools=<ferramentas separadas por vírgula>`, `--strict-mcp-config`, `--disable-slash-commands`, `--settings=<JSON fixo>`, `--max-budget-usd=<tetoSessaoUsd>`; por fim `argsExtra`. O JSON fixo de `--settings` é `{"permissions":{"disableBypassPermissionsMode":"disable","deny":["Read(~/.config/moises/**)","Edit(~/.config/moises/**)","Read(~/.ssh/**)","Edit(~/.ssh/**)","Read(~/.local/state/moises/**)","Edit(~/.local/state/moises/**)"]}}`. O pedido inicial nunca vai em argumento: vai pelo stdin.
- **Construtor lança erro** se algum item de `argsExtra` casar com `/bypass|dangerously|permission|allowed|settings|setting-sources|add-dir|mcp|plugin/i`, se `ferramentas` tiver item fora de `/^[A-Za-z]{1,30}$/` ou se `tetoSessaoUsd` não for número entre 0,01 e 100. `argsExtra` só chega por código (o teste de ponta a ponta usa para `--system-prompt=`); não existe variável de ambiente para isso.
- **Ambiente do filho por lista branca:** só `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `SHELL` e `TMPDIR` copiados de `process.env` quando existem; mais `CLAUDE_CONFIG_DIR=<pasta>` só quando a conta não é `principal`.
- **`spawn`** com `shell: false`, `cwd` = `fs.realpathSync` do caminho da lista (tem de ser diretório). Em `retomar`, a pasta da sessão (`cwdDe`) resolvida tem de ser igual a um caminho da lista ou estar dentro de `<caminho>/.claude/worktrees/`. O `sessionId` de `retomar` vem da `chave` (já validada como UUID).
- **Entrada:** `JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'`. O painel nunca fornece objeto de protocolo, só o texto.
- **Saída:** uma linha JSON por evento. `control_request` com `request.subtype === 'can_use_tool'` entra na lista de permissões pendentes (`pedido` = `request_id`); qualquer outro `control_request` recebe `{"type":"control_response","response":{"subtype":"error","request_id":…,"error":"não suportado"}}`. `result` → `esperando_mensagem`. Linha que não é JSON é ignorada e contada; linha com mais de 5 MB é descartada. Do stderr ficam os últimos 2.000 caracteres.
- **Conferência do `init`:** em todo evento `system`/`init`, `permissionMode` tem de ser o esperado (`manual` → `default`; `acceptEdits` → `acceptEdits`; `plan` → `plan`), `mcp_servers` tem de ser lista vazia e toda ferramenta de `tools` tem de estar em `ferramentas`. Se divergir, o filho é morto e a sessão registra o erro "A sessão abriu com configuração diferente da esperada e foi encerrada.".
- **Estado de uma sessão comandada:** `trabalhando` depois de cada mensagem enviada; `esperando_permissao` enquanto houver pedido pendente; `esperando_mensagem` depois de `result`.
- **Permissão publicada:** texto completo = o comando, se a ferramenta for `Bash`, senão `JSON.stringify(input, null, 2)`. `{ texto: entrada, alterado } = redigirBloco(textoCompleto, 4000)`; `completo = !alterado`; `sensivel` = o texto completo casa com `/\.config\/moises|\.local\/state\/moises|\.ssh\b|\bprintenv\b|(^|[\s;&|])env(\s|$)|\.claude\/settings|\.git\/hooks|credentials/`. O orquestrador guarda `hashVisto(ferramenta, entrada)` de cada pedido. Com `MOISES_SUBIR_TEXTO=0`, `entrada` vai vazia e `completo` é falso.
- **Respostas:** montadas só pelo coletor. Aprovar → `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":<input original guardado>}}}`; negar → `"response":{"behavior":"deny","message":"Negado pelo painel."}`. Nunca `updatedPermissions`. **Aprovar é recusado** se o pedido não é `completo` (erro: "Este pedido não coube inteiro no painel; só é possível negar.") ou se `dados.vistoHash` difere do hash guardado (erro: "O pedido mudou desde que apareceu no painel; atualize e confira de novo."). Cada pedido é respondido uma vez só. Pedido sem resposta por `permissaoExpiraMs` é negado com a mensagem "Sem resposta do painel a tempo.".
- **Interromper** → `{"type":"control_request","request_id":"int_<hex>","request":{"subtype":"interrupt"}}`; as permissões pendentes são descartadas.
- **`visto`:** em todo verbo com `chave`, `dados.visto.projeto` e `dados.visto.nome` têm de ser iguais a `projeto` e `nome` da sessão (os de `coletor.sessaoDe(chave)`; para sessão comandada recém-aberta que ainda não aparece no coletor, o projeto e o nome com que foi aberta, passados por `redigir(…, 60)` como no retrato). Diferente → erro "A sessão mudou desde que você abriu o painel; atualize e tente de novo.".
- **Abrir** resolve com `{ok: true, chaveNova: '<conta>:<uuid>'}` quando chega o primeiro evento do filho; falha com o fim do stderr passado por `redigir(…, 200)` se o filho sair antes; falha depois de `esperaAberturaMs`, matando o filho. Conta no teto diário (`maxAbrirPorDia`, guardado em `<pastaEstado>/abrir.json` como `{dia, n}`).
- **Retomar** resolve quando chega o primeiro evento ou depois de 5 s com o filho vivo.
- **Encerrar** sessão comandada: fecha o stdin; se não sair em 10 s, `SIGTERM`; mais 5 s, `SIGKILL`; devolve `log` por `logDeEncerramento`. Sessão que não é comandada: delega a `executarEncerrar(coletor, {id, chave, nome, idadeMs})`.
- **Recusas com `erro` em português:** projeto fora da lista; conta desconhecida; teto de sessões (`maxSessoes`) atingido; teto diário de aberturas atingido; sessão não é comandada (para `mensagem`, `permissao`, `interromper`); pedido de permissão que não está mais pendente; sessão ainda aberta (para `retomar`); com `soPrefixo`, **em todos os verbos**, qualquer sessão cujo nome não comece pelo prefixo (em `abrir`, o `nome` é obrigatório e tem de começar por ele).
- **`aplicar`:** em toda sessão, `retomavel` = está `encerrada`, não é comandada viva e a pasta dela (`cwdDe`) passa na mesma regra de pasta do `retomar`; nas sessões comandadas, `gerenciada: true`, `estado` e `permissoes` do orquestrador; sessão comandada que ainda não aparece no retrato do coletor é acrescentada com `chave`, `sessionId`, `conta`, `projeto`, `nome`, `estado`, `gerenciada`, `permissoes`, `status: 'ativa'`, custo e tokens zerados.

`test/fixtures/claude-falso.js`: executável Node (`#!/usr/bin/env node`, permissão de execução) que grava seus `argv` e seu ambiente (só os nomes das variáveis e o valor de `CLAUDE_CONFIG_DIR`) num arquivo indicado por um argumento `--system-prompt=registro:<caminho>` vindo de `argsExtra`, lê linhas do stdin e responde: texto com `permissao:<comando>` → emite `can_use_tool` para `Bash` com esse comando e, com `allow`, um `result` "feito", com `deny`, um `result` "negado"; texto `demora` → não responde até receber `interrupt`, então emite `result` com `subtype: "error_during_execution"`; texto `lixo` → emite uma linha que não é JSON e um `control_request` de subtipo desconhecido antes do `result`; texto `morre` → sai com código 3 escrevendo no stderr; texto `init-ruim` → emite `system/init` com `permissionMode: "bypassPermissions"`; qualquer outro texto → `system/init` coerente com os argumentos recebidos e `result` com o próprio texto. Com `--system-prompt=registro:<caminho>:sai`, sai com código 2 antes de ler.

- [ ] **Passo 1: testes que falham** em `test/orquestrador.test.js` (com `claudeBin` apontando para o falso e pastas temporárias): `abrir monta os argumentos fixos, sem texto do painel e sem bypass`; `todo argumento com valor usa a forma --flag=valor`; `o ambiente do filho é a lista branca, e a conta secundária recebe CLAUDE_CONFIG_DIR` (o processo de teste define `MOISES_TOKEN`, `SSH_AUTH_SOCK` e `CLAUDE_CODE_CHILD_SESSION` falsos e confere que não chegam); `abrir recusa projeto fora da lista, conta desconhecida, o que passa do teto de sessões e o que passa do teto diário`; `mensagem chega ao filho como texto e o estado volta a esperando_mensagem`; `mensagem com quebra de linha e JSON de protocolo dentro não forja resposta de permissão`; `pedido de permissão aparece com ferramenta, entrada, completo e sensivel`; `aprovar exige pedido completo e vistoHash igual`; `aprovar e negar respondem ao pedido certo`; `responder duas vezes ao mesmo pedido dá erro`; `pedido sem resposta é negado ao expirar`; `comando com visto diferente da sessão é recusado`; `interromper devolve a sessão a esperando_mensagem`; `encerrar fecha o filho e devolve o log`; `encerrar de sessão não comandada delega ao encerrar antigo` (com `kill` injetado); `retomar recusa sessão aberta e pasta fora da lista`; `retomar usa --resume= com o mesmo id`; `init com modo de permissão inesperado encerra a sessão`; `saída inesperada não derruba o orquestrador`; `filho que morre no meio some das abertas e o erro é reportado`; `fechar encerra todos os filhos`; `soPrefixo recusa sessão de outro nome em todos os verbos`; `argsExtra, ferramentas ou teto inválidos fazem o construtor lançar`.
- [ ] **Passo 2:** `node --test test/orquestrador.test.js` → falha por módulo inexistente.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test && npm run lint` → código 0.
- [ ] **Passo 5:** commit `Orquestrador: sessões comandadas isoladas, por stream-json, e os seis verbos`.

### Tarefa 7 (sensível): laço do coletor e configuração local

**Arquivos:** modificar `collector/index.js`, `collector/systemd/moises-coletor.service`; criar `scripts/configurar-comandos.js`, `test/laco.test.js`.

**Interfaces — consome:** `Chaveiro`, `Porteiro`, `Auditoria`, `Orquestrador`, `gerarCodigo`, `derivarChave`. **Produz:**

```js
// collector/index.js
export function lerProjetos(arquivo)   // → { nome: caminho }; {} se o arquivo faltar ou for inválido; só nomes /^[A-Za-z0-9._-]{1,60}$/ e caminhos absolutos
export function proximoIntervalo({ painelVistoEm, abertas, acksPendentes, agora, lento, rapido }) // → ms
export async function tratarComandos({ comandos, porteiro, orquestrador, acks, aoTerminar }) // enfileira acks; não bloqueia o laço
export async function rodar(opcoes)    // o laço; devolve { parar() }. main() chama rodar() com a configuração de produção
// opcoes: { url, token, pastaEstado, chavesArq, projetosArq, dirs?, intervaloMs, intervaloRapidoMs, soPrefixo?, argsExtra?, ideiasTetoDia?, log? }
```

Decisões:

- Configuração de produção: `coletor.env` (ou ambiente) dá `MOISES_URL`, `MOISES_TOKEN`, `MOISES_MAX_SESSOES` (padrão 4), `MOISES_MAX_ABRIR_DIA` (20), `MOISES_TETO_SESSAO_USD` (5), `MOISES_FERRAMENTAS` (padrão `Bash,Read,Edit,Write,Glob,Grep`), `MOISES_PERMISSAO_EXPIRA_MIN` (30), `MOISES_INTERVALO_RAPIDO_MS` (3.000), `MOISES_SO_PREFIXO`. Caminhos: `MOISES_CHAVES_ARQ` (padrão `~/.config/moises/chaves-comandos.json`) e `MOISES_PROJETOS` (padrão `~/.config/moises/projetos.json`). **A chave de comandos nunca vem de variável de ambiente.** A lista de projetos é relida a cada `abrir`. `argsExtra` só existe como opção de `rodar` (uso do teste de ponta a ponta).
- `proximoIntervalo`: `rapido` se o painel foi visto há menos de 60 s, se há sessão comandada aberta ou se há ack na fila; senão `lento`.
- `tratarComandos`: para cada comando, `porteiro.conferir`; recusado → ack `{id, estado: 'recusado', erro, motivo}`; aceito → ack `{id, estado: 'recebido'}` na hora e execução sem esperar; ao terminar, ack `{id, estado: 'feito'|'falhou', erro, log, chaveNova}`, `porteiro.concluir` e `aoTerminar()` (acorda o laço). Exceção na execução vira `falhou` com erro genérico "Erro interno do coletor." (o detalhe vai para `console.error` sem texto de sessão). **Comando sem `tipo` ou sem assinatura é recusado; o ramo que tratava pedido sem `tipo` como encerrar é removido.** `id` que não é string é ignorado sem ack.
- O retrato passa por `orquestrador.aplicar` antes do envio e ganha `orquestracao` (com `ativa` e `motivo` de `porteiro.ativo()`, os nomes de `lerProjetos`, as contas de `coletor.dirs`, `MODELOS`, `ESFORCOS`, `MODOS`, `maxSessoes`, `abertas` e `chaveiro.aparelhos()`). A assinatura de mudança do retrato inclui `estado`, `ultimaRespostaEm` e os ids das permissões. Com `soPrefixo`, o retrato só leva sessões cujo nome começa pelo prefixo.
- `SIGTERM` e `SIGINT`: `orquestrador.fechar()` e sair.
- `collector/systemd/moises-coletor.service`: `MemoryHigh=400M` vira `MemoryHigh=4G` (as sessões comandadas rodam no mesmo grupo do serviço), com um comentário dizendo isso e que reiniciar o serviço encerra as sessões comandadas.
- `scripts/configurar-comandos.js`: `node scripts/configurar-comandos.js <rótulo do aparelho>` gera um código com `gerarCodigo`, acrescenta a entrada `{rotulo, chave (hex da derivada), criadaEm}` em `chaves-comandos.json` (600, gravação por temporário e `rename`), grava o código em `codigo-<kid>.txt` (600), cria `projetos.json` com `{}` se não existir, e imprime **só** os caminhos, o `kid` e a instrução "digite o código no aparelho e apague o arquivo". `--listar` mostra `kid` e rótulo; `--revogar <kid>` apaga a entrada e o arquivo do código. Pasta em `MOISES_PASTA_CONF` (padrão `~/.config/moises`). Não toca em `coletor.env`, `vercel.env` nem `senha-painel.txt`. O código nunca é impresso nem recebido por argumento.

- [ ] **Passo 1: testes que falham** em `test/laco.test.js`: `lerProjetos ignora nome ou caminho inválido e arquivo ausente`; `proximoIntervalo` (quatro casos); `tratarComandos recusa sem credencial e não executa` (orquestrador espião); `tratarComandos confirma o recebimento antes do resultado e depois o resultado`; `comando sem tipo é recusado e não vira encerrar`; `exceção na execução vira falhou com erro genérico`; `configurar-comandos grava chaves e código com permissão 600, não imprime o código e não toca nos outros arquivos` (rodando o script com `MOISES_PASTA_CONF` temporária contendo um `coletor.env` falso); `a chave gravada é a derivada do código gravado`; `segundo aparelho não apaga o primeiro`; `--revogar tira o aparelho`; `rodar com um servidor local falso: manda o retrato com orquestracao e trata um comando assinado até o ack final` (servidor `http` em `127.0.0.1`, orquestrador com `claudeBin` do falso da tarefa 6).
- [ ] **Passo 2:** `node --test test/laco.test.js` → falha.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `npm test && npm run lint && npm run build` → código 0.
- [ ] **Passo 5:** commit `Coletor: comandos assinados no laço, ritmo rápido com o painel aberto e configuração local`.

### Tarefa 8: interface

**Arquivos:** modificar `public/index.html`, `public/app.js`, `public/style.css`; criar `public/cofre.js`. Segue `docs/orquestracao/SPEC-interface.md`.

**Interfaces — consome:** `public/assinatura.js`, `POST /api/comando`, campos novos do retrato e de `comandos`.

Decisões: `app.js` passa a ser carregado com `type="module"`. `public/cofre.js` guarda `{kid, chave}` (o `CryptoKey` não extraível) no IndexedDB (banco `moises`, armazém `chaves`, registro `comandos`) e exporta `guardar({kid, chave})`, `obter()` e `esquecer()`; o código digitado nunca é guardado nem enviado ao servidor, e o campo dele fica fora de `<form>`, com `autocomplete="off"`. Sair do painel chama `esquecer()`. Todo comando sai por uma função única `enviarComando(tipo, sessao, dados)`, que pede o código se o aparelho ainda não tem a chave, acrescenta `visto: {projeto, nome}` da sessão exibida e, em `aprovar`, o `vistoHash` de `hashVisto(ferramenta, entrada)` sobre o texto exibido. "Aprovar" só é habilitado se a permissão tem `completo: true`; senão o bloco diz "Este pedido não coube inteiro no painel; só é possível negar." Pedido `sensivel` mostra um aviso antes dos botões. A entrada do pedido aparece em bloco monoespaçado com as quebras de linha preservadas (`white-space: pre-wrap`). Encerrar e interromper pedem confirmação. Com o coletor fora do ar (`recebidoEm` com mais de 2 min) ou `orquestracao.ativa` falso, as ações ficam desabilitadas com o motivo escrito. Nenhum `innerHTML`.

- [ ] **Passo 1:** implementar conforme a spec.
- [ ] **Passo 2:** `npm run lint && npm run build` → ok; conferir no navegador com `node scripts/dev.js` (roteiro na spec).
- [ ] **Passo 3:** commit `Painel: estado ao vivo, mensagem, permissão, ações e nova sessão`.

### Tarefa 9: prova de ponta a ponta

**Arquivos:** `test/e2e/orquestracao.e2e.js`; ajustar `scripts/dev.js` para não ler `~/.config/moises/vercel.env` quando `PANEL_PASSWORD_HASH`, `SESSION_SECRET` e `MOISES_TOKEN` já vêm do ambiente.

Sobe `scripts/dev.js` como processo filho e o coletor **no próprio processo** por `rodar()`, com segredos e chave de aparelho gerados na hora em pasta temporária, lista de projetos apontando só para `~/moises-sandbox`, `soPrefixo: 'moises-teste-'`, ideias desligadas, intervalos de 1 s e `argsExtra` só com um `--system-prompt=` curto. Fala com o painel só por HTTP (login, `POST /api/comando` assinado por `public/assinatura.js`, `GET /api/estado`). Imprime uma linha por capacidade: `1. abrir sessão com um pedido: passou`, `2. ver estado e última resposta`, `3. enviar mensagem e ver a resposta`, `4. aprovar e negar um pedido de permissão`, `5. interromper e encerrar`, mais o custo somado. Sai com 1 se algum item falhar. No fim, encerra tudo e confere que não sobrou processo da sessão.

- [ ] **Passo 1:** rodar `npm run e2e` → cinco linhas "passou".
- [ ] **Passo 2:** commit `Teste de ponta a ponta das cinco capacidades com o Claude Code de verdade`.

### Tarefa 10: documentação

**Arquivos:** `README.md` (como funciona, o que sai da máquina e para onde, configuração dos aparelhos e da lista de projetos, ordem de publicação, `npm run e2e`), `docs/api.md` (conferir), `docs/plano.md` (apontar para a ADR-001), `CLAUDE.md` (comandos de verificação, número de testes, regra "nenhum `innerHTML`").

- [ ] **Passo 1:** atualizar e conferir os comandos citados rodando cada um.
- [ ] **Passo 2:** commit `Docs: orquestração, canal de comandos e o que sai da máquina`.
