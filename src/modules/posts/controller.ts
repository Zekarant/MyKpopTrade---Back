import { Request, Response } from 'express';
import Post from './model';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';

/**
 * Créer un post
 */
export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ message: 'Le contenu est requis' });
  }

  const images: string[] = [];
  if (req.files && Array.isArray(req.files)) {
    for (const file of req.files) {
      images.push(`/uploads/posts/${file.filename}`);
    }
  }

  const post = await Post.create({
    author: userId,
    content: content.trim(),
    images
  });

  const populated = await Post.findById(post._id).populate('author', 'username profilePicture isIdentityVerified');

  return res.status(201).json({ post: populated });
});

/**
 * Récupérer les posts d'un utilisateur
 */
export const getUserPosts = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const [posts, count] = await Promise.all([
    Post.find({ author: userId, isReply: false })
      .populate('author', 'username profilePicture isIdentityVerified')
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
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

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
      .populate('author', 'username profilePicture isIdentityVerified')
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
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  const post = await Post.findById(postId)
    .populate('author', 'username profilePicture isIdentityVerified');

  if (!post) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  const [replies, repliesCount] = await Promise.all([
    Post.find({ parentPost: postId })
      .populate('author', 'username profilePicture isIdentityVerified')
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
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ message: 'Le contenu est requis' });
  }

  const parentPost = await Post.findById(postId);
  if (!parentPost) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  const reply = await Post.create({
    author: userId,
    content: content.trim(),
    parentPost: postId,
    isReply: true
  });

  parentPost.repliesCount += 1;
  await parentPost.save();

  const populated = await Post.findById(reply._id).populate('author', 'username profilePicture isIdentityVerified');

  return res.status(201).json({ post: populated });
});

/**
 * Liker/Unliker un post
 */
export const toggleLike = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { postId } = req.params;

  const post = await Post.findById(postId);
  if (!post) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  const alreadyLiked = post.likes.some((id: any) => id.toString() === userId.toString());

  if (alreadyLiked) {
    post.likes = post.likes.filter((id: any) => id.toString() !== userId.toString()) as any;
    post.likesCount = Math.max(0, post.likesCount - 1);
  } else {
    post.likes.push(userId);
    post.likesCount += 1;
  }

  await post.save();

  return res.status(200).json({ liked: !alreadyLiked, likesCount: post.likesCount });
});

/**
 * Supprimer un post (auteur uniquement)
 */
export const deletePost = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { postId } = req.params;

  const post = await Post.findById(postId);
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
