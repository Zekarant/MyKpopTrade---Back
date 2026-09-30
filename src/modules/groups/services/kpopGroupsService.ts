import mongoose from 'mongoose';
import KpopGroup, { IKpopGroup } from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { clampLimit } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';
import { pickFields } from '../../../commons/utils/pickFields';

const CATALOG_MAX_LIMIT = 2000;

const EDITABLE_GROUP_FIELDS = [
  'name', 'profileImage', 'bannerImage', 'socialLinks', 'tags', 'genres', 'members', 'spotifyId', 'isActive'
] as const;

function assertValidGroupId(groupId: string) {
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    throw new HttpError(400, 'ID de groupe invalide');
  }
}

export async function createGroup(body: Record<string, unknown>) {
  const groupData = pickFields(body, EDITABLE_GROUP_FIELDS);
  if (typeof groupData.name !== 'string' || !groupData.name.trim()) {
    throw new HttpError(400, 'Nom du groupe requis');
  }

  const existingGroup = await KpopGroup.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(groupData.name.trim())}$`, 'i') }
  });

  if (existingGroup) {
    throw new HttpError(400, 'Un groupe avec ce nom existe déjà');
  }

  const group = new KpopGroup({
    ...groupData,
    discoverySource: 'Manual',
    lastScraped: new Date()
  });
  await group.save();

  logger.info('Nouveau groupe K-pop créé', {
    groupId: group._id,
    groupName: group.name
  });

  return group;
}

export async function listGroups(query: Record<string, unknown>) {
  const page = queryInt(query.page) || 1;
  // Le panneau admin K-pop charge jusqu'à 2000 groupes d'un coup.
  const limit = clampLimit(query.limit, 20, CATALOG_MAX_LIMIT);
  const sortBy = queryString(query.sortBy) || 'name';
  const sortOrder = query.sortOrder === 'desc' ? -1 : 1;

  const filters: mongoose.QueryFilter<IKpopGroup> = {};

  const genre = queryString(query.genre);
  const tag = queryString(query.tag);
  const search = queryString(query.search);
  if (genre) {
    filters.genres = { $in: [genre] };
  }

  if (tag) {
    filters.tags = { $in: [tag] };
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    filters.$or = [
      { name: { $regex: searchRegex } },
      { tags: { $elemMatch: { $regex: searchRegex } } },
      { genres: { $elemMatch: { $regex: searchRegex } } }
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

  const searchRegex = new RegExp(escapeRegex(query.trim()), 'i');

  const filters: mongoose.QueryFilter<IKpopGroup> = {
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

  const albumStats = await Album.aggregate<{
    _id: unknown;
    albumCount: number;
    totalTracks: number;
    latestRelease: Date | null;
  }>([
    { $match: { artistId: { $in: groups.map((group) => group._id) } } },
    {
      $group: {
        _id: '$artistId',
        albumCount: { $sum: 1 },
        totalTracks: { $sum: '$totalTracks' },
        latestRelease: { $max: '$releaseDate' }
      }
    }
  ]);
  const statsByGroup = new Map(albumStats.map(({ _id, ...stats }) => [String(_id), stats]));

  const enrichedGroups = groups.map((group) => ({
    ...group,
    stats: statsByGroup.get(String(group._id)) ?? { albumCount: 0, totalTracks: 0, latestRelease: null }
  }));

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

  const totalTracks = albums.reduce((sum: number, album) => sum + (album.totalTracks || 0), 0);

  const albumStats = {
    totalAlbums: albums.length,
    totalTracks,
    averageTracksPerAlbum: albums.length > 0
      ? Math.round((totalTracks / albums.length) * 10) / 10
      : 0,
    latestAlbum: albums.length > 0 ? albums[0] : null,
    oldestAlbum: albums.length > 0 ? albums[albums.length - 1] : null,
    releaseYears: albums
      .filter((album) => album.releaseDate)
      .map((album) => new Date(album.releaseDate!).getFullYear())
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

export async function updateGroup(groupId: string, body: Record<string, unknown>) {
  assertValidGroupId(groupId);

  const oldGroup = await KpopGroup.findById(groupId);
  if (!oldGroup) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  const updates: Record<string, unknown> = pickFields(body, EDITABLE_GROUP_FIELDS);
  updates.lastScraped = new Date();

  const group = await KpopGroup.findByIdAndUpdate(
    groupId,
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  );

  if (updates.name && updates.name !== oldGroup.name) {
    const updateResult = await Album.updateMany(
      { artistId: groupId },
      { $set: { artistName: updates.name as string } }
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
