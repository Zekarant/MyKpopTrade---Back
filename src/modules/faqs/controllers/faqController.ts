import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import * as faqService from '../services/faqService';
import type { FaqUpdate } from '../services/faqService';

const isNonBlankString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Champs facultatifs communs à la création et à la mise à jour. */
function readOptionalFields(body: Record<string, unknown>): Pick<FaqUpdate, 'category' | 'order' | 'isPublished'> {
  const { category, order, isPublished } = body;
  if (category !== undefined && typeof category !== 'string') {
    throw badRequest('La catégorie doit être une chaîne de caractères');
  }
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw badRequest('L\'ordre doit être un nombre');
  }
  if (isPublished !== undefined && typeof isPublished !== 'boolean') {
    throw badRequest('isPublished doit être un booléen');
  }
  return { category, order, isPublished };
}

/**
 * Liste publique des FAQ publiées, triées par catégorie puis ordre
 */
export const getFaqs = async (_req: Request, res: Response) => {
  const faqs = await faqService.listPublishedFaqs();
  return res.status(200).json({ faqs });
};

/**
 * Liste admin de toutes les FAQ (publiées ou non)
 */
export const getAllFaqs = async (_req: Request, res: Response) => {
  const faqs = await faqService.listAllFaqs();
  return res.status(200).json({ faqs });
};

/**
 * Créer une FAQ (admin)
 */
export const createFaq = async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { question, answer } = body;
  if (!isNonBlankString(question) || !isNonBlankString(answer)) {
    throw badRequest('La question et la réponse sont requises');
  }

  const faq = await faqService.createFaq({ question, answer, ...readOptionalFields(body) });
  return res.status(201).json({ faq });
};

/**
 * Mettre à jour une FAQ (admin)
 */
export const updateFaq = async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { question, answer } = body;
  if (question !== undefined && !isNonBlankString(question)) {
    throw badRequest('La question ne peut pas être vide');
  }
  if (answer !== undefined && !isNonBlankString(answer)) {
    throw badRequest('La réponse ne peut pas être vide');
  }

  const faq = await faqService.updateFaq(String(req.params.faqId), { question, answer, ...readOptionalFields(body) });
  return res.status(200).json({ faq });
};

/**
 * Supprimer une FAQ (admin)
 */
export const deleteFaq = async (req: Request, res: Response) => {
  await faqService.deleteFaq(String(req.params.faqId));
  return res.status(200).json({ message: 'FAQ supprimée' });
};
