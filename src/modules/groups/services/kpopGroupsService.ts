import mongoose from 'mongoose';
import KpopGroup from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

function assertValidGroupId(groupId: string) {
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    throw new HttpError(400, 'ID de groupe invalide');
  }
}

export async function createGroup(groupData: any) {
  const existingGroup = await KpopGroup.findOne({
    name: { $regex: new RegExp(`^${groupData.name}$`, 'i') }
  });

  if (existingGroup) {
    throw new HttpError(400, 'Un groupe avec ce nom existe déjà');
  }

  groupData.discoverySource = 'Manual';
  groupData.lastScraped = new Date();

  const group = new KpopGroup(groupData);
  await group.save();

  logger.info('Nouveau groupe K-pop créé', {
    groupId: group._id,
    groupName: group.name
  });

  return group;
}

export async function listGroups(query: any) {
  const page = parseInt(query.page || '1');
  const limit = parseInt(query.limit || '20');
  const sortBy = query.sortBy || 'name';
  const sortOrder = query.sortOrder === 'desc' ? -1 : 1;

  const filters: any = {};

  if (query.genre) {
    filters.genres = { $in: [query.genre] };
  }

  if (query.tag) {
    filters.tags = { $in: [query.tag] };
  }

  if (query.search) {
    filters.$or = [
      { name: { $regex: query.search, $options: 'i' } },
      { description: { $regex: query.search, $options: 'i' } }
    ];
  }

  const [groups, total] = await Promise.all([
    KpopGroup.find(filters)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    KpopGroup.countDocuments(filters)
  ]);

  return {
    groups,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function searchGroupsByQuery({
  query,
  limit,
  includeInactive
}: {
  query: unknown;
  limit: number;
  includeInactive: boolean;
}) {
  if (!query || typeof query !== 'string') {
    throw new HttpError(400, 'Paramètre de recherche requis');
  }

  const searchRegex = new RegExp(query.trim(), 'i');

  const filters: any = {
    $or: [
      { name: { $regex: searchRegex } },
      { tags: { $elemMatch: { $regex: searchRegex } } },
      { genres: { $elemMatch: { $regex: searchRegex } } }
    ]
  };

  if (!includeInactive) {
    filters.isActive = true;
  }

  const groups = await KpopGroup.find(filters)
    .select('name profileImage genres tags invalidReason followersCount')
    .limit(limit)
    .sort({ isActive: -1, name: 1 })
    .lean();

  const enrichedGroups = await Promise.all(
    groups.map(async (group) => {
      const albumStats = await Album.aggregate([
        { $match: { artistId: group._id } },
        {
          $group: {
            _id: null,
            albumCount: { $sum: 1 },
            totalTracks: { $sum: '$totalTracks' },
            latestRelease: { $max: '$releaseDate' }
          }
        }
      ]);

      return {
        ...group,
        stats: albumStats[0] || { albumCount: 0, totalTracks: 0, latestRelease: null }
      };
    })
  );

  logger.info('Recherche de groupes effectuée', {
    query,
    found: groups.length,
    includeInactive
  });

  return {
    groups: enrichedGroups,
    query,
    found: groups.length,
    includeInactive
  };
}

export async function fetchPopularGroups(limit: number) {
  return await Album.aggregate([
    {
      $group: {
        _id: '$artistId',
        albumCount: { $sum: 1 },
        totalTracks: { $sum: '$totalTracks' },
        latestRelease: { $max: '$releaseDate' }
      }
    },
    { $sort: { albumCount: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'kpopgroups',
        localField: '_id',
        foreignField: '_id',
        as: 'group'
      }
    },
    { $unwind: '$group' },
    {
      $project: {
        _id: '$group._id',
        name: '$group.name',
        profileImage: '$group.profileImage',
        genres: '$group.genres',
        followersCount: '$group.followersCount',
        albumCount: 1,
        totalTracks: 1,
        latestRelease: 1
      }
    }
  ]);
}

export async function fetchGroupWithStats(groupId: string) {
  assertValidGroupId(groupId);

  const group = await KpopGroup.findById(groupId);

  if (!group) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  const albums = await Album.find({ artistId: groupId })
    .sort({ releaseDate: -1 })
    .lean();

  const productStats = await Product.aggregate([
    { $match: { kpopGroup: group.name, isAvailable: true } },
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        averagePrice: { $avg: '$price' },
        minPrice: { $min: '$price' },
        maxPrice: { $max: '$price' }
      }
    }
  ]);

  const totalTracks = albums.reduce((sum: number, album: any) => sum + (album.totalTracks || 0), 0);

  const albumStats = {
    totalAlbums: albums.length,
    totalTracks,
    averageTracksPerAlbum: albums.length > 0
      ? Math.round((totalTracks / albums.length) * 10) / 10
      : 0,
    latestAlbum: albums.length > 0 ? albums[0] : null,
    oldestAlbum: albums.length > 0 ? albums[albums.length - 1] : null,
    releaseYears: albums
      .filter((album: any) => album.releaseDate)
      .map((album: any) => new Date(album.releaseDate!).getFullYear())
      .filter((year: number, index: number, arr: number[]) => arr.indexOf(year) === index)
      .sort((a: number, b: number) => b - a)
  };

  return {
    group,
    albums,
    stats: {
      ...albumStats,
      products: productStats[0] || {
        totalProducts: 0,
        averagePrice: 0,
        minPrice: 0,
        maxPrice: 0
      }
    }
  };
}

export async function updateGroup(groupId: string, updates: any) {
  assertValidGroupId(groupId);

  const oldGroup = await KpopGroup.findById(groupId);
  if (!oldGroup) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  updates.lastScraped = new Date();

  const group = await KpopGroup.findByIdAndUpdate(
    groupId,
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (updates.name && updates.name !== oldGroup.name) {
    const updateResult = await Album.updateMany(
      { artistId: groupId },
      { $set: { artistName: updates.name } }
    );

    logger.info('Nom du groupe mis à jour dans les albums', {
      groupId,
      oldName: oldGroup.name,
      newName: updates.name,
      albumsUpdated: updateResult.modifiedCount
    });
  }

  return group;
}

export async function deleteGroup(groupId: string) {
  assertValidGroupId(groupId);

  const group = await KpopGroup.findById(groupId);

  if (!group) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  const albumsDeleted = await Album.deleteMany({ artistId: groupId });

  await KpopGroup.findByIdAndDelete(groupId);

  logger.info('Groupe et albums supprimés', {
    groupId,
    groupName: group.name,
    albumsDeleted: albumsDeleted.deletedCount
  });

  return albumsDeleted.deletedCount;
}
