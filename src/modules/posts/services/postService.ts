import mongoose from 'mongoose';
import Post, { IPost } from '../../../models/postModel';
import { assertOwner, notFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';
import { listFollowedUserIds } from '../../follows/services/followService';

const AUTHOR_FIELDS = 'username profilePicture isIdentityVerified';
const POST_NOT_FOUND_MESSAGE = 'Post introuvable';

export const postNotFound = () => notFound(POST_NOT_FOUND_MESSAGE);

async function findPopulatedPost(postId: mongoose.Types.ObjectId | string) {
  return await Post.findById(postId).populate('author', AUTHOR_FIELDS).lean();
}

/** Page de posts (du plus récent au plus ancien) correspondant au filtre. */
async function listPosts(filter: mongoose.QueryFilter<IPost>, pageRequest: PageRequest) {
  const [posts, total] = await Promise.all([
    Post.find(filter)
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    Post.countDocuments(filter)
  ]);
  return { posts, pagination: paginationMeta(pageRequest, total) };
}

export async function createPost({ authorId, content, images }: { authorId: string; content: string; images: string[] }) {
  const post = await Post.create({ author: authorId, content, images });
  return await findPopulatedPost(post._id);
}

export async function listUserPosts(userId: string, pageRequest: PageRequest) {
  return await listPosts({ author: userId, isReply: false }, pageRequest);
}

/** Fil : posts des membres suivis et les siens ; sans compte, tous les posts. */
export async function listFeed(viewerId: string | undefined, pageRequest: PageRequest) {
  const filter: mongoose.QueryFilter<IPost> = { isReply: false };
  if (viewerId) {
    const authorIds: Array<mongoose.Types.ObjectId | string> = await listFollowedUserIds(viewerId);
    authorIds.push(viewerId);
    filter.author = { $in: authorIds };
  }
  return await listPosts(filter, pageRequest);
}

/** @throws HttpError 404 si le post n'existe pas. */
export async function getPostWithReplies(postId: string, pageRequest: PageRequest) {
  const post = await findPopulatedPost(postId);
  if (!post) throw postNotFound();

  const [replies, repliesCount] = await Promise.all([
    Post.find({ parentPost: postId })
      .populate('author', AUTHOR_FIELDS)
      .sort({ createdAt: 1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    Post.countDocuments({ parentPost: postId })
  ]);

  return { post, replies, pagination: paginationMeta(pageRequest, repliesCount) };
}

/** @throws HttpError 404 si le post parent n'existe pas. */
export async function replyToPost({ authorId, postId, content }: { authorId: string; postId: string; content: string }) {
  // $inc atomique : aucune réponse concurrente perdue dans le compteur.
  const parentPost = await Post.findByIdAndUpdate(postId, { $inc: { repliesCount: 1 } }).select('_id').lean();
  if (!parentPost) throw postNotFound();

  const reply = await Post.create({
    author: authorId,
    content,
    parentPost: parentPost._id,
    isReply: true
  });
  return await findPopulatedPost(reply._id);
}

/**
 * Like / unlike d'un post.
 *
 * Mises à jour conditionnelles et atomiques : aucun « j'aime » simultané perdu,
 * et un double clic ne compte pas deux fois le même utilisateur.
 *
 * @throws HttpError 404 si le post n'existe pas.
 */
export async function toggleLike(userId: string, postId: string): Promise<{ liked: boolean; likesCount: number }> {
  const likerId = new mongoose.Types.ObjectId(userId);

  const liked = await Post.findOneAndUpdate(
    { _id: postId, likes: { $ne: likerId } },
    { $push: { likes: likerId }, $inc: { likesCount: 1 } },
    { returnDocument: 'after', projection: { likesCount: 1 } }
  ).lean();
  if (liked) {
    return { liked: true, likesCount: liked.likesCount };
  }

  const unliked = await Post.findOneAndUpdate(
    { _id: postId, likes: likerId },
    { $pull: { likes: likerId }, $inc: { likesCount: -1 } },
    { returnDocument: 'after', projection: { likesCount: 1 } }
  ).lean();
  if (!unliked) throw postNotFound();
  return { liked: false, likesCount: Math.max(0, unliked.likesCount) };
}

/**
 * Supprime un post et ses réponses (auteur uniquement).
 *
 * @throws HttpError 404 si le post n'existe pas, 403 si l'utilisateur n'en est pas l'auteur.
 */
export async function deletePost(userId: string, postId: string): Promise<void> {
  const post = await Post.findById(postId).select('author parentPost').lean();
  if (!post) throw postNotFound();
  assertOwner(post.author, userId, 'Non autorisé');

  if (post.parentPost) {
    await Post.updateOne({ _id: post.parentPost }, { $inc: { repliesCount: -1 } });
  }
  await Post.deleteMany({ parentPost: post._id });
  await Post.deleteOne({ _id: post._id });
}
