import User from '../../../models/userModel';
import Product from '../../../models/productModel';

function buildInventoryFilter(sellerId: string, status: string): any {
  const filter: any = { seller: sellerId };

  switch (status) {
    case 'available':
      filter.isAvailable = true;
      break;
    case 'sold':
      filter.isAvailable = false;
      break;
    case 'reserved':
      filter.isAvailable = true;
      filter.isReserved = true;
      break;
    case 'all':
      break;
    default:
      filter.isAvailable = true;
  }

  return filter;
}

export async function fetchUserInventory({
  sellerId,
  viewerId,
  status,
  page,
  limit
}: {
  sellerId: string;
  viewerId?: string;
  status: string;
  page: number;
  limit: number;
}) {
  const filter = buildInventoryFilter(sellerId, status);

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter)
  ]);

  let inventoryStats = null;
  if (viewerId === sellerId) {
    const stats = await Product.aggregate([
      { $match: { seller: sellerId } },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          soldProducts: { $sum: { $cond: [{ $eq: ['$isAvailable', false] }, 1, 0] } },
          reservedProducts: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$isAvailable', true] },
                    { $eq: ['$isReserved', true] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalViews: { $sum: '$views' },
          totalFavorites: { $sum: '$favorites' }
        }
      }
    ]);
    inventoryStats = stats[0] || null;
  }

  return {
    products,
    stats: inventoryStats,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function fetchUserFavorites(userId: string, page: number, limit: number) {
  const user = await User.findById(userId, { favorites: 1 });

  if (!user || !user.favorites || user.favorites.length === 0) {
    return {
      products: [],
      pagination: { page, limit, total: 0, pages: 0 }
    };
  }

  const favoriteIds = user.favorites;

  const [products, total] = await Promise.all([
    Product.find({ _id: { $in: favoriteIds } })
      .populate('seller', 'username profilePicture')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments({ _id: { $in: favoriteIds } })
  ]);

  return {
    products,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

async function buildPersonalizedRecommendations(userId: string, limit: number): Promise<any[]> {
  const user = await User.findById(userId, { favorites: 1, preferences: 1 });

  if (!user) return [];

  const favoriteProducts = await Product.find(
    { _id: { $in: user.favorites || [] } },
    { kpopGroup: 1, type: 1, kpopMember: 1 }
  );

  const preferredGroups = [...new Set(favoriteProducts.map(p => p.kpopGroup).filter(Boolean))];
  const preferredTypes = [...new Set(favoriteProducts.map(p => p.type).filter(Boolean))];
  const preferredMembers = [...new Set(favoriteProducts.map(p => p.kpopMember).filter(Boolean))];

  const userPreferredGroups = user.preferences?.kpopGroups || [];
  const allPreferredGroups = [...new Set([...preferredGroups, ...userPreferredGroups])];

  const recommendationQuery: any = {
    isAvailable: true,
    seller: { $ne: userId },
    _id: { $nin: user.favorites || [] }
  };

  if (allPreferredGroups.length > 0 || preferredTypes.length > 0 || preferredMembers.length > 0) {
    recommendationQuery.$or = [];

    if (allPreferredGroups.length > 0) {
      recommendationQuery.$or.push({ kpopGroup: { $in: allPreferredGroups } });
    }

    if (preferredTypes.length > 0) {
      recommendationQuery.$or.push({ type: { $in: preferredTypes } });
    }

    if (preferredMembers.length > 0) {
      recommendationQuery.$or.push({ kpopMember: { $in: preferredMembers } });
    }
  }

  return await Product.aggregate([
    { $match: recommendationQuery },
    {
      $addFields: {
        preferenceScore: {
          $add: [
            { $cond: [{ $in: ['$kpopGroup', allPreferredGroups] }, 3, 0] },
            { $cond: [{ $in: ['$type', preferredTypes] }, 2, 0] },
            { $cond: [{ $in: ['$kpopMember', preferredMembers] }, 2, 0] },
            { $divide: [{ $add: ['$views', { $multiply: ['$favorites', 2] }] }, 100] }
          ]
        }
      }
    },
    { $sort: { preferenceScore: -1, createdAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: 'seller',
        foreignField: '_id',
        as: 'seller'
      }
    },
    {
      $project: {
        _id: 1,
        title: 1,
        price: 1,
        currency: 1,
        images: 1,
        kpopGroup: 1,
        kpopMember: 1,
        type: 1,
        condition: 1,
        views: 1,
        favorites: 1,
        createdAt: 1,
        'seller.username': 1,
        'seller.profilePicture': 1,
        preferenceScore: 1
      }
    }
  ]);
}

export async function fetchRecommendedProducts(userId: string | undefined, limit: number) {
  let recommendedProducts: any[] = [];

  if (userId) {
    recommendedProducts = await buildPersonalizedRecommendations(userId, limit);
  }

  if (recommendedProducts.length < limit) {
    const remainingLimit = limit - recommendedProducts.length;
    const excludeIds = recommendedProducts.map(p => p._id);
    if (userId) excludeIds.push(userId);

    const popularProducts = await Product.find({
      isAvailable: true,
      seller: { $ne: userId },
      _id: { $nin: excludeIds }
    })
      .populate('seller', 'username profilePicture')
      .sort('-views -favorites -createdAt')
      .limit(remainingLimit);

    recommendedProducts = [...recommendedProducts, ...popularProducts];
  }

  return {
    products: recommendedProducts,
    isPersonalized: Boolean(userId) && recommendedProducts.length > 0
  };
}

export async function fetchQuickRecommendations(userId: string | undefined, limit: number) {
  return await Product.find({
    isAvailable: true,
    seller: { $ne: userId },
    views: { $gte: 10 }
  })
    .select('title price currency images kpopGroup type createdAt')
    .sort('-views -createdAt')
    .limit(limit)
    .lean();
}

export async function fetchProductStats() {
  const stats = await Product.aggregate([
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        //availableProducts: { $sum: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] } },
        averagePrice: { $avg: '$price' },
        totalViews: { $sum: '$views' },
        totalFavorites: { $sum: '$favorites' }
      }
    }
  ]);

  const typeDistribution = await Product.aggregate([
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        percentAvailable: {
          $avg: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] }
        }
      }
    }
  ]);

  const groupDistribution = await Product.aggregate([
    {
      $group: {
        _id: '$kpopGroup',
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);

  return {
    generalStats: stats[0] || {},
    typeDistribution,
    groupDistribution
  };
}
