import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import { toggleFollow, getFollowStatusForUser, listGroupFollowers } from '../groupFollowService';
import KpopGroup, { IKpopGroup } from '../../../../models/kpopGroupModel';

async function createTestGroup(overrides: Partial<Pick<IKpopGroup, 'name' | 'followersCount' | 'isActive'>> = {}) {
  const defaults = {
    name: `Group_${Date.now()}_${Math.random()}`,
    followersCount: 0
  };
  return await KpopGroup.create({ ...defaults, ...overrides });
}

describe('groupFollowService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('toggleFollow', () => {
    it('fait suivre le groupe au premier appel', async () => {
      const user = await createTestUser();
      const group = await createTestGroup();

      const result = await toggleFollow(user._id.toString(), group._id.toString());

      expect(result.isFollowing).toBe(true);
      expect(result.followersCount).toBe(1);
      expect(result.message).toBe('Vous suivez maintenant ce groupe');
    });

    it('arrête de suivre le groupe au second appel', async () => {
      const user = await createTestUser();
      const group = await createTestGroup();

      await toggleFollow(user._id.toString(), group._id.toString());
      const result = await toggleFollow(user._id.toString(), group._id.toString());

      expect(result.isFollowing).toBe(false);
      expect(result.followersCount).toBe(0);
      expect(result.message).toBe('Vous ne suivez plus ce groupe');
    });

    it('rejette avec 400 si groupId invalide', async () => {
      const user = await createTestUser();
      await expect(
        toggleFollow(user._id.toString(), 'not-an-id')
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejette avec 404 si le groupe n\'existe pas', async () => {
      const user = await createTestUser();
      const ghostId = '507f1f77bcf86cd799439011';
      await expect(
        toggleFollow(user._id.toString(), ghostId)
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('getFollowStatusForUser', () => {
    it('retourne isFollowing true après un follow', async () => {
      const user = await createTestUser();
      const group = await createTestGroup();

      await toggleFollow(user._id.toString(), group._id.toString());

      const status = await getFollowStatusForUser(
        user._id.toString(),
        group._id.toString()
      );

      expect(status.isFollowing).toBe(true);
      expect(status.groupName).toBe(group.name);
    });

    it('retourne isFollowing false si jamais suivi', async () => {
      const user = await createTestUser();
      const group = await createTestGroup();

      const status = await getFollowStatusForUser(
        user._id.toString(),
        group._id.toString()
      );

      expect(status.isFollowing).toBe(false);
      expect(status.followersCount).toBe(0);
    });
  });

  describe('listGroupFollowers', () => {
    // Forme consommée par le panneau admin K-pop (groupService.getFollowers côté front).
    it('renvoie les followers paginés, sans email', async () => {
      const [first, second] = [await createTestUser(), await createTestUser()];
      const group = await createTestGroup();
      await toggleFollow(first._id.toString(), group._id.toString());
      await toggleFollow(second._id.toString(), group._id.toString());

      const result = await listGroupFollowers(group._id.toString(), 1, 1);

      expect(result.groupName).toBe(group.name);
      expect(result.pagination).toEqual({ page: 1, limit: 1, total: 2, pages: 2 });
      expect(result.followers).toHaveLength(1);
      const follower: unknown = JSON.parse(JSON.stringify(result.followers[0]));
      expect(follower).toEqual(expect.objectContaining({ _id: expect.any(String), username: expect.any(String) }));
      expect(follower).not.toHaveProperty('email');
    });
  });
});
