jest.mock('../mistralClient', () => ({
  isMistralConfigured: jest.fn(),
  mistralChatJson: jest.fn()
}));
jest.mock('../geminiClient', () => ({
  isGeminiConfigured: jest.fn(),
  geminiChatJson: jest.fn()
}));

import { isMistralConfigured, mistralChatJson } from '../mistralClient';
import { isGeminiConfigured, geminiChatJson } from '../geminiClient';
import { aiChatJson, isAiChatConfigured, AiChatUnavailableError } from '../aiChatClient';

const mockedIsMistral = isMistralConfigured as jest.Mock;
const mockedMistralChat = mistralChatJson as jest.Mock;
const mockedIsGemini = isGeminiConfigured as jest.Mock;
const mockedGeminiChat = geminiChatJson as jest.Mock;

const params = { system: 'system prompt', user: 'user prompt' };

describe('isAiChatConfigured', () => {
  it('vrai si au moins un fournisseur est configuré', () => {
    mockedIsMistral.mockReturnValue(false);
    mockedIsGemini.mockReturnValue(true);
    expect(isAiChatConfigured()).toBe(true);
  });

  it('faux si aucun fournisseur n\'est configuré', () => {
    mockedIsMistral.mockReturnValue(false);
    mockedIsGemini.mockReturnValue(false);
    expect(isAiChatConfigured()).toBe(false);
  });
});

describe('aiChatJson', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('utilise Mistral quand il répond, sans jamais appeler Gemini', async () => {
    mockedIsMistral.mockReturnValue(true);
    mockedIsGemini.mockReturnValue(true);
    mockedMistralChat.mockResolvedValue({ content: '{"ok":true}', model: 'mistral-small-latest' });

    const result = await aiChatJson(params);

    expect(result).toEqual({ content: '{"ok":true}', model: 'mistral-small-latest', provider: 'mistral' });
    expect(mockedGeminiChat).not.toHaveBeenCalled();
  });

  it('bascule sur Gemini si Mistral échoue', async () => {
    mockedIsMistral.mockReturnValue(true);
    mockedIsGemini.mockReturnValue(true);
    mockedMistralChat.mockRejectedValue(new Error('rate limited'));
    mockedGeminiChat.mockResolvedValue({ content: '{"ok":true}', model: 'gemini-2.5-flash' });

    const result = await aiChatJson(params);

    expect(result).toEqual({ content: '{"ok":true}', model: 'gemini-2.5-flash', provider: 'gemini' });
    expect(mockedMistralChat).toHaveBeenCalledTimes(1);
  });

  it('appelle directement Gemini si Mistral n\'est pas configuré', async () => {
    mockedIsMistral.mockReturnValue(false);
    mockedIsGemini.mockReturnValue(true);
    mockedGeminiChat.mockResolvedValue({ content: '{"ok":true}', model: 'gemini-2.5-flash' });

    const result = await aiChatJson(params);

    expect(result.provider).toBe('gemini');
    expect(mockedMistralChat).not.toHaveBeenCalled();
  });

  it('lève une erreur si les deux fournisseurs échouent', async () => {
    mockedIsMistral.mockReturnValue(true);
    mockedIsGemini.mockReturnValue(true);
    mockedMistralChat.mockRejectedValue(new Error('mistral down'));
    mockedGeminiChat.mockRejectedValue(new Error('gemini down'));

    await expect(aiChatJson(params)).rejects.toThrow(AiChatUnavailableError);
    await expect(aiChatJson(params)).rejects.toThrow(/mistral down.*gemini down/);
  });

  it('lève une erreur immédiatement si aucun fournisseur n\'est configuré', async () => {
    mockedIsMistral.mockReturnValue(false);
    mockedIsGemini.mockReturnValue(false);

    await expect(aiChatJson(params)).rejects.toThrow(AiChatUnavailableError);
    expect(mockedMistralChat).not.toHaveBeenCalled();
    expect(mockedGeminiChat).not.toHaveBeenCalled();
  });
});
