import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../tests/helpers/fixtures';
import Product from '../../models/productModel';
import Conversation from '../../models/conversationModel';
import { dropLegacyFields } from '../dropLegacyFields';

describe('dropLegacyFields (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function legacyDocuments() {
    const seller = await createTestUser();
    const buyer = await createTestUser();
    const reserved = await createTestProduct(seller._id);
    const clean = await createTestProduct(seller._id);
    await Product.collection.updateOne(
      { _id: reserved._id },
      { $set: { isReserved: true, reservedFor: buyer._id, reservedUntil: new Date() } }
    );
    const pwyw = await Conversation.collection.insertOne({
      participants: [seller._id, buyer._id],
      createdBy: buyer._id,
      type: 'pay_what_you_want',
      payWhatYouWant: { minimumPrice: 5, status: 'pending' },
      offerHistory: []
    });
    const general = await Conversation.create({ participants: [seller._id, buyer._id], createdBy: buyer._id });
    return { reserved, clean, pwywId: pwyw.insertedId, general };
  }

  it('retire la réservation des produits et convertit les conversations prix libre', async () => {
    const { reserved, pwywId, general } = await legacyDocuments();

    expect(await dropLegacyFields()).toEqual({ products: 1, conversations: 1 });

    const product = await Product.collection.findOne({ _id: reserved._id });
    expect(product).not.toHaveProperty('isReserved');
    expect(product).not.toHaveProperty('reservedFor');
    expect(product).not.toHaveProperty('reservedUntil');
    const converted = await Conversation.collection.findOne({ _id: pwywId });
    expect(converted?.type).toBe('negotiation');
    expect(converted).not.toHaveProperty('payWhatYouWant');
    expect((await Conversation.findById(general._id))?.type).toBe('general');
  });

  it('peut être relancé sans effet', async () => {
    await legacyDocuments();
    await dropLegacyFields();

    expect(await dropLegacyFields()).toEqual({ products: 0, conversations: 0 });
  });
});
