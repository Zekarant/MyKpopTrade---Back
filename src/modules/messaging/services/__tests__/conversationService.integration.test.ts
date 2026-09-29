import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { fetchConversation } from '../conversationService';
import Conversation from '../../../../models/conversationModel';

describe('conversationService.fetchConversation (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function setupConversation() {
    const seller = await createTestUser({
      isIdentityVerified: true,
      isSellerVerified: true,
      phoneNumber: '+33600000000',
      statistics: {
        totalSales: 4,
        totalPurchases: 2,
        totalListings: 6,
        memberSince: new Date('2025-01-01'),
        lastActive: new Date(),
        averageRating: 4.5,
        totalRatings: 3
      }
    });
    const buyer = await createTestUser();
    const product = await createTestProduct(seller._id, {
      price: 40,
      isPayWhatYouWant: true,
      pwywMinPrice: 10,
      pwywMaxPrice: 35
    });
    const conversation = await Conversation.create({
      participants: [buyer._id, seller._id],
      type: 'negotiation',
      productId: product._id,
      createdBy: buyer._id,
      lastMessageAt: new Date()
    });
    return { seller, buyer, conversationId: conversation._id.toString() };
  }

  it('renvoie l\'interlocuteur avec ses badges, son ancienneté et ses statistiques', async () => {
    const { seller, buyer, conversationId } = await setupConversation();

    const { conversation } = await fetchConversation(conversationId, buyer._id.toString(), 1, 20);
    const other = conversation.otherParticipant as Record<string, unknown>;

    expect(String(other._id)).toBe(seller._id.toString());
    expect(other).toMatchObject({
      username: seller.username,
      isIdentityVerified: true,
      isSellerVerified: true,
      statistics: expect.objectContaining({ totalSales: 4, totalPurchases: 2, averageRating: 4.5, totalRatings: 3 })
    });
    expect(other.createdAt).toBeInstanceOf(Date);
  });

  it('ne divulgue aucun champ privé des participants', async () => {
    const { buyer, conversationId } = await setupConversation();

    const { conversation } = await fetchConversation(conversationId, buyer._id.toString(), 1, 20);

    const participants = conversation.participants as unknown as Record<string, unknown>[];
    for (const participant of participants) {
      for (const field of ['email', 'password', 'phoneNumber', 'address', 'paypalEmail', 'paypalMerchantId', 'twoFactor', 'role']) {
        expect(participant).not.toHaveProperty(field);
      }
    }
  });

  it('expose le prix libre du produit pour la fenêtre d\'offre', async () => {
    const { buyer, conversationId } = await setupConversation();

    const { conversation } = await fetchConversation(conversationId, buyer._id.toString(), 1, 20);

    expect(conversation.productId).toMatchObject({ isPayWhatYouWant: true, pwywMinPrice: 10, pwywMaxPrice: 35 });
  });
});
