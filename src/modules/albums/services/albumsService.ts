import mongoose from 'mongoose';
import Album, { IKpopAlbum } from '../../../models/albumModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { paginationMeta } from '../../../commons/utils/pagination';
import { pickFields } from '../../../commons/utils/pickFields';
import { SELLER_CARD_FIELDS } from '../../../commons/utils/userFields';

/** Corps libre d'une requête admin, validé par le schéma Mongoose à l'écriture. */
type AlbumInput = Record<string, unknown>;

const EDITABLE_ALBUM_FIELDS = [
  'name', 'coverImage', 'artistId', 'spotifyId', 'spotifyUrl', 'releaseDate', 'totalTracks', 'albumType'
] as const;

/** Groupe d'un album dans les listes. */
const ARTIST_CARD_FIELDS = 'name profileImage';
/** Groupe d'un album renvoyé après création ou modification. */
const ARTIST_FIELDS = 'name description profileImage';

function assertValidId(id: string, message: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new HttpError(400, message);
  }
}

export async function createAlbumForGroup(body: AlbumInput) {
  const albumData = pickFields(body, EDITABLE_ALBUM_FIELDS);
  if (!mongoose.Types.ObjectId.isValid(String(albumData.artistId))) {
    throw new HttpError(400, 'Groupe non trouvé');
  }
  const group = await KpopGroup.findById(albumData.artistId);
  if (!group) {
    throw new HttpError(400, 'Groupe non trouvé');
  }

  const album = new Album({
    ...albumData,
    artistName: group.name,
    discoverySource: 'Manual',
    lastScraped: new Date()
  });
  await album.save();

  await album.populate('artistId', ARTIST_FIELDS);

  logger.info('Nouvel album créé', {
    albumId: album._id,
    albumName: album.name,
    groupName: group.name,
    spotifyId: album.spotifyId
  });

  return album;
}

export interface AlbumListParams {
  page: number;
  limit: number;
  sortBy: string;
  sortOrder: 1 | -1;
  artistId?: string;
  artistName?: string;
  search?: string;
  minTracks?: number;
  year?: number;
}

export async function listAlbums({
  page, limit, sortBy, sortOrder, artistId, artistName, search, minTracks, year
}: AlbumListParams) {
  const filters: mongoose.QueryFilter<IKpopAlbum> = {};

  if (artistId) {
    if (!mongoose.Types.ObjectId.isValid(artistId)) {
      throw new HttpError(400, 'ID d\'artiste invalide');
    }
    filters.artistId = artistId;
  }

  if (artistName) {
    filters.artistName = { $regex: escapeRegex(artistName), $options: 'i' };
  }

  if (search) {
    const pattern = escapeRegex(search);
    filters.$or = [
      { name: { $regex: pattern, $options: 'i' } },
      { artistName: { $regex: pattern, $options: 'i' } }
    ];
  }

  if (minTracks !== undefined) {
    filters.totalTracks = { $gte: minTracks };
  }

  if (year !== undefined) {
    filters.releaseDate = {
      $gte: new Date(`${year}-01-01`),
      $lt: new Date(`${year + 1}-01-01`)
    };
  }

  const [albums, total] = await Promise.all([
    Album.find(filters)
      .populate('artistId', ARTIST_CARD_FIELDS)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Album.countDocuments(filters)
  ]);

  return {
    albums,
    pagination: paginationMeta({ page, limit }, total)
  };
}

export async function fetchAlbumById(albumId: string) {
  assertValidId(albumId, 'ID d\'album invalide');

  const album = await Album.findById(albumId)
    .populate('artistId', `${ARTIST_FIELDS} socialLinks`);

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
    .populate('seller', SELLER_CARD_FIELDS)
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

export async function searchAlbumsByQuery({
  query,
  limit
}: {
  query?: string;
  limit: number;
}) {
  if (!query) {
    throw new HttpError(400, 'Paramètre de recherche requis', 'SEARCH_QUERY_REQUIRED');
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
    .populate('artistId', ARTIST_CARD_FIELDS)
    .lean();

  return {
    albums,
    query,
    found: albums.length
  };
}

export async function updateAlbumById(albumId: string, body: AlbumInput) {
  assertValidId(albumId, 'ID d\'album invalide');

  const updates: Record<string, unknown> = pickFields(body, EDITABLE_ALBUM_FIELDS);
  if (updates.artistId) {
    if (!mongoose.Types.ObjectId.isValid(String(updates.artistId))) {
      throw new HttpError(400, 'Groupe non trouvé');
    }
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
    { returnDocument: 'after', runValidators: true }
  ).populate('artistId', ARTIST_FIELDS);

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
