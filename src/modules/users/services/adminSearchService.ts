import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Post from '../../../models/postModel';
import { escapeRegex } from '../../../commons/utils/escapeRegex';

const GLOBAL_SEARCH_LIMIT = 6;
const GLOBAL_SEARCH_MIN_LENGTH = 2;
const POST_LABEL_LENGTH = 80;
const POST_SEARCH_LENGTH = 40;

export interface GlobalSearchResult {
  kind: 'user' | 'product' | 'post';
  id: string;
  label: string;
  detail: string;
  /** Onglet du panneau d'administration où ouvrir le résultat. */
  tab: string;
  /** Terme à pré-remplir dans la recherche de cet onglet. */
  search: string;
}

/** Recherche transverse du panneau admin : membres, annonces et publications. */
export async function searchAdminEverything(rawTerm: string): Promise<GlobalSearchResult[]> {
  const term = rawTerm.trim();
  if (term.length < GLOBAL_SEARCH_MIN_LENGTH) {
    return [];
  }

  const pattern = new RegExp(escapeRegex(term), 'i');

  const [users, products, posts] = await Promise.all([
    User.find({ $or: [{ username: pattern }, { email: pattern }] })
      .select('username email accountStatus role')
      .limit(GLOBAL_SEARCH_LIMIT)
      .lean(),
    Product.find({ title: pattern })
      .select('title price currency isSold')
      .limit(GLOBAL_SEARCH_LIMIT)
      .lean(),
    Post.find({ content: pattern })
      .select('content isReply author')
      .populate<{ author: Pick<IUser, 'username'> | null }>('author', 'username')
      .limit(GLOBAL_SEARCH_LIMIT)
      .lean()
  ]);

  return [
    ...users.map((user): GlobalSearchResult => ({
      kind: 'user',
      id: String(user._id),
      label: user.username,
      detail: `${user.email} · ${user.accountStatus}`,
      tab: 'users',
      search: user.username
    })),
    ...products.map((product): GlobalSearchResult => ({
      kind: 'product',
      id: String(product._id),
      label: product.title,
      detail: `${product.price} ${product.currency}${product.isSold ? ' · vendu' : ''}`,
      tab: 'products',
      search: product.title
    })),
    ...posts.map((post): GlobalSearchResult => ({
      kind: 'post',
      id: String(post._id),
      label: post.content.slice(0, POST_LABEL_LENGTH),
      detail: `${post.isReply ? 'Réponse' : 'Publication'} de ${post.author?.username || 'inconnu'}`,
      tab: 'moderation',
      search: post.content.slice(0, POST_SEARCH_LENGTH)
    }))
  ];
}
