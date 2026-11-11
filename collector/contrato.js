// Constantes do contrato dos comandos com uma fonte só no coletor: o porteiro (collector/comandos.js), o
// orquestrador, a assinatura, o laço (collector/index.js) e o script de pareamento importam daqui. O
// servidor (api/_lib.js) e o painel (public/) têm cópias próprias, porque não podem importar collector/;
// test/contrato.test.js confere que continuam iguais a estas.

// Os seis verbos do canal de comandos.
export const TIPOS = Object.freeze(['abrir', 'mensagem', 'permissao', 'interromper', 'encerrar', 'retomar']);
export const MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODOS = ['manual', 'acceptEdits', 'plan'];
// Chave de sessão `<conta>:<uuid>`, com a conta e o uuid em grupos (o orquestrador os usa). É também a regex
// de sessão do porteiro: sem flag `g`, os grupos não mudam o resultado de `test`.
export const RE_CHAVE = /^([a-z0-9]{1,20}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// O kid: 6 hexadecimais minúsculos (o começo do SHA-256 da pública). A única regex de kid do coletor: o
// porteiro, o chaveiro e o script de pareamento usam esta (SE-B3).
export const RE_KID = /^[0-9a-f]{6}$/;
// Formato da assinatura: ECDSA P-256 em IEEE P1363 (64 bytes) e base64url sem '=' (86 caracteres).
export const RE_ASSINATURA = /^[A-Za-z0-9_-]{86}$/;

// Objeto comum: nem null, nem lista.
export const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
