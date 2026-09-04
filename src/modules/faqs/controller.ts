import { Request, Response } from 'express';
import Faq from './model';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';

/**
 * Liste publique des FAQ publiées, triées par catégorie puis ordre
 */
export const getFaqs = asyncHandler(async (req: Request, res: Response) => {
  const faqs = await Faq.find({ isPublished: true }).sort({ category: 1, order: 1, createdAt: 1 });
  return res.status(200).json({ faqs });
});

/**
 * Liste admin de toutes les FAQ (publiées ou non)
 */
export const getAllFaqs = asyncHandler(async (req: Request, res: Response) => {
  const faqs = await Faq.find().sort({ category: 1, order: 1, createdAt: 1 });
  return res.status(200).json({ faqs });
});

/**
 * Créer une FAQ (admin)
 */
export const createFaq = asyncHandler(async (req: Request, res: Response) => {
  const { question, answer, category, order, isPublished } = req.body;

  if (typeof question !== 'string' || !question.trim() || typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ message: 'La question et la réponse sont requises' });
  }
  if (category !== undefined && typeof category !== 'string') {
    return res.status(400).json({ message: 'La catégorie doit être une chaîne de caractères' });
  }

  const faq = await Faq.create({
    question: question.trim(),
    answer: answer.trim(),
    category: category?.trim() || 'general',
    order: typeof order === 'number' ? order : 0,
    isPublished: isPublished !== undefined ? isPublished : true
  });

  return res.status(201).json({ faq });
});

/**
 * Mettre à jour une FAQ (admin)
 */
export const updateFaq = asyncHandler(async (req: Request, res: Response) => {
  const { faqId } = req.params;
  const { question, answer, category, order, isPublished } = req.body;

  const faq = await Faq.findById(faqId);
  if (!faq) {
    return res.status(404).json({ message: 'FAQ introuvable' });
  }

  if (question !== undefined) {
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ message: 'La question ne peut pas être vide' });
    }
    faq.question = question.trim();
  }
  if (answer !== undefined) {
    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ message: 'La réponse ne peut pas être vide' });
    }
    faq.answer = answer.trim();
  }
  if (category !== undefined) {
    if (typeof category !== 'string') {
      return res.status(400).json({ message: 'La catégorie doit être une chaîne de caractères' });
    }
    faq.category = category.trim() || 'general';
  }
  if (order !== undefined) faq.order = order;
  if (isPublished !== undefined) faq.isPublished = isPublished;

  await faq.save();

  return res.status(200).json({ faq });
});

/**
 * Supprimer une FAQ (admin)
 */
export const deleteFaq = asyncHandler(async (req: Request, res: Response) => {
  const { faqId } = req.params;

  const faq = await Faq.findById(faqId);
  if (!faq) {
    return res.status(404).json({ message: 'FAQ introuvable' });
  }

  await faq.deleteOne();

  return res.status(200).json({ message: 'FAQ supprimée' });
});
