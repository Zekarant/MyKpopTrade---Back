import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestUser } from '../../tests/helpers/fixtures';
import User from '../../models/userModel';
import Post from '../../models/postModel';
import { decodeStoredHtmlEntities } from '../0006-decodeStoredHtmlEntities';

describe('decodeStoredHtmlEntities (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('décode les entités des textes stockés, chaînes imbriquées comprises, sans toucher au reste', async () => {
    const author = await createTestUser();
    await User.collection.updateOne(
      { _id: author._id },
      { $set: { bio: 'Rock &amp; roll &lt;3', 'socialLinks.instagram': 'https://x.test/?a=1&amp;b=2' } }
    );
    const { insertedId } = await Post.collection.insertOne({
      author: author._id,
      content: 'Prix &gt; 10 € &amp; port offert',
      createdAt: new Date()
    });

    expect(await decodeStoredHtmlEntities()).toBe(2);

    const user = await User.collection.findOne({ _id: author._id });
    expect(user?.bio).toBe('Rock & roll <3');
    expect(user?.socialLinks.instagram).toBe('https://x.test/?a=1&b=2');
    expect(user?.email).toBe(author.email);
    expect((await Post.collection.findOne({ _id: insertedId }))?.content).toBe('Prix > 10 € & port offert');
  });

  it('ne réécrit rien quand aucun texte ne contient d\'entité', async () => {
    await createTestUser();

    expect(await decodeStoredHtmlEntities()).toBe(0);
  });
});
