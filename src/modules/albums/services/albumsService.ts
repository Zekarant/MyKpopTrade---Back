import mongoose from 'mongoose';
import type { Request } from 'express';
import Album, { IKpopAlbum } from '../../../models/albumModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { clampLimit } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';

const CATALOG_MAX_LIMIT = 2000;

/** Corps libre d'une requête admin, validé par le schéma Mongoose à l'écriture. */
type AlbumInput = Record<string, unknown>;

function assertValidId(id: string, message: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, message);
  }
}

export async function createAlbumForGroup(albumData: AlbumInput) {
  const group = await KpopGroup.findById(albumData.artistId);
  if (!group) {
    throw new HttpError(400, 'Groupe non trouvé');
  }

  albumData.artistName = group.name;
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

export async function listAlbums(query: Request['query']) {
  const page = queryInt(query.page) || 1;
  // Le panneau admin K-pop charge jusqu'à 2000 albums d'un coup.
  const limit = clampLimit(query.limit, 20, CATALOG_MAX_LIMIT);
  const sortBy = queryString(query.sortBy) || 'releaseDate';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const filters: mongoose.QueryFilter<IKpopAlbum> = {};

  const artistId = queryString(query.artistId);
  if (artistId) {
    if (!mongoose.Types.ObjectId.isValid(artistId)) {
      throw new HttpError(400, 'ID d\'artiste invalide');
    }
    filters.artistId = artistId;
  }

  const artistName = queryString(query.artistName);
  if (artistName) {
    filters.artistName = { $regex: escapeRegex(artistName), $options: 'i' };
  }

  const search = queryString(query.search);
  if (search) {
    const pattern = escapeRegex(search);
    filters.$or = [
      { name: { $regex: pattern, $options: 'i' } },
      { artistName: { $regex: pattern, $options: 'i' } }
    ];
  }

  const minTracks = queryInt(query.minTracks);
  if (!isNaN(minTracks)) {
    filters.totalTracks = { $gte: minTracks };
  }

  const year = queryInt(query.year);
  if (!isNaN(year)) {
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
    .populate('seller', 'username profilePicture isIdentityVerified statistics.averageRating')
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

  // Une seule agrégation par (groupe, album) ; un album compte les annonces de
  // même nom d'album OU de même groupe.
  const names = [...new Set(albums.map((album) => album.name))];
  const artists = [...new Set(albums.map((album) => album.artistName))];
  const pairs = await Product.aggregate<{ _id: { kpopGroup?: string; albumName?: string }; count: number }>([
    { $match: { isAvailable: true, $or: [{ albumName: { $in: names } }, { kpopGroup: { $in: artists } }] } },
    { $group: { _id: { kpopGroup: '$kpopGroup', albumName: '$albumName' }, count: { $sum: 1 } } }
  ]);

  const albumsWithProducts = albums.map((album) => ({
    ...album,
    availableProducts: pairs
      .filter(({ _id }) => _id.albumName === album.name || _id.kpopGroup === album.artistName)
      .reduce((sum, { count }) => sum + count, 0)
  }));

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

  const pattern = escapeRegex(query);
  const albums = await Album.find({
    $or: [
      { name: { $regex: pattern, $options: 'i' } },
      { artistName: { $regex: pattern, $options: 'i' } }
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

export async function updateAlbumById(albumId: string, updates: AlbumInput) {
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
