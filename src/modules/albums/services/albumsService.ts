import mongoose from 'mongoose';
import Album from '../../../models/albumModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

function assertValidId(id: string, message: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, message);
  }
}

export async function createAlbumForGroup(albumData: any) {
  const group = await KpopGroup.findById(albumData.artistId);
  if (!group) {
    throw new HttpError(400, 'Groupe non trouvé');
  }

  albumData.artistName = group.name;
  albumData.discoverySource = albumData.discoverySource;
  albumData.lastScraped = new Date();

  const album = new Album(albumData);
  await album.save();

  await album.populate('artistId', 'name description profileImage');

  logger.info('Nouvel album créé', {
    albumId: album._id,
    albumName: album.name,
    groupName: group.name,
    spotifyId: album.spotifyId
  });

  return album;
}

export async function listAlbums(query: any) {
  const page = parseInt(query.page as string) || 1;
  const limit = parseInt(query.limit as string) || 20;
  const sortBy = query.sortBy as string || 'releaseDate';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const filters: any = {};

  if (query.artistId) {
    filters.artistId = query.artistId;
  }

  if (query.artistName) {
    filters.artistName = { $regex: query.artistName, $options: 'i' };
  }

  if (query.search) {
    filters.$or = [
      { name: { $regex: query.search, $options: 'i' } },
      { artistName: { $regex: query.search, $options: 'i' } }
    ];
  }

  if (query.minTracks) {
    const minTracks = parseInt(query.minTracks as string);
    filters.totalTracks = { $gte: minTracks };
  }

  if (query.year) {
    const year = parseInt(query.year as string);
    filters.releaseDate = {
      $gte: new Date(`${year}-01-01`),
      $lt: new Date(`${year + 1}-01-01`)
    };
  }

  const [albums, total] = await Promise.all([
    Album.find(filters)
      .populate('artistId', 'name profileImage')
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Album.countDocuments(filters)
  ]);

  return {
    albums,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function fetchAlbumById(albumId: string) {
  assertValidId(albumId, 'ID d\'album invalide');

  const album = await Album.findById(albumId)
    .populate('artistId', 'name description profileImage socialLinks');

  if (!album) {
    throw new HttpError(404, 'Album non trouvé');
  }

  const availableProducts = await Product.find({
    $or: [
      { albumName: album.name },
      { kpopGroup: album.artistName }
    ],
    isAvailable: true
  })
    .populate('seller', 'username profilePicture statistics.averageRating')
    .sort({ price: 1 })
    .limit(10);

  return {
    album,
    availableProducts,
    stats: {
      totalProducts: availableProducts.length,
      totalTracks: album.totalTracks,
      releaseYear: album.releaseDate ? new Date(album.releaseDate).getFullYear() : null,
      priceRange: availableProducts.length > 0 ? {
        min: Math.min(...availableProducts.map(p => p.price)),
        max: Math.max(...availableProducts.map(p => p.price))
      } : null
    }
  };
}

export async function fetchAlbumsByGroup(groupId: string) {
  assertValidId(groupId, 'ID de groupe invalide');

  const albums = await Album.find({ artistId: groupId })
    .sort({ releaseDate: -1 })
    .lean();

  if (albums.length === 0) {
    return { albums: [], empty: true };
  }

  const albumsWithProducts = await Promise.all(
    albums.map(async (album) => {
      const productCount = await Product.countDocuments({
        $or: [
          { albumName: album.name },
          { kpopGroup: album.artistName }
        ],
        isAvailable: true
      });

      return {
        ...album,
        availableProducts: productCount
      };
    })
  );

  return { albums: albumsWithProducts, empty: false };
}

export async function fetchRecentAlbums(limit: number) {
  return await Album.find({})
    .sort({ releaseDate: -1 })
    .limit(limit)
    .populate('artistId', 'name profileImage')
    .lean();
}

export async function searchAlbumsByQuery({
  query,
  limit
}: {
  query: unknown;
  limit: number;
}) {
  if (!query || typeof query !== 'string') {
    throw new HttpError(400, 'Paramètre de recherche requis');
  }

  const albums = await Album.find({
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { artistName: { $regex: query, $options: 'i' } }
    ]
  })
    .sort({ releaseDate: -1 })
    .limit(limit)
    .populate('artistId', 'name profileImage')
    .lean();

  return {
    albums,
    query,
    found: albums.length
  };
}

export async function updateAlbumById(albumId: string, updates: any) {
  assertValidId(albumId, 'ID d\'album invalide');

  if (updates.artistId) {
    const group = await KpopGroup.findById(updates.artistId);
    if (!group) {
      throw new HttpError(400, 'Groupe non trouvé');
    }
    updates.artistName = group.name;
  }

  updates.lastScraped = new Date();

  const album = await Album.findByIdAndUpdate(
    albumId,
    { $set: updates },
    { new: true, runValidators: true }
  ).populate('artistId', 'name description profileImage');

  if (!album) {
    throw new HttpError(404, 'Album non trouvé');
  }

  logger.info('Album mis à jour', {
    albumId,
    albumName: album.name,
    artistName: album.artistName,
    spotifyId: album.spotifyId
  });

  return album;
}

export async function deleteAlbumById(albumId: string) {
  assertValidId(albumId, 'ID d\'album invalide');

  const album = await Album.findByIdAndDelete(albumId);

  if (!album) {
    throw new HttpError(404, 'Album non trouvé');
  }

  logger.info('Album supprimé', {
    albumId,
    albumName: album.name,
    artistName: album.artistName,
    spotifyId: album.spotifyId
  });
}

export async function fetchAlbumBySpotifyId(spotifyId: string) {
  const album = await Album.findOne({ spotifyId })
    .populate('artistId', 'name description profileImage');

  if (!album) {
    throw new HttpError(404, 'Album non trouvé');
  }

  return album;
}
