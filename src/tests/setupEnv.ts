/**
 * Chargé par Jest avant chaque fichier de test, donc avant src/config/env.ts.
 *
 * Les tests ne dépendent pas du .env du poste (la CI n'en a pas) et n'utilisent
 * jamais ses vraies clés : ces valeurs factices passent avant, dotenv ne
 * remplaçant pas une variable déjà définie.
 */
const testOnly = (name: string, length = 32) => `test-only-${name}-`.padEnd(length, 'x');

Object.assign(process.env, {
  NODE_ENV: 'test',
  ENCRYPTION_KEY: testOnly('encryption-key'),
  ENCRYPTION_IV: testOnly('iv', 16),
  MESSAGE_ENCRYPTION_KEY: testOnly('message-key'),
  PAYPAL_CLIENT_ID: testOnly('paypal-client-id'),
  PAYPAL_CLIENT_SECRET: testOnly('paypal-client-secret')
});
