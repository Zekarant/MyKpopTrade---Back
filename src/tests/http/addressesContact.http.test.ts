jest.mock('../../commons/services/discordWebhookService', () => ({
  ...jest.requireActual('../../commons/services/discordWebhookService'),
  postDiscordEmbed: jest.fn()
}));

import axios from 'axios';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import { postDiscordEmbed } from '../../commons/services/discordWebhookService';

/** Autocomplétion d'adresse (proxy BAN) et formulaire de contact. */
const app = createApp();

describe('HTTP — adresses et contact', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    jest.mocked(postDiscordEmbed).mockReset();
  });

  describe('GET /api/addresses/lookup', () => {
    const lookup = async (query: string) => {
      const user = await createTestUser();
      return request(app).get(`/api/addresses/lookup${query}`).set('Authorization', `Bearer ${generateAccessToken(user)}`);
    };

    it('exige une authentification', async () => {
      const res = await request(app).get('/api/addresses/lookup?q=paris');

      expect(res.status).toBe(401);
    });

    it('renvoie les adresses proposées par la BAN', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: { features: [{ properties: { label: '12 Rue de la Paix 75002 Paris', name: '12 Rue de la Paix', postcode: '75002', city: 'Paris', score: 0.9 } }] }
      } as never);

      const res = await lookup('?q=12%20rue%20de%20la%20paix');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        results: [{ streetLine1: '12 Rue de la Paix', postalCode: '75002', city: 'Paris', country: 'FR' }]
      });
    });

    it('refuse une recherche sans q ni postalCode (400)', async () => {
      const res = await lookup('');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('répond 502 ADDRESS_LOOKUP_UNAVAILABLE quand la BAN ne répond pas', async () => {
      jest.spyOn(axios, 'get').mockRejectedValue(new Error('ETIMEDOUT'));

      const res = await lookup('?q=paris');

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('ADDRESS_LOOKUP_UNAVAILABLE');
    });
  });

  describe('POST /api/contact', () => {
    const valid = { name: 'Alice', email: 'alice@example.com', subject: 'Paiement', message: 'Bonjour, une question sur ma commande.' };

    it('transmet le message au support (202)', async () => {
      jest.mocked(postDiscordEmbed).mockResolvedValue(true);

      const res = await request(app).post('/api/contact').send(valid);

      expect(res.status).toBe(202);
      expect(postDiscordEmbed).toHaveBeenCalledTimes(1);
    });

    it('refuse un message invalide (400) sans rien transmettre', async () => {
      const res = await request(app).post('/api/contact').send({ ...valid, email: 'pas-un-email' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Email invalide');
      expect(postDiscordEmbed).not.toHaveBeenCalled();
    });

    it('répond 503 SUPPORT_UNAVAILABLE quand le canal support est injoignable', async () => {
      jest.mocked(postDiscordEmbed).mockResolvedValue(false);

      const res = await request(app).post('/api/contact').send(valid);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SUPPORT_UNAVAILABLE');
    });

    it('limite le nombre de messages par adresse IP', async () => {
      jest.mocked(postDiscordEmbed).mockResolvedValue(true);

      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await request(app).post('/api/contact').send(valid)).status);
      }

      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    });
  });
});
