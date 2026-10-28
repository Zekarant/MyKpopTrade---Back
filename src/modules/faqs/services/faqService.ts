import Faq from '../../../models/faqModel';
import { notFound } from '../../../commons/utils/httpError';

const FAQ_SORT = { category: 1, order: 1, createdAt: 1 } as const;
const DEFAULT_CATEGORY = 'general';

export interface FaqInput {
  question: string;
  answer: string;
  category?: string;
  order?: number;
  isPublished?: boolean;
}

/** Champs modifiables d'une FAQ ; un champ absent garde sa valeur. */
export type FaqUpdate = Partial<FaqInput>;

/** FAQ publiées, triées par catégorie puis ordre. */
export async function listPublishedFaqs() {
  return await Faq.find({ isPublished: true }).sort(FAQ_SORT).lean();
}

/** Toutes les FAQ, publiées ou non (admin). */
export async function listAllFaqs() {
  return await Faq.find().sort(FAQ_SORT).lean();
}

export async function createFaq({ question, answer, category, order, isPublished }: FaqInput) {
  return await Faq.create({
    question: question.trim(),
    answer: answer.trim(),
    category: category?.trim() || DEFAULT_CATEGORY,
    order: order ?? 0,
    isPublished: isPublished ?? true
  });
}

/** @throws HttpError 404 si la FAQ n'existe pas. */
export async function updateFaq(faqId: string, update: FaqUpdate) {
  const faq = await Faq.findById(faqId);
  if (!faq) throw notFound('FAQ introuvable');

  if (update.question !== undefined) faq.question = update.question.trim();
  if (update.answer !== undefined) faq.answer = update.answer.trim();
  if (update.category !== undefined) faq.category = update.category.trim() || DEFAULT_CATEGORY;
  if (update.order !== undefined) faq.order = update.order;
  if (update.isPublished !== undefined) faq.isPublished = update.isPublished;

  await faq.save();
  return faq;
}

/** @throws HttpError 404 si la FAQ n'existe pas. */
export async function deleteFaq(faqId: string): Promise<void> {
  const deleted = await Faq.findByIdAndDelete(faqId);
  if (!deleted) throw notFound('FAQ introuvable');
}
