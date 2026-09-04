import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import Product from '../../../../models/productModel';

jest.mock('../../../../commons/services/mistralClient', () => ({
  isMistralConfigured: jest.fn(() => true),
  mistralChatJson: jest.fn()
}));
jest.mock('../../../../commons/services/geminiClient', () => ({
  isGeminiConfigured: jest.fn(() => false),
  geminiChatJson: jest.fn()
}));
jest.mock('../../../../commons/services/adminAlertService', () => ({
  dispatchAdminAlert: jest.fn()
}));

import { mistralChatJson } from '../../../../commons/services/mistralClient';
import { isGeminiConfigured, geminiChatJson } from '../../../../commons/services/geminiClient';
import { dispatchAdminAlert } from '../../../../commons/services/adminAlertService';
import { dispatchProductModeration } from '../productModerationService';

const mockedChat = mistralChatJson as jest.MockedFunction<typeof mistralChatJson>;
const mockedIsGeminiConfigured = isGeminiConfigured as jest.Mock;
const mockedGeminiChat = geminiChatJson as jest.MockedFunction<typeof geminiChatJson>;

const suspectReply = () =>
  JSON.stringify({
    suspect: true,
    confidence: 'high',
    reasoning: 'Le vendeur propose explicitement une réplique non officielle.',
    categories: ['counterfeit']
  });

const cleanReply = () =>
  JSON.stringify({
    suspect: false,
    confidence: 'low',
    reasoning: '« Replica » est utilisé pour décrire un boîtier de rangement, pas le produit vendu.',
    categories: []
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await wait(25);
  }
}

describe('dispatchProductModeration (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);
  afterAll(async () => {
    await stopInMemoryMongo();
  });
  beforeEach(async () => {
    await clearAllCollections();
    jest.clearAllMocks();
    mockedIsGeminiConfigured.mockReturnValue(false);
  });

  it('bascule sur Gemini et met l\'annonce en pause quand Mistral échoue', async () => {
    mockedChat.mockRejectedValue(new Error('network down'));
    mockedIsGeminiConfigured.mockReturnValue(true);
    mockedGeminiChat.mockResolvedValue({ content: suspectReply(), model: 'gemini-2.5-flash' });

    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, {
      title: 'Album replica édition limitée',
      description: 'Très belle réplique, qualité au top'
    });

    dispatchProductModeration(product._id.toString());
    await waitFor(async () => Boolean((await Product.findById(product._id))?.moderationFlag));

    const saved = await Product.findById(product._id);
    expect(saved?.isAvailable).toBe(false);
    expect(saved?.moderationFlag?.suspect).toBe(true);
    expect(saved?.moderationFlag?.provider).toBe('gemini');
    expect(saved?.moderationFlag?.model).toBe('gemini-2.5-flash');
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'product.suspect' })
    );
  });

  it('ne fait aucun appel Mistral si aucun mot-clé suspect n\'est présent', async () => {
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, {
      title: 'Photocard BTS Jungkook',
      description: 'Excellent état, envoi rapide'
    });

    dispatchProductModeration(product._id.toString());
    await wait(100);

    expect(mockedChat).not.toHaveBeenCalled();
    const saved = await Product.findById(product._id);
    expect(saved?.moderationFlag).toBeUndefined();
    expect(saved?.isAvailable).toBe(true);
  });

  it('met l\'annonce en pause et alerte les admins quand Mistral confirme le risque', async () => {
    mockedChat.mockResolvedValue({ content: suspectReply(), model: 'mistral-small-latest' });
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, {
      title: 'Album replica édition limitée',
      description: 'Très belle réplique, qualité au top'
    });

    dispatchProductModeration(product._id.toString());
    await waitFor(async () => Boolean((await Product.findById(product._id))?.moderationFlag));

    const saved = await Product.findById(product._id);
    expect(saved?.isAvailable).toBe(false);
    expect(saved?.moderationFlag?.suspect).toBe(true);
    expect(saved?.moderationFlag?.categories).toEqual(['counterfeit']);
    expect(saved?.moderationFlag?.matchedKeywords).toContain('replica');
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'product.suspect', severity: 'warning' })
    );
  });

  it('laisse l\'annonce publiée et n\'alerte personne quand Mistral écarte le risque', async () => {
    mockedChat.mockResolvedValue({ content: cleanReply(), model: 'mistral-small-latest' });
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, {
      title: 'Boîtier de rangement replica vintage',
      description: 'Pour ranger vos photocards en toute sécurité'
    });

    dispatchProductModeration(product._id.toString());
    await waitFor(async () => Boolean((await Product.findById(product._id))?.moderationFlag));

    const saved = await Product.findById(product._id);
    expect(saved?.isAvailable).toBe(true);
    expect(saved?.moderationFlag?.suspect).toBe(false);
    expect(dispatchAdminAlert).not.toHaveBeenCalled();
  });

  it('n\'échoue pas, ne bloque pas l\'annonce, mais alerte Discord si Mistral est injoignable', async () => {
    mockedChat.mockRejectedValue(new Error('network down'));
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, { title: 'Album replica' });

    dispatchProductModeration(product._id.toString());
    await waitFor(() => (dispatchAdminAlert as jest.Mock).mock.calls.length > 0);

    const saved = await Product.findById(product._id);
    expect(saved?.moderationFlag).toBeUndefined();
    expect(saved?.isAvailable).toBe(true);
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'product.moderation_failed', severity: 'warning' })
    );
  });

  it('n\'échoue pas, ne bloque pas l\'annonce, mais alerte Discord si Mistral renvoie une réponse invalide', async () => {
    mockedChat.mockResolvedValue({ content: 'pas du json', model: 'mistral-small-latest' });
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, { title: 'Album replica' });

    dispatchProductModeration(product._id.toString());
    await waitFor(() => (dispatchAdminAlert as jest.Mock).mock.calls.length > 0);

    const saved = await Product.findById(product._id);
    expect(saved?.moderationFlag).toBeUndefined();
    expect(saved?.isAvailable).toBe(true);
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'product.moderation_failed', severity: 'warning' })
    );
  });
});
