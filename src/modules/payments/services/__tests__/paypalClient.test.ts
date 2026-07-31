process.env.PAYPAL_MODE = 'sandbox';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.PAYPAL_BN_CODE = 'MYKPOPTRADE_SP_PPCP';
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-1';

import axios from 'axios';
import { buildAuthAssertion, partnerHeaders, PayPalClient } from '../paypalClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('buildAuthAssertion', () => {
  it('produit un JWT non signé identifiant le vendeur', () => {
    const assertion = buildAuthAssertion('SELLERMERCHANT1');
    const [header, body, signature] = assertion.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'none' });
    expect(decodeSegment(body)).toEqual({
      iss: 'test-client-id',
      payer_id: 'SELLERMERCHANT1'
    });
    expect(signature).toBe('');
  });

  it('encode en base64url, sans caractère invalide dans un header HTTP', () => {
    // Un `+`, `/` ou `=` issu d'un base64 classique casserait l'assertion côté
    // PayPal : on vérifie que l'alphabet URL-safe est bien utilisé.
    const assertion = buildAuthAssertion('MERCHANT+WITH/ODD=CHARS');

    expect(assertion).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.$/);
  });

  it('refuse de construire une assertion sans merchant ID', () => {
    expect(() => buildAuthAssertion('')).toThrow(/Merchant ID vendeur manquant/);
  });
});

describe('partnerHeaders', () => {
  it('inclut toujours le BN code', () => {
    const headers = partnerHeaders({ accessToken: 'token-abc' });

    expect(headers['PayPal-Partner-Attribution-Id']).toBe('MYKPOPTRADE_SP_PPCP');
    expect(headers.Authorization).toBe('Bearer token-abc');
  });

  it('n\'ajoute l\'auth assertion que si un vendeur est visé', () => {
    expect(partnerHeaders({ accessToken: 't' })['PayPal-Auth-Assertion']).toBeUndefined();
    expect(
      partnerHeaders({ accessToken: 't', sellerMerchantId: 'M1' })['PayPal-Auth-Assertion']
    ).toBeDefined();
  });

  it('propage la clé d\'idempotence quand elle est fournie', () => {
    const headers = partnerHeaders({ accessToken: 't', requestId: 'capture_ORDER1' });

    expect(headers['PayPal-Request-Id']).toBe('capture_ORDER1');
  });
});

describe('PayPalClient.getAccessToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PayPalClient.resetTokenCache();
  });

  it('réutilise le token en cache au lieu de le redemander', async () => {
    (mockedAxios as any).mockResolvedValue({
      data: { access_token: 'cached-token', expires_in: 3600 }
    });

    const first = await PayPalClient.getAccessToken();
    const second = await PayPalClient.getAccessToken();

    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('redemande un token quand la marge d\'expiration est dépassée', async () => {
    // expires_in de 60s : sous la marge de 5 minutes, donc jamais mis en cache.
    (mockedAxios as any).mockResolvedValue({
      data: { access_token: 'short-lived', expires_in: 60 }
    });

    await PayPalClient.getAccessToken();
    await PayPalClient.getAccessToken();

    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it('ne lance qu\'une requête pour des appels concurrents', async () => {
    (mockedAxios as any).mockResolvedValue({
      data: { access_token: 'shared-token', expires_in: 3600 }
    });

    const tokens = await Promise.all([
      PayPalClient.getAccessToken(),
      PayPalClient.getAccessToken(),
      PayPalClient.getAccessToken()
    ]);

    expect(tokens).toEqual(['shared-token', 'shared-token', 'shared-token']);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });
});

describe('PayPalClient.verifyWebhookSignature', () => {
  const SIGNED_HEADERS = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig-1',
    'paypal-transmission-time': '2026-07-31T20:00:00Z'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    PayPalClient.resetTokenCache();
    (mockedAxios as any).mockResolvedValue({
      data: { access_token: 'token', expires_in: 3600 }
    });
  });

  it('accepte un événement dont PayPal confirme la signature', async () => {
    mockedAxios.post.mockResolvedValue({ data: { verification_status: 'SUCCESS' } } as any);

    await expect(
      PayPalClient.verifyWebhookSignature(SIGNED_HEADERS, { event_type: 'PAYMENT.CAPTURE.COMPLETED' })
    ).resolves.toBe(true);
  });

  it('rejette un événement dont la signature est invalide', async () => {
    mockedAxios.post.mockResolvedValue({ data: { verification_status: 'FAILURE' } } as any);

    await expect(
      PayPalClient.verifyWebhookSignature(SIGNED_HEADERS, { event_type: 'PAYMENT.CAPTURE.COMPLETED' })
    ).resolves.toBe(false);
  });

  it('rejette sans appeler PayPal quand les headers de signature manquent', async () => {
    await expect(
      PayPalClient.verifyWebhookSignature({}, { event_type: 'PAYMENT.CAPTURE.COMPLETED' })
    ).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('rejette quand PayPal est injoignable, plutôt que de laisser passer', async () => {
    mockedAxios.post.mockRejectedValue(new Error('network down'));

    await expect(
      PayPalClient.verifyWebhookSignature(SIGNED_HEADERS, { event_type: 'PAYMENT.CAPTURE.COMPLETED' })
    ).resolves.toBe(false);
  });
});
