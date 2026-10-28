import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import { PayPalClient, paypalHttp } from '../paypalClient';
import { PayPalRefundError, PayPalRefundService } from '../paypalRefundService';

const CAPTURE_ID = 'CAPTURE-123456';

/** Erreur axios telle que PayPal la renvoie pour un remboursement refusé. */
function paypalRejection(status: number, issue?: string, message = 'Request rejected') {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: { message, details: issue ? [{ issue }] : [], debug_id: 'debug-1' } }
  });
}

/** Remboursement Connected Path : depuis le compte du vendeur, avec erreurs PayPal traduites. */
describe('PayPalRefundService.refundConnectedPayment (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    jest.spyOn(PayPalClient, 'getAccessToken').mockResolvedValue('platform-token');
    jest.spyOn(PayPalClient, 'getCaptureDetails').mockResolvedValue({ amount: 30, currency: 'EUR', status: 'COMPLETED' });
  });

  const connectedSeller = () => createTestUser({ paypalMerchantId: 'MERCHANT-1' });
  const refund = (sellerId: string, amount: number | null) =>
    PayPalRefundService.refundConnectedPayment(CAPTURE_ID, amount, 'Article abîmé', sellerId);

  it('demande à un vendeur sans compte PayPal relié de le reconnecter', async () => {
    const seller = await createTestUser();
    const post = jest.spyOn(paypalHttp, 'post');

    await expect(refund(seller._id.toString(), null)).rejects.toMatchObject({
      kind: 'auth',
      issues: ['RECONNECT_PAYPAL']
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuse un montant supérieur au montant capturé sans appeler PayPal', async () => {
    const seller = await connectedSeller();
    const post = jest.spyOn(paypalHttp, 'post');

    await expect(refund(seller._id.toString(), 31)).rejects.toMatchObject({ kind: 'business' });
    expect(post).not.toHaveBeenCalled();
  });

  it('rembourse partiellement au nom du vendeur et renvoie le montant réellement remboursé', async () => {
    const seller = await connectedSeller();
    const post = jest.spyOn(paypalHttp, 'post').mockResolvedValue({
      data: { id: 'REFUND-1', status: 'COMPLETED', amount: { value: '9.50', currency_code: 'EUR' } }
    } as never);

    const result = await refund(seller._id.toString(), 10);

    expect(result).toMatchObject({ id: 'REFUND-1', status: 'COMPLETED', amount: 9.5, currency: 'EUR' });
    const [url, body, config] = post.mock.calls[0] as [string, { amount: unknown }, { headers: Record<string, string> }];
    expect(url).toBe(`/v2/payments/captures/${CAPTURE_ID}/refund`);
    expect(body.amount).toEqual({ value: '10.00', currency_code: 'EUR' });
    expect(config.headers['PayPal-Auth-Assertion']).toBeDefined();
    expect(config.headers.Prefer).toBe('return=representation');
  });

  it('rembourse la totalité sans montant quand aucun n\'est précisé', async () => {
    const seller = await connectedSeller();
    const post = jest.spyOn(paypalHttp, 'post').mockResolvedValue({
      data: { id: 'REFUND-2', status: 'COMPLETED' }
    } as never);

    const result = await refund(seller._id.toString(), null);

    expect((post.mock.calls[0][1] as Record<string, unknown>).amount).toBeUndefined();
    expect(result.amount).toBe(30);
  });

  it('traduit un solde vendeur insuffisant en message actionnable', async () => {
    const seller = await connectedSeller();
    jest.spyOn(paypalHttp, 'post').mockRejectedValue(paypalRejection(422, 'INSUFFICIENT_FUNDS'));

    const error = await refund(seller._id.toString(), 10).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayPalRefundError);
    expect(error).toMatchObject({ kind: 'business', status: 422, debugId: 'debug-1' });
    expect((error as Error).message).toContain('solde de votre compte PayPal est insuffisant');
  });

  it('demande une reconnexion quand PayPal refuse l\'autorisation (permissions révoquées)', async () => {
    const seller = await connectedSeller();
    jest.spyOn(paypalHttp, 'post').mockRejectedValue(paypalRejection(403, 'PERMISSION_DENIED'));

    await expect(refund(seller._id.toString(), 10)).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('signale le litige PayPal ouvert, renvoyé en texte libre', async () => {
    const seller = await connectedSeller();
    jest.spyOn(paypalHttp, 'post').mockRejectedValue(
      paypalRejection(422, undefined, 'Partial refunds are not allowed while a complaint case is open')
    );

    await expect(refund(seller._id.toString(), 10)).rejects.toThrow('réclamation PayPal');
  });
});
