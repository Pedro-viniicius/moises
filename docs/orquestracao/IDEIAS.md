# Ideias fora do MVP

Não implementadas. Uma linha cada.

- Fila e encadeamento: "quando a sessão A terminar, começa a B".
- Mandar o mesmo pedido para várias sessões de uma vez.
- Teto de gasto por sessão ou por dia, com pausa automática.
- Aviso no Telegram quando uma sessão fica esperando mensagem ou permissão.
- Gráficos novos no Histórico.
- Responder permissão de sessões abertas à mão: instalar um hook `PermissionRequest` em `~/.claude/settings.json` que consulta o coletor (testado na ADR-001; depende do seu "pode", porque mexe em todas as sessões).
- Fila de mensagem para sessões abertas à mão pelo hook `Stop`: a mensagem entra quando o turno atual terminar (testado na ADR-001).
- Campo editável de tarefa no painel.
- Cifrar de ponta a ponta o conteúdo das mensagens e das respostas com a chave de comandos, para a Vercel e o Redis não verem o texto.
- Atalho de terminal (`moises abrir <projeto>`) para abrir pela linha de comando uma sessão já comandada pelo painel.
- Mostrar o registro de auditoria no painel (hoje fica só no arquivo local).
