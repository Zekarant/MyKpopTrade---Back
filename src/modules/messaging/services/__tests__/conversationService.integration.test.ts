import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { fetchConversation, fetchConversationMedia } from '../conversationService';
import Conversation from '../../../../models/conversationModel';
import Message from '../../../../models/messageModel';

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

describe('conversationService.fetchConversationMedia (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  /** Conversation dont les messages (du plus récent au plus ancien) portent ces pièces jointes. */
  async function setupConversationWithAttachments(attachmentsByMessage: string[][]) {
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const conversation = await Conversation.create({
      participants: [buyer._id, seller._id],
      createdBy: buyer._id,
      lastMessageAt: new Date()
    });
    const now = Date.now();
    await Message.insertMany(attachmentsByMessage.map((attachments, index) => ({
      conversation: conversation._id,
      sender: buyer._id,
      content: 'pièce jointe',
      attachments,
      createdAt: new Date(now - index * 1000)
    })));
    return { userId: buyer._id.toString(), conversationId: conversation._id.toString() };
  }

  it('filtre par type avant de paginer et compte le total réel', async () => {
    // Les images sont noyées parmi des PDF : filtrer après pagination rendait
    // des pages vides et un total égal à la taille de la page.
    const { userId, conversationId } = await setupConversationWithAttachments([
      ['a.pdf'], ['b.pdf'], ['photo1.jpg'], ['c.pdf'], ['photo2.png', 'd.pdf'], ['photo3.webp']
    ]);

    const firstPage = await fetchConversationMedia({ userId, conversationId, page: 1, limit: 2, type: 'image' });
    const secondPage = await fetchConversationMedia({ userId, conversationId, page: 2, limit: 2, type: 'image' });

    expect(firstPage.media.map((item) => item.filename)).toEqual(['photo1.jpg', 'photo2.png']);
    expect(secondPage.media.map((item) => item.filename)).toEqual(['photo3.webp']);
    expect(firstPage.pagination).toEqual({ total: 3, page: 1, limit: 2, pages: 2 });
  });

  it('pagine par pièce jointe, pas par message', async () => {
    const { userId, conversationId } = await setupConversationWithAttachments([
      ['a.jpg', 'b.jpg', 'c.pdf'], ['d.txt']
    ]);

    const result = await fetchConversationMedia({ userId, conversationId, page: 1, limit: 2 });

    expect(result.media.map((item) => item.filename)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.media[0].uploadedBy).toMatchObject({ username: expect.any(String) });
    expect(result.pagination).toEqual({ total: 4, page: 1, limit: 2, pages: 2 });
  });

  it('ne renvoie rien pour un type inconnu', async () => {
    const { userId, conversationId } = await setupConversationWithAttachments([['a.jpg']]);

    const result = await fetchConversationMedia({ userId, conversationId, page: 1, limit: 10, type: 'constructor' });

    expect(result.media).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});
