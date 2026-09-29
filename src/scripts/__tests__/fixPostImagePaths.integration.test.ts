import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestUser } from '../../tests/helpers/fixtures';
import Post from '../../modules/posts/model';
import { fixPostImagePaths } from '../fixPostImagePaths';

describe('fixPostImagePaths (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('réécrit les chemins cassés et laisse les bons intacts', async () => {
    const author = await createTestUser();
    const broken = await Post.create({
      author: author._id,
      content: 'Avant le correctif',
      images: ['/uploads/posts/a.jpg', '/uploads/posts/b.jpg']
    });
    const sound = await Post.create({ author: author._id, content: 'Après', images: ['/uploads/products/c.jpg'] });
    const bare = await Post.create({ author: author._id, content: 'Sans image' });

    expect(await fixPostImagePaths()).toBe(1);

    expect((await Post.findById(broken._id))!.images).toEqual(['/uploads/products/a.jpg', '/uploads/products/b.jpg']);
    expect((await Post.findById(sound._id))!.images).toEqual(['/uploads/products/c.jpg']);
    expect((await Post.findById(bare._id))!.images).toEqual([]);
  });

  it('peut être relancé sans effet', async () => {
    const author = await createTestUser();
    await Post.create({ author: author._id, content: 'x', images: ['/uploads/posts/a.jpg'] });

    await fixPostImagePaths();

    expect(await fixPostImagePaths()).toBe(0);
  });
});
