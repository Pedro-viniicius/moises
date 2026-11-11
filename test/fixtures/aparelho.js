// Aparelho de teste: par de chaves ECDSA P-256 gerado na hora com node:crypto (o navegador faz o mesmo
// com WebCrypto em public/assinatura.js). Serve aos testes do porteiro, do laço e do servidor, que
// precisam assinar comandos sem passar pelo navegador. Nenhuma chave fica em disco fora da pasta do teste.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { textoDoComando } from '../../collector/assinatura.js';

// Chave pública `raw` (65 bytes, 0x04 || x || y) em base64url, a partir de um KeyObject público.
export function publicaRaw(publicKey) {
  const { x, y } = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');
}

// `kid` e impressão digital pela regra do contrato: SHA-256 da pública `raw`, em hexadecimal.
export function identidade(publica) {
  const h = crypto.createHash('sha256').update(Buffer.from(publica, 'base64url')).digest('hex');
  return { kid: h.slice(0, 6), impressao: h.slice(0, 16).match(/.{4}/g).join('-') };
}

// Um aparelho. Sem `kid`, ele é o derivado da chave pública (como no painel); com `kid`, vale o informado
// (o chaveiro do coletor procura pelo kid do arquivo, que o script grava a partir do pedido conferido).
export function aparelho(kid = null, rotulo = 'celular') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publica = publicaRaw(publicKey);
  const id = identidade(publica);
  return { kid: kid ?? id.kid, rotulo, publica, impressao: id.impressao, privada: privateKey };
}

// Assinatura ECDSA SHA-256 no formato IEEE P1363 (64 bytes), em base64url sem `=`.
export function assinarCom(privada, cmd) {
  const assinatura = crypto.sign('sha256', Buffer.from(textoDoComando(cmd), 'utf8'), { key: privada, dsaEncoding: 'ieee-p1363' });
  return { ...cmd, assinatura: assinatura.toString('base64url') };
}

// chaves-comandos.json no formato que `configurar-comandos.js --autorizar` grava.
export function gravarChaves(arquivo, aparelhos, { modo = 0o600, criadaEm = new Date().toISOString() } = {}) {
  const json = {};
  for (const a of aparelhos) json[a.kid] = { rotulo: a.rotulo, publica: a.publica, criadaEm };
  fs.writeFileSync(arquivo, JSON.stringify(json), { mode: modo });
  fs.chmodSync(arquivo, modo);
}
