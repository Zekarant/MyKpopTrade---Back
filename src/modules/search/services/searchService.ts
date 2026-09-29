import { SortOrder } from 'mongoose';
import Product from '../../../models/productModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import SearchHistory from '../../../models/historicSearchModel';
import { HttpError } from '../../../commons/utils/httpError';
import { escapeRegex } from '../../../commons/utils/escapeRegex';

export interface SearchFilters {
  query?: string;
  groups?: string[];
  members?: string[];
  albums?: string[];
  priceRange?: {
    min?: number;
    max?: number;
  };
  condition?: string[];
  type?: string;
  albumType?: string;
  era?: string;
  company?: string;
  currency?: string;
}

function buildProductFilters({
  filters,
  userId,
  includeOwnProducts
}: {
  filters: SearchFilters;
  userId?: string;
  includeOwnProducts: boolean;
}): any {
  const searchFilters: any = { isAvailable: true };

  if (userId && !includeOwnProducts) {
    searchFilters.seller = { $ne: userId };
  }

  const { query, groups, members, albums, priceRange, condition, type, currency } = filters;

  if (typeof query === 'string' && query.trim()) {
    const pattern = escapeRegex(query.trim());
    searchFilters.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
      { kpopGroup: { $regex: pattern, $options: 'i' } },
      { kpopMember: { $regex: pattern, $options: 'i' } },
      { albumName: { $regex: pattern, $options: 'i' } }
    ];
  }

  const exactMatch = (value: unknown) => new RegExp(`^${escapeRegex(String(value))}$`, 'i');
  if (Array.isArray(groups) && groups.length) searchFilters.kpopGroup = { $in: groups.map(exactMatch) };
  if (Array.isArray(members) && members.length) searchFilters.kpopMember = { $in: members.map(exactMatch) };
  if (Array.isArray(albums) && albums.length) searchFilters.albumName = { $in: albums.map(exactMatch) };
  if (type) searchFilters.type = type;
  if (condition?.length) searchFilters.condition = { $in: condition };
  if (currency) searchFilters.currency = currency;

  if (priceRange) {
    searchFilters.price = {};
    if (priceRange.min !== undefined) searchFilters.price.$gte = priceRange.min;
    if (priceRange.max !== undefined) searchFilters.price.$lte = priceRange.max;
  }

  return searchFilters;
}

function getSortOption(sortBy: string): Record<string, SortOrder> {
  switch (sortBy) {
    case 'price_asc':
      return { price: 1 as SortOrder };
    case 'price_desc':
      return { price: -1 as SortOrder };
    case 'newest':
      return { createdAt: -1 as SortOrder };
    case 'oldest':
      return { createdAt: 1 as SortOrder };
    case 'popular':
      return { views: -1 as SortOrder, favorites: -1 as SortOrder };
    case 'relevance':
    default:
      return { createdAt: -1 as SortOrder };
  }
}

export async function runAdvancedSearch({
  filters,
  userId,
  includeOwnProducts,
  page,
  limit,
  sortBy
}: {
  filters: SearchFilters;
  userId?: string;
  includeOwnProducts: boolean;
  page: number;
  limit: number;
  sortBy: string;
}) {
  const { query, groups, members, albums, priceRange, condition, type, albumType, era, company } = filters;

  const searchFilters = buildProductFilters({ filters, userId, includeOwnProducts });

  const [products, total] = await Promise.all([
    Product.find(searchFilters)
      .populate('seller', 'username profilePicture isIdentityVerified statistics.averageRating')
      .sort(getSortOption(sortBy))
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(searchFilters)
  ]);

  if (userId && query && query.trim()) {
    await SearchHistory.findOneAndUpdate(
      { userId, query: query.toLowerCase().trim() },
      {
        userId,
        query: query.toLowerCase().trim(),
        filters: { groups, members, albums, priceRange, condition, type, albumType, era, company },
        resultCount: total,
        lastSearched: new Date(),
        $inc: { searchCount: 1 }
      },
      { upsert: true, new: true }
    );
  }

  return {
    products,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    },
    searchMetadata: {
      query: query?.trim(),
      appliedFilters: { groups, members, albums, priceRange, condition, type, albumType, era, company },
      resultCount: total,
      sortBy,
      excludedOwnProducts: Boolean(userId) && !includeOwnProducts
    }
  };
}

export async function fetchUserSearchHistory(userId: string, limit: number) {
  return await SearchHistory.find({ userId })
    .sort({ lastSearched: -1 })
    .limit(limit)
    .lean();
}

export async function removeSearchHistoryItem(userId: string, historyId: string) {
  const deleted = await SearchHistory.findOneAndDelete({
    _id: historyId,
    userId
  });

  if (!deleted) {
    throw new HttpError(404, 'Élément d\'historique non trouvé');
  }
}

export async function clearUserSearchHistory(userId: string) {
  await SearchHistory.deleteMany({ userId });
}

const SUGGESTION_LIMIT = 5;
/** Au-delà, ce n'est plus une saisie en cours : inutile de lancer trois regex. */
const MAX_SUGGESTION_QUERY_LENGTH = 100;

/**
 * Suggestions de la barre de recherche : groupes, albums et membres.
 *
 * Cette fonction interrogeait des champs qui n'existent dans aucun schéma
 * (`koreanName`, `members` sur les groupes ; `title`, `group` sur les albums) :
 * le `populate('group')` levait une erreur et la route répondait 500 à chaque
 * frappe. Les membres ne sont pas modélisés sur les groupes ; ils sont tirés
 * des annonces en ligne, seule source où ils figurent.
 */
export async function fetchSearchSuggestions(query: unknown) {
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    throw new HttpError(400, 'Requête trop courte pour les suggestions');
  }
  const pattern = escapeRegex(query.trim().slice(0, MAX_SUGGESTION_QUERY_LENGTH));
  const matches = { $regex: pattern, $options: 'i' };

  const [groups, albums, members] = await Promise.all([
    KpopGroup.find({ name: matches, isActive: true })
      .select('name profileImage')
      .limit(SUGGESTION_LIMIT)
      .lean(),

    Album.find({ name: matches })
      .select('name coverImage artistName')
      .limit(SUGGESTION_LIMIT)
      .lean(),

    Product.aggregate<{ name: string; groupName: string }>([
      { $match: { isAvailable: true, kpopMember: matches } },
      { $group: { _id: '$kpopMember', groupName: { $first: '$kpopGroup' } } },
      { $sort: { _id: 1 } },
      { $limit: SUGGESTION_LIMIT },
      { $project: { _id: 0, name: '$_id', groupName: 1 } }
    ])
  ]);

  return { groups, albums, members };
}
