import { SortOrder } from 'mongoose';
import Product from '../../../models/productModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import SearchHistory from '../../../models/historicSearchModel';
import { HttpError } from '../../../commons/utils/httpError';

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

  if (query && query.trim()) {
    searchFilters.$or = [
      { title: { $regex: query.trim(), $options: 'i' } },
      { description: { $regex: query.trim(), $options: 'i' } },
      { kpopGroup: { $regex: query.trim(), $options: 'i' } },
      { kpopMember: { $regex: query.trim(), $options: 'i' } },
      { albumName: { $regex: query.trim(), $options: 'i' } }
    ];
  }

  if (groups?.length) searchFilters.kpopGroup = { $in: groups.map(g => new RegExp(`^${g}$`, 'i')) };
  if (members?.length) searchFilters.kpopMember = { $in: members.map(m => new RegExp(`^${m}$`, 'i')) };
  if (albums?.length) searchFilters.albumName = { $in: albums.map(a => new RegExp(`^${a}$`, 'i')) };
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
      .populate('seller', 'username profilePicture statistics.averageRating')
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

export async function fetchSearchSuggestions(query: unknown) {
  if (!query || typeof query !== 'string' || query.length < 2) {
    throw new HttpError(400, 'Requête trop courte pour les suggestions');
  }

  const [groupSuggestions, albumSuggestions, memberSuggestions] = await Promise.all([
    KpopGroup.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { koreanName: { $regex: query, $options: 'i' } }
      ],
      isActive: true
    })
      .select('name koreanName profileImage')
      .limit(5)
      .lean(),

    Album.find({
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { koreanTitle: { $regex: query, $options: 'i' } }
      ]
    })
      .populate('group', 'name')
      .select('title koreanTitle coverImage group')
      .limit(5)
      .lean(),

    KpopGroup.aggregate([
      { $unwind: '$members' },
      {
        $match: {
          $or: [
            { 'members.name': { $regex: query, $options: 'i' } },
            { 'members.stageName': { $regex: query, $options: 'i' } }
          ],
          'members.isActive': true
        }
      },
      {
        $project: {
          memberName: '$members.name',
          memberStageName: '$members.stageName',
          memberImage: '$members.profileImage',
          groupName: '$name'
        }
      },
      { $limit: 5 }
    ])
  ]);

  return {
    groups: groupSuggestions,
    albums: albumSuggestions,
    members: memberSuggestions
  };
}
