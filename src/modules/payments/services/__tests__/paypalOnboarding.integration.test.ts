import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import User from '../../../../models/userModel';
import { PayPalPartnerService, SellerStatus } from '../paypalPartnerService';

const MERCHANT_ID = 'MERCHANT-ONBOARD';

function sellerStatus(trackingId: string | null): SellerStatus {
  return {
    merchantId: MERCHANT_ID,
    paymentsReceivable: true,
    primaryEmailConfirmed: true,
    consentGranted: true,
    scopes: [],
    legalName: null,
    primaryEmail: null,
    trackingId
  };
}

/**
 * Le merchant ID du retour d'onboarding transite par le navigateur du vendeur :
 * il n'est enregistré qu'une fois PayPal ayant confirmé qu'il provient d'une
 * referral de CE vendeur.
 */
describe('PayPalPartnerService.completeOnboarding (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
  });

  async function setupSeller() {
    const seller = await createTestUser();
    const trackingId = `${seller._id}-abcd1234`;
    await User.updateOne({ _id: seller._id }, { paypalTrackingId: trackingId });
    return { sellerId: seller._id.toString(), trackingId };
  }

  it('enregistre le marchand quand PayPal le rattache à une referral du vendeur', async () => {
    const { sellerId, trackingId } = await setupSeller();
    jest.spyOn(PayPalPartnerService, 'fetchSellerStatus').mockResolvedValue(sellerStatus(trackingId));

    await PayPalPartnerService.completeOnboarding(sellerId, MERCHANT_ID, trackingId);

    expect(await User.findById(sellerId)).toMatchObject({ paypalMerchantId: MERCHANT_ID, paypalConnected: true });
  });

  it('refuse, sans rien enregistrer, un marchand rattaché à la referral d\'un autre vendeur', async () => {
    const { sellerId, trackingId } = await setupSeller();
    const other = await createTestUser();
    jest.spyOn(PayPalPartnerService, 'fetchSellerStatus').mockResolvedValue(sellerStatus(`${other._id}-ffff0000`));

    await expect(PayPalPartnerService.completeOnboarding(sellerId, MERCHANT_ID, trackingId))
      .rejects.toThrow('ne correspond pas');

    expect((await User.findById(sellerId))?.paypalMerchantId).toBeNull();
  });

  it('refuse quand PayPal ne renvoie pas de tracking_id : le rattachement est invérifiable', async () => {
    const { sellerId, trackingId } = await setupSeller();
    jest.spyOn(PayPalPartnerService, 'fetchSellerStatus').mockResolvedValue(sellerStatus(null));

    await expect(PayPalPartnerService.completeOnboarding(sellerId, MERCHANT_ID, trackingId)).rejects.toThrow();

    expect((await User.findById(sellerId))?.paypalMerchantId).toBeNull();
  });

  it('n\'enregistre rien si PayPal est injoignable', async () => {
    const { sellerId, trackingId } = await setupSeller();
    jest.spyOn(PayPalPartnerService, 'fetchSellerStatus').mockRejectedValue(new Error('timeout'));

    await expect(PayPalPartnerService.completeOnboarding(sellerId, MERCHANT_ID, trackingId)).rejects.toThrow('timeout');

    expect((await User.findById(sellerId))?.paypalMerchantId).toBeNull();
  });
});
