import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestUser } from '../../tests/helpers/fixtures';
import Rating from '../../models/ratingModel';
import { dropEmptyRatingResponses } from '../0005-dropEmptyRatingResponses';

describe('dropEmptyRatingResponses (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function legacyRatings() {
    const [reviewer, seller] = [await createTestUser(), await createTestUser()];
    const base = { reviewer: reviewer._id, recipient: seller._id, rating: 5, type: 'seller' };
    // Un avis par transaction et par auteur (index unique).
    const { insertedIds } = await Rating.collection.insertMany([
      { ...base, transaction: new Types.ObjectId(), response: { createdAt: new Date() } },
      { ...base, transaction: new Types.ObjectId(), response: { content: 'Merci !', createdAt: new Date() } }
    ]);
    return { empty: insertedIds[0], answered: insertedIds[1] };
  }

  it('retire les réponses sans contenu et garde les vraies réponses', async () => {
    const { empty, answered } = await legacyRatings();

    expect(await dropEmptyRatingResponses()).toBe(1);

    expect(await Rating.collection.findOne({ _id: empty })).not.toHaveProperty('response');
    expect((await Rating.collection.findOne({ _id: answered }))?.response.content).toBe('Merci !');
  });

  it('peut être relancé sans effet', async () => {
    await legacyRatings();
    await dropEmptyRatingResponses();

    expect(await dropEmptyRatingResponses()).toBe(0);
  });
});
