import { envSchema } from '../env';

/** Configuration de production complète ; chaque test retire ou modifie une variable. */
const aProductionEnv = (): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'p'.repeat(64),
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'client-secret',
  PAYPAL_WEBHOOK_ID: 'WH-123',
  PAYPAL_PARTNER_MERCHANT_ID: 'MERCHANT-123',
  MESSAGE_ENCRYPTION_KEY: 'm'.repeat(32),
  ENCRYPTION_KEY: 'e'.repeat(32)
});

const issueMessages = (source: Record<string, string | undefined>): string[] => {
  const result = envSchema.safeParse(source);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('envSchema', () => {
  it('accepte une configuration de production complète', () => {
    expect(envSchema.safeParse(aProductionEnv()).success).toBe(true);
  });

  it.each(['PAYPAL_WEBHOOK_ID', 'PAYPAL_PARTNER_MERCHANT_ID', 'ENCRYPTION_KEY'])(
    'refuse de démarrer en production sans %s, en nommant la variable',
    (name) => {
      const source = { ...aProductionEnv(), [name]: undefined };

      expect(issueMessages(source)).toEqual([`${name} est requise en production.`]);
    }
  );

  it('laisse ces variables facultatives hors production', () => {
    expect(envSchema.safeParse({ NODE_ENV: 'development' }).success).toBe(true);
  });

  it('refuse PAYPAL_MODE=live hors production', () => {
    expect(issueMessages({ NODE_ENV: 'development', PAYPAL_MODE: 'live' })).toEqual([
      'PAYPAL_MODE=live est interdit hors production. Utilisez PAYPAL_MODE=sandbox.'
    ]);
  });

  it('refuse une valeur de PAYPAL_MODE inconnue au lieu de basculer en sandbox', () => {
    expect(envSchema.safeParse({ NODE_ENV: 'development', PAYPAL_MODE: 'prod' }).success).toBe(false);
  });

  it('applique des valeurs par défaut au pool MongoDB et les convertit en nombres', () => {
    const defaults = envSchema.parse({ NODE_ENV: 'development' });
    const custom = envSchema.parse({ NODE_ENV: 'development', MONGODB_MAX_POOL_SIZE: '25' });

    expect(defaults.MONGODB_MAX_POOL_SIZE).toBe(10);
    expect(defaults.MONGODB_SERVER_SELECTION_TIMEOUT_MS).toBe(5000);
    expect(custom.MONGODB_MAX_POOL_SIZE).toBe(25);
  });
});
