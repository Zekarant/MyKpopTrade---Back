jest.mock('axios');

import axios from 'axios';
import { lookupAddress } from '../addressLookupService';

const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  jest.clearAllMocks();
  (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);
});

function banFeature(props: any) {
  return { properties: props };
}

describe('lookupAddress', () => {
  it('appelle BAN avec q et map les résultats', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        features: [
          banFeature({
            label: '12 Rue de la Paix 75002 Paris',
            name: '12 Rue de la Paix',
            postcode: '75002',
            city: 'Paris',
            context: '75, Paris, Île-de-France',
            score: 0.95
          })
        ]
      }
    });

    const results = await lookupAddress({ q: '12 rue de la paix' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      streetLine1: '12 Rue de la Paix',
      postalCode: '75002',
      city: 'Paris',
      country: 'FR',
      score: 0.95
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api-adresse.data.gouv.fr/search/',
      expect.objectContaining({
        params: expect.objectContaining({ q: '12 rue de la paix', autocomplete: 1 })
      })
    );
  });

  it('utilise postalCode comme query si q absent', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { features: [] } });

    await lookupAddress({ postalCode: '75002' });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ q: '75002', postcode: '75002' })
      })
    );
  });

  it('clamp limit à 15 maximum', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { features: [] } });

    await lookupAddress({ q: 'paris', limit: 99 });

    const callParams = mockedAxios.get.mock.calls[0][1]?.params as any;
    expect(callParams.limit).toBe(15);
  });

  it('default limit = 8 si non fourni', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { features: [] } });
    await lookupAddress({ q: 'paris' });
    const callParams = mockedAxios.get.mock.calls[0][1]?.params as any;
    expect(callParams.limit).toBe(8);
  });

  it('400 si ni q ni postalCode fourni', async () => {
    await expect(lookupAddress({})).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('ignore les features sans postcode/city', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        features: [
          banFeature({ name: 'Bizarre', postcode: '', city: '' }),
          banFeature({ label: 'OK', name: 'rue X', postcode: '75002', city: 'Paris' })
        ]
      }
    });

    const results = await lookupAddress({ q: 'test' });
    expect(results).toHaveLength(1);
    expect(results[0].streetLine1).toBe('rue X');
  });

  it('502 si BAN renvoie une erreur HTTP', async () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValueOnce(true);
    mockedAxios.get.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 503 }
    });

    await expect(lookupAddress({ q: 'paris' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('502 si BAN timeout (erreur non axios)', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(lookupAddress({ q: 'paris' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('tronque q à 200 caractères', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { features: [] } });
    const longQuery = 'a'.repeat(500);
    await lookupAddress({ q: longQuery });
    const callParams = mockedAxios.get.mock.calls[0][1]?.params as any;
    expect(callParams.q.length).toBe(200);
  });
});
