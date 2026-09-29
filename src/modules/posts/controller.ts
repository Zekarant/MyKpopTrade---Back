import mongoose from 'mongoose';
import { Request, Response } from 'express';
import Post from './model';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';
import { clampLimit } from '../../commons/utils/pagination';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_CONTENT_LENGTH = 1000;
const AUTHOR_FIELDS = 'username profilePicture isIdentityVerified';

function pagination(req: Request) {
  return {
    page: Math.max(1, parseInt(req.query.page as string) || 1),
    limit: clampLimit(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
}

/** Contenu d'un post ou d'une réponse, ou null s'il est absent ou invalide. */
function readContent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const content = value.trim();
  return content && content.length <= MAX_CONTENT_LENGTH ? content : null;
}

const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

/**
 * Créer un post
 */
export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const content = readContent(req.body.content);

  if (!content) {
    return res.status(400).json({ message: `Le contenu est requis (${MAX_CONTENT_LENGTH} caractères maximum)` });
  }

  // Les images passent par le stockage des annonces : /uploads/posts/ n'est pas servi.
  const images: string[] = [];
  if (req.files && Array.isArray(req.files)) {
    for (const file of req.files) {
      images.push(`/uploads/products/${file.filename}`);
    }
  }

  const post = await Post.create({
    author: userId,
    content,
    images
  });

  const populated = await Post.findById(post._id).populate('author', AUTHOR_FIELDS);

  return res.status(201).json({ post: populated });
});

/**
 * Récupérer les posts d'un utilisateur
 */
export const getUserPosts = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  if (!isObjectId(userId)) {
    return res.status(400).json({ message: 'Identifiant utilisateur invalide' });
  }
  const { page, limit } = pagination(req);

  const [posts, count] = await Promise.all([
    Post.find({ author: userId, isReply: false })
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Post.countDocuments({ author: userId, isReply: false })
  ]);

  return res.status(200).json({
    posts,
    pagination: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) }
  });
});

/**
 * Récupérer le feed (posts des utilisateurs suivis + les siens)
 */
export const getFeed = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const { page, limit } = pagination(req);

  // Import Follow model dynamically to avoid circular deps
  const Follow = (await import('../follows/model')).default;

  let authorFilter: any = { isReply: false };
  if (userId) {
    const followDocs = await Follow.find({ follower: userId }).select('following').lean();
    const followingIds = followDocs.map((f: any) => f.following);
    followingIds.push(userId);
    authorFilter.author = { $in: followingIds };
  }

  const [posts, count] = await Promise.all([
    Post.find(authorFilter)
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Post.countDocuments(authorFilter)
  ]);

  return res.status(200).json({
    posts,
    pagination: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) }
  });
});

/**
 * Récupérer un post avec ses réponses
 */
export const getPost = asyncHandler(async (req: Request, res: Response) => {
  const { postId } = req.params;
  if (!isObjectId(postId)) {
    return res.status(404).json({ message: 'Post introuvable' });
  }
  const { page, limit } = pagination(req);

  const post = await Post.findById(postId)
    .populate('author', AUTHOR_FIELDS);

  if (!post) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  const [replies, repliesCount] = await Promise.all([
    Post.find({ parentPost: postId })
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Post.countDocuments({ parentPost: postId })
  ]);

  return res.status(200).json({
    post,
    replies,
    pagination: { page, limit, totalItems: repliesCount, totalPages: Math.ceil(repliesCount / limit) }
  });
});

/**
 * Répondre à un post
 */
export const replyToPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { postId } = req.params;
  const content = readContent(req.body.content);

  if (!content) {
    return res.status(400).json({ message: `Le contenu est requis (${MAX_CONTENT_LENGTH} caractères maximum)` });
  }

  // $inc atomique : aucune réponse concurrente perdue dans le compteur.
  const parentPost = isObjectId(postId)
    ? await Post.findByIdAndUpdate(postId, { $inc: { repliesCount: 1 } })
    : null;
  if (!parentPost) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  const reply = await Post.create({
    author: userId,
    content,
    parentPost: parentPost._id,
    isReply: true
  });

  const populated = await Post.findById(reply._id).populate('author', AUTHOR_FIELDS);

  return res.status(201).json({ post: populated });
});

/**
 * Liker/Unliker un post
 *
 * Mises à jour conditionnelles et atomiques : aucun « j'aime » simultané perdu,
 * et un double clic ne compte pas deux fois le même utilisateur.
 */
export const toggleLike = asyncHandler(async (req: Request, res: Response) => {
  const userId = String((req as any).user.id);
  const { postId } = req.params;
  if (!isObjectId(postId)) {
    return res.status(404).json({ message: 'Post introuvable' });
  }
  const likerId = new mongoose.Types.ObjectId(userId);

  const liked = await Post.findOneAndUpdate(
    { _id: postId, likes: { $ne: likerId } },
    { $push: { likes: likerId }, $inc: { likesCount: 1 } },
    { new: true }
  );
  if (liked) {
    return res.status(200).json({ liked: true, likesCount: liked.likesCount });
  }

  const unliked = await Post.findOneAndUpdate(
    { _id: postId, likes: likerId },
    { $pull: { likes: likerId }, $inc: { likesCount: -1 } },
    { new: true }
  );
  if (!unliked) {
    return res.status(404).json({ message: 'Post introuvable' });
  }
  return res.status(200).json({ liked: false, likesCount: Math.max(0, unliked.likesCount) });
});

/**
 * Supprimer un post (auteur uniquement)
 */
export const deletePost = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { postId } = req.params;

  const post = isObjectId(postId) ? await Post.findById(postId) : null;
  if (!post) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  if (post.author.toString() !== userId.toString()) {
    return res.status(403).json({ message: 'Non autorisé' });
  }

  // If parent post, decrement replies count
  if (post.parentPost) {
    await Post.findByIdAndUpdate(post.parentPost, { $inc: { repliesCount: -1 } });
  }

  // Delete all replies
  await Post.deleteMany({ parentPost: post._id });
  await post.deleteOne();

  return res.status(200).json({ message: 'Post supprimé' });
});
