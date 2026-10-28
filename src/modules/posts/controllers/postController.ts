import mongoose from 'mongoose';
import { Request, Response } from 'express';
import * as postService from '../services/postService';
import { badRequest, notFound } from '../../../commons/utils/httpError';
import { parsePagination } from '../../../commons/utils/pagination';

const PAGE_OPTIONS = { defaultLimit: 20, maxLimit: 50 };
const MAX_CONTENT_LENGTH = 1000;

/** Contenu d'un post ou d'une réponse : texte non vide, borné. */
function readContent(value: unknown): string {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    throw badRequest(`Le contenu est requis (${MAX_CONTENT_LENGTH} caractères maximum)`);
  }
  return content;
}

/** Un identifiant de post mal formé ne désigne aucun post (404). */
function readPostId(value: unknown): string {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
    throw notFound('Post introuvable');
  }
  return value;
}

/**
 * Créer un post
 */
export const createPost = async (req: Request, res: Response) => {
  const content = readContent(req.body?.content);
  // Les images passent par le stockage des annonces : /uploads/posts/ n'est pas servi.
  const files = Array.isArray(req.files) ? req.files : [];
  const images = files.map((file) => `/uploads/products/${file.filename}`);

  const post = await postService.createPost({ authorId: req.user!.id, content, images });
  return res.status(201).json({ post });
};

/**
 * Récupérer les posts d'un utilisateur
 */
export const getUserPosts = async (req: Request, res: Response) => {
  const { userId } = req.params;
  if (typeof userId !== 'string' || !mongoose.Types.ObjectId.isValid(userId)) {
    throw badRequest('Identifiant utilisateur invalide');
  }
  return res.status(200).json(await postService.listUserPosts(userId, parsePagination(req.query, PAGE_OPTIONS)));
};

/**
 * Récupérer le feed (posts des utilisateurs suivis + les siens)
 */
export const getFeed = async (req: Request, res: Response) => {
  return res.status(200).json(await postService.listFeed(req.user?.id, parsePagination(req.query, PAGE_OPTIONS)));
};

/**
 * Récupérer un post avec ses réponses
 */
export const getPost = async (req: Request, res: Response) => {
  const postId = readPostId(req.params.postId);
  return res.status(200).json(await postService.getPostWithReplies(postId, parsePagination(req.query, PAGE_OPTIONS)));
};

/**
 * Répondre à un post
 */
export const replyToPost = async (req: Request, res: Response) => {
  const content = readContent(req.body?.content);
  const postId = readPostId(req.params.postId);

  const post = await postService.replyToPost({ authorId: req.user!.id, postId, content });
  return res.status(201).json({ post });
};

/**
 * Liker/Unliker un post
 */
export const toggleLike = async (req: Request, res: Response) => {
  const postId = readPostId(req.params.postId);
  return res.status(200).json(await postService.toggleLike(String(req.user!.id), postId));
};

/**
 * Supprimer un post (auteur uniquement)
 */
export const deletePost = async (req: Request, res: Response) => {
  const postId = readPostId(req.params.postId);
  await postService.deletePost(String(req.user!.id), postId);
  return res.status(200).json({ message: 'Post supprimé' });
};
