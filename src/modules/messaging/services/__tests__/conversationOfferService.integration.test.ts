import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import {
  initiateNegotiationFlow,
  respondToNegotiationFlow,
  cancelOfferFlow,
  fetchConversationOffers,
  initiatePayWhatYouWantFlow,
  makePayWhatYouWantProposalFlow
} from '../conversationOfferService';
import Conversation from '../../../../models/conversationModel';
import Message from '../../../../models/messageModel';
import Product from '../../../../models/productModel';

describe('conversationOfferService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('initiateNegotiationFlow', () => {
    it('crée une nouvelle conversation de négociation avec offre initiale', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      const result = await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 70
      });

      expect(result.isUpdate).toBe(false);
      expect(result.initialOffer).toBe(70);
      expect(result.previousOffer).toBeNull();

      const conv = await Conversation.findOne({ productId: product._id, type: 'negotiation' });
      expect(conv).not.toBeNull();
      expect(conv?.offerHistory.length).toBe(1);
      expect(conv?.offerHistory[0].amount).toBe(70);
      expect(conv?.offerHistory[0].status).toBe('pending');
      expect(conv?.negotiation?.initialPrice).toBe(100);
      expect(conv?.negotiation?.status).toBe('pending');

      const refreshedProduct = await Product.findById(product._id).select('+negotiations');
      expect(refreshedProduct?.negotiations?.length).toBe(1);
      expect(refreshedProduct?.negotiations?.[0].currentOffer).toBe(70);
    });

    it('rejette une offre sous le seuil minOfferPercentage', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await expect(
        initiateNegotiationFlow({
          userId: buyer._id.toString(),
          productId: product._id.toString(),
          initialOffer: 30
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejette si le produit n\'accepte pas les offres', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        allowOffers: false
      });

      await expect(
        initiateNegotiationFlow({
          userId: buyer._id.toString(),
          productId: product._id.toString(),
          initialOffer: 50
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejette si le vendeur tente d\'acheter son propre produit', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        allowOffers: true,
        minOfferPercentage: 50
      });

      await expect(
        initiateNegotiationFlow({
          userId: seller._id.toString(),
          productId: product._id.toString(),
          initialOffer: 60
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('met à jour l\'offre existante et expire la précédente (isUpdate=true)', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 60
      });

      const result = await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 75
      });

      expect(result.isUpdate).toBe(true);
      expect(result.previousOffer).toBe(60);

      const conv = await Conversation.findOne({ productId: product._id, type: 'negotiation' });
      expect(conv?.offerHistory.length).toBe(2);
      expect(conv?.offerHistory[0].status).toBe('expired');
      expect(conv?.offerHistory[1].status).toBe('pending');
      expect(conv?.offerHistory[1].amount).toBe(75);
      expect(conv?.negotiation?.currentOffer).toBe(75);
    });
  });

  describe('respondToNegotiationFlow', () => {
    async function setupPendingOffer() {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 70
      });

      const conv = await Conversation.findOne({ productId: product._id, type: 'negotiation' });
      return { seller, buyer, product, conversationId: conv!._id.toString() };
    }

    it('accepte l\'offre : statut accepted sur conv, negotiation et product', async () => {
      const { seller, product, conversationId } = await setupPendingOffer();

      const result = await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'accept'
      });

      expect(result.action).toBe('accept');

      const conv = await Conversation.findById(conversationId);
      expect(conv?.negotiation?.status).toBe('accepted');
      expect(conv?.offerHistory[0].status).toBe('accepted');

      const refreshedProduct = await Product.findById(product._id).select('+negotiations');
      expect(refreshedProduct?.negotiations?.[0].status).toBe('accepted');
    });

    it('rejette l\'offre avec une raison : ajoute la raison au message système', async () => {
      const { seller, conversationId } = await setupPendingOffer();

      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'reject',
        message: 'Trop bas'
      });

      const messages = await Message.find({ conversation: conversationId, isSystemMessage: true });
      const systemMsg = messages[messages.length - 1];
      expect(systemMsg.content).toContain('refusée');
      expect(systemMsg.content).toContain('Trop bas');

      const conv = await Conversation.findById(conversationId);
      expect(conv?.negotiation?.status).toBe('rejected');
    });

    it('contre-offre : expire l\'offre initiale et ajoute une nouvelle offre pending', async () => {
      const { seller, conversationId } = await setupPendingOffer();

      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'counter',
        counterOffer: 85
      });

      const conv = await Conversation.findById(conversationId);
      expect(conv?.offerHistory.length).toBe(2);
      expect(conv?.offerHistory[0].status).toBe('rejected');
      expect(conv?.offerHistory[1].status).toBe('pending');
      expect(conv?.offerHistory[1].amount).toBe(85);
      expect(conv?.offerHistory[1].offerType).toBe('counter');
      expect(conv?.negotiation?.counterOffer).toBe(85);
    });

    it('l\'acheteur accepte la contre-offre du vendeur, et c\'est ce montant qui sera facturé', async () => {
      const { seller, buyer, product, conversationId } = await setupPendingOffer();
      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'counter',
        counterOffer: 85
      });

      await respondToNegotiationFlow({
        userId: buyer._id.toString(),
        conversationId,
        action: 'accept'
      });

      const negotiation = (await Product.findById(product._id).select('+negotiations'))?.negotiations?.[0];
      expect(negotiation?.status).toBe('accepted');
      expect(negotiation?.currentOffer).toBe(85);
      expect(negotiation?.counterOffer).toBeUndefined();
    });

    it('une nouvelle offre de l\'acheteur remplace la contre-offre en attente', async () => {
      const { seller, buyer, product, conversationId } = await setupPendingOffer();
      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'counter',
        counterOffer: 90
      });
      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 80
      });

      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'accept'
      });

      const conv = await Conversation.findById(conversationId);
      expect(conv?.offerHistory.map(offer => offer.status)).toEqual(['rejected', 'expired', 'accepted']);
      const negotiation = (await Product.findById(product._id).select('+negotiations'))?.negotiations?.[0];
      expect(negotiation?.currentOffer).toBe(80);
      expect(negotiation?.counterOffer).toBeUndefined();
    });

    it('403 si l\'auteur de l\'offre tente d\'y répondre', async () => {
      const { buyer, conversationId } = await setupPendingOffer();

      await expect(
        respondToNegotiationFlow({
          userId: buyer._id.toString(),
          conversationId,
          action: 'accept'
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('403 si l\'utilisateur n\'est pas le vendeur', async () => {
      const { conversationId } = await setupPendingOffer();
      const attacker = await createTestUser();

      await expect(
        respondToNegotiationFlow({
          userId: attacker._id.toString(),
          conversationId,
          action: 'accept'
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('400 si counterOffer manquant pour action counter', async () => {
      const { seller, conversationId } = await setupPendingOffer();

      await expect(
        respondToNegotiationFlow({
          userId: seller._id.toString(),
          conversationId,
          action: 'counter'
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 pour une action invalide', async () => {
      const { seller, conversationId } = await setupPendingOffer();

      await expect(
        respondToNegotiationFlow({
          userId: seller._id.toString(),
          conversationId,
          action: 'invalid_action'
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('cancelOfferFlow', () => {
    it('annule l\'offre pending de l\'utilisateur et expire le statut', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 80
      });

      const conv = await Conversation.findOne({ productId: product._id, type: 'negotiation' });

      const result = await cancelOfferFlow(buyer._id.toString(), conv!._id.toString());

      expect(result.amount).toBe(80);

      const updated = await Conversation.findById(conv!._id);
      expect(updated?.offerHistory[0].status).toBe('expired');
      expect(updated?.negotiation?.status).toBe('expired');
    });

    it('404 s\'il n\'existe pas d\'offre pending de l\'utilisateur', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const attacker = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 60
      });

      const conv = await Conversation.findOne({ productId: product._id });

      await expect(
        cancelOfferFlow(attacker._id.toString(), conv!._id.toString())
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('400 si la conversation n\'est pas de type offre', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const conv = await Conversation.create({
        participants: [seller._id, buyer._id],
        type: 'general',
        createdBy: buyer._id,
        lastMessageAt: new Date()
      });

      await expect(
        cancelOfferFlow(buyer._id.toString(), conv._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('fetchConversationOffers', () => {
    it('retourne l\'historique des offres + currentNegotiation', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 70
      });

      const conv = await Conversation.findOne({ productId: product._id });

      const offers = await fetchConversationOffers(
        buyer._id.toString(),
        conv!._id.toString()
      );

      expect(offers.type).toBe('negotiation');
      expect(offers.offerHistory.length).toBe(1);
      expect(offers.currentNegotiation).toBeDefined();
      expect(offers.currentNegotiation?.initialPrice).toBe(100);
      expect(offers.currentNegotiation?.currentOffer).toBe(70);
      expect(offers.isOwner).toBe(false);
    });

    it('marque isOwner=true quand l\'appelant est le vendeur', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        price: 100,
        allowOffers: true,
        minOfferPercentage: 50
      });

      await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 70
      });

      const conv = await Conversation.findOne({ productId: product._id });

      const offers = await fetchConversationOffers(
        seller._id.toString(),
        conv!._id.toString()
      );

      expect(offers.isOwner).toBe(true);
    });
  });

  describe('prix libre (Pay What You Want)', () => {
    async function createPwywProduct() {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, { price: 100, allowOffers: false });
      await initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        minimumPrice: 10,
        maximumPrice: 60
      });
      return { seller, buyer, product };
    }

    it('active le prix libre sur le produit du vendeur', async () => {
      const { product } = await createPwywProduct();

      const refreshed = await Product.findById(product._id).select('+negotiations');
      expect(refreshed?.isPayWhatYouWant).toBe(true);
      expect(refreshed?.pwywMinPrice).toBe(10);
      expect(refreshed?.pwywMaxPrice).toBe(60);
    });

    it('refuse d\'activer le prix libre sur le produit d\'un autre vendeur', async () => {
      const seller = await createTestUser();
      const other = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(initiatePayWhatYouWantFlow({
        userId: other._id.toString(),
        productId: product._id.toString(),
        minimumPrice: 10
      })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuse un maximum inférieur ou égal au minimum', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        minimumPrice: 20,
        maximumPrice: 20
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepte une offre dans la fourchette, même sans offres classiques ni pourcentage minimal', async () => {
      const { buyer, product } = await createPwywProduct();

      const result = await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 15
      });

      expect(result.initialOffer).toBe(15);
      const conv = await Conversation.findOne({ productId: product._id, type: 'negotiation' });
      expect(conv?.offerHistory[0].amount).toBe(15);
    });

    it('refuse une offre hors de la fourchette', async () => {
      const { buyer, product } = await createPwywProduct();
      const offer = (initialOffer: number) => initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer
      });

      await expect(offer(5)).rejects.toMatchObject({ statusCode: 400 });
      await expect(offer(80)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('met à jour la proposition depuis la conversation, et le prix accepté est celui facturé', async () => {
      const { seller, buyer, product } = await createPwywProduct();
      const first = await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 20
      });
      const conversationId = String(first.conversation?._id);

      const proposal = await makePayWhatYouWantProposalFlow({
        userId: buyer._id.toString(),
        conversationId,
        proposedPrice: 35
      });
      expect(proposal.isUpdate).toBe(true);
      expect(proposal.previousOffer).toBe(20);

      await respondToNegotiationFlow({
        userId: seller._id.toString(),
        conversationId,
        action: 'accept'
      });

      const refreshed = await Product.findById(product._id).select('+negotiations');
      const negotiation = refreshed?.negotiations?.find(n => n.buyer.toString() === buyer._id.toString());
      expect(negotiation?.status).toBe('accepted');
      expect(negotiation?.currentOffer).toBe(35);
    });

    it('désactive le prix libre avec enabled: false et efface la fourchette', async () => {
      const { seller, buyer, product } = await createPwywProduct();

      const result = await initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        enabled: false
      });

      expect(result).toMatchObject({ enabled: false, minimumPrice: null, maximumPrice: null });
      const refreshed = await Product.findById(product._id).select('+negotiations');
      expect(refreshed?.isPayWhatYouWant).toBe(false);
      expect(refreshed?.pwywMinPrice).toBeUndefined();
      expect(refreshed?.pwywMaxPrice).toBeUndefined();

      // Sans prix libre ni offres classiques, le produit n'accepte plus d'offre.
      await expect(initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 15
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepte enabled "false" tel qu\'envoyé par un formulaire', async () => {
      const { seller, product } = await createPwywProduct();

      await initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        enabled: 'false'
      });

      expect((await Product.findById(product._id).select('+negotiations'))?.isPayWhatYouWant).toBe(false);
    });

    it('refuse de désactiver le prix libre du produit d\'un autre vendeur', async () => {
      const { buyer, product } = await createPwywProduct();

      await expect(initiatePayWhatYouWantFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        enabled: false
      })).rejects.toMatchObject({ statusCode: 404 });
      expect((await Product.findById(product._id).select('+negotiations'))?.isPayWhatYouWant).toBe(true);
    });

    it('réactive le prix libre avec une nouvelle fourchette, sans maximum', async () => {
      const { seller, product } = await createPwywProduct();
      await initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        enabled: false
      });

      const result = await initiatePayWhatYouWantFlow({
        userId: seller._id.toString(),
        productId: product._id.toString(),
        minimumPrice: 12,
        enabled: true
      });

      expect(result).toMatchObject({ enabled: true, minimumPrice: 12, maximumPrice: null });
      const refreshed = await Product.findById(product._id).select('+negotiations');
      expect(refreshed?.isPayWhatYouWant).toBe(true);
      expect(refreshed?.pwywMinPrice).toBe(12);
      expect(refreshed?.pwywMaxPrice ?? null).toBeNull();
    });

    it('refuse une proposition de prix libre sur un produit qui n\'est pas à prix libre', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, { price: 100, allowOffers: true });
      const first = await initiateNegotiationFlow({
        userId: buyer._id.toString(),
        productId: product._id.toString(),
        initialOffer: 70
      });

      await expect(makePayWhatYouWantProposalFlow({
        userId: buyer._id.toString(),
        conversationId: String(first.conversation?._id),
        proposedPrice: 80
      })).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
