import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import User from '../../../../models/userModel';
import env from '../../../../config/env';
import { paymentConfig } from '../../../../config/paymentConfig';
import { PayPalClient, paypalHttp } from '../paypalClient';
import { PayPalPartnerService } from '../paypalPartnerService';

/** Erreur axios minimale portant un statut HTTP PayPal. */
const paypalError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });

/** Champs du corps « partner-referrals » vérifiés par les tests. */
type ReferralBody = {
  email: string;
  partner_config_override: { return_url: string };
  individual_owners: Array<{ names: object[]; phones: object[] }>;
};

/** Lien d'onboarding (Partner Referrals) et statut vendeur (« show seller status »). */
describe('PayPalPartnerService (integration)', () => {
  beforeAll(async () => {
    paymentConfig.paypal.partnerMerchantId = 'PARTNER-1';
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    jest.spyOn(PayPalClient, 'getAccessToken').mockResolvedValue('platform-token');
  });

  describe('createOnboardingLink', () => {
    const actionUrlResponse = { data: { links: [{ rel: 'action_url', href: 'https://paypal.test/onboard' }] } } as never;

    it('demande une referral au retour vers l\'API et pré-remplit les données du vendeur', async () => {
      const seller = await createTestUser({ legalName: 'Jeanne Martin', phoneNumber: '+33612345678' });
      const post = jest.spyOn(paypalHttp, 'post').mockResolvedValue(actionUrlResponse);

      const actionUrl = await PayPalPartnerService.createOnboardingLink(seller._id.toString());

      expect(actionUrl).toBe('https://paypal.test/onboard');
      const [url, body] = post.mock.calls[0] as [string, ReferralBody];
      expect(url).toBe('/v2/customer/partner-referrals');
      expect(body.partner_config_override.return_url)
        .toBe(`${env.PAYPAL_OAUTH_BASE_URL || env.API_URL}/api/payments/paypal/onboarding-return`);
      expect(body.email).toBe(seller.email);
      expect(body.individual_owners[0].names[0]).toMatchObject({ given_name: 'Jeanne', surname: 'Martin' });
      expect(body.individual_owners[0].phones[0]).toMatchObject({ country_code: '33', national_number: '612345678' });
    });

    it('émet un tracking_id neuf à chaque lien, rattaché au vendeur', async () => {
      const seller = await createTestUser();
      const post = jest.spyOn(paypalHttp, 'post').mockResolvedValue(actionUrlResponse);

      await PayPalPartnerService.createOnboardingLink(seller._id.toString());
      await PayPalPartnerService.createOnboardingLink(seller._id.toString());

      const [first, second] = post.mock.calls.map(([, body]) => (body as { tracking_id: string }).tracking_id);
      expect(first).not.toBe(second);
      expect(second.startsWith(`${seller._id}-`)).toBe(true);
      expect((await User.findById(seller._id))?.paypalTrackingId).toBe(second);
    });

    it('échoue sans enregistrer de tracking_id quand PayPal refuse la referral', async () => {
      const seller = await createTestUser();
      jest.spyOn(paypalHttp, 'post').mockRejectedValue(paypalError(400));

      await expect(PayPalPartnerService.createOnboardingLink(seller._id.toString()))
        .rejects.toThrow('Impossible de générer le lien d\'inscription PayPal');
      expect((await User.findById(seller._id))?.paypalTrackingId).toBeFalsy();
    });
  });

  describe('fetchSellerStatus / refreshSellerStatus', () => {
    const integration = {
      merchant_id: 'MERCHANT-1',
      tracking_id: 'track-1',
      legal_name: 'Jeanne Martin',
      payments_receivable: true,
      primary_email_confirmed: false,
      oauth_integrations: [{ oauth_third_party: [{ scopes: ['scope-a', 'scope-b'] }] }]
    };

    it('traduit la réponse « show seller status »', async () => {
      jest.spyOn(paypalHttp, 'get').mockResolvedValue({ data: integration } as never);

      const status = await PayPalPartnerService.fetchSellerStatus('MERCHANT-1');

      expect(status).toEqual({
        merchantId: 'MERCHANT-1',
        paymentsReceivable: true,
        primaryEmailConfirmed: false,
        consentGranted: true,
        scopes: ['scope-a', 'scope-b'],
        legalName: 'Jeanne Martin',
        primaryEmail: null,
        trackingId: 'track-1'
      });
    });

    it('renvoie null pour un marchand inconnu de PayPal (404)', async () => {
      jest.spyOn(paypalHttp, 'get').mockRejectedValue(paypalError(404));

      await expect(PayPalPartnerService.fetchSellerStatus('INCONNU')).resolves.toBeNull();
    });

    it('lève une erreur quand PayPal est en panne, plutôt que de déclarer le vendeur inconnu', async () => {
      jest.spyOn(paypalHttp, 'get').mockRejectedValue(paypalError(503));

      await expect(PayPalPartnerService.fetchSellerStatus('MERCHANT-1')).rejects.toThrow();
    });

    it('enregistre le statut rafraîchi : email non confirmé, le vendeur ne peut pas encaisser', async () => {
      const seller = await createTestUser({ paypalMerchantId: 'MERCHANT-1', paypalConnected: true });
      jest.spyOn(paypalHttp, 'get').mockResolvedValue({ data: integration } as never);

      await PayPalPartnerService.refreshSellerStatus(seller._id.toString());

      const saved = await User.findById(seller._id);
      expect(saved?.paypalConnected).toBe(false);
      expect(saved?.paypalOnboarding).toMatchObject({
        paymentsReceivable: true,
        primaryEmailConfirmed: false,
        consentGranted: true,
        legalName: 'Jeanne Martin'
      });
    });
  });
});
