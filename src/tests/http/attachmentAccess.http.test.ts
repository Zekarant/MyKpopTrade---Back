import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../app';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';

/**
 * Ces tests verrouillent la confidentialité des pièces jointes de conversation.
 *
 * Régression historique : tout le dossier `uploads/` — dont
 * `uploads/chat_attachments/` — était servi par `express.static` sans
 * authentification. Le contrôle d'appartenance à la conversation fait par
 * GET /api/messaging/messages/:messageId/attachments/:attachment était donc
 * intégralement contournable en devinant l'URL du fichier. Quatre de ces noms
 * de fichiers ont d'ailleurs été publiés dans l'historique git du dépôt.
 *
 * Second point : cette route n'acceptait le jeton qu'en en-tête Authorization,
 * qu'une balise <img> ne peut pas envoyer — elle répondait donc 401 à tout
 * affichage d'image, ce qui poussait le front vers le chemin statique non
 * protégé.
 */
const app = createApp();

const ATTACHMENT_NAME = 'test-attachment-piece-jointe.jpg';
const attachmentPath = () =>
  path.join(process.cwd(), 'uploads', 'chat_attachments', ATTACHMENT_NAME);

const PUBLIC_FILE_NAME = 'test-image-publique.jpg';
const publicFilePath = () =>
  path.join(process.cwd(), 'uploads', 'products', PUBLIC_FILE_NAME);

describe('HTTP — confidentialité des pièces jointes de conversation', () => {
  beforeAll(async () => {
    await startInMemoryMongo();

    // Fichier de test dans le dossier réellement servi par l'application.
    fs.mkdirSync(path.dirname(attachmentPath()), { recursive: true });
    fs.writeFileSync(attachmentPath(), Buffer.from('contenu-prive-de-test'));

    fs.mkdirSync(path.dirname(publicFilePath()), { recursive: true });
    fs.writeFileSync(publicFilePath(), Buffer.from('image-publique-de-test'));
  }, 60000);

  afterAll(async () => {
    fs.rmSync(attachmentPath(), { force: true });
    fs.rmSync(publicFilePath(), { force: true });
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  /** Crée une conversation entre deux users, avec un message porteur d'une pièce jointe. */
  async function seedConversation() {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const intrus = await createTestUser();

    const conversation = await Conversation.create({
      participants: [alice._id, bob._id],
      createdBy: alice._id
    });

    const message = await Message.create({
      conversation: conversation._id,
      sender: alice._id,
      content: 'Voici la photo de la carte',
      contentType: 'text',
      attachments: [ATTACHMENT_NAME]
    });

    return { alice, bob, intrus, message };
  }

  describe('dossier statique', () => {
    it('ne sert PAS les pièces jointes de conversation, même avec le bon nom de fichier', async () => {
      const res = await request(app).get(`/uploads/chat_attachments/${ATTACHMENT_NAME}`);

      expect(res.status).toBe(404);
      expect(res.text).not.toContain('contenu-prive-de-test');
    });

    it('continue de servir les dossiers publics (photos d\'annonces)', async () => {
      const res = await request(app).get(`/uploads/products/${PUBLIC_FILE_NAME}`);

      expect(res.status).toBe(200);
      expect(res.body.toString()).toContain('image-publique-de-test');
    });
  });

  describe('route authentifiée', () => {
    it('refuse une requête sans jeton', async () => {
      const { message } = await seedConversation();

      const res = await request(app).get(
        `/api/messaging/messages/${message._id}/attachments/${ATTACHMENT_NAME}`
      );

      expect(res.status).toBe(401);
    });

    it('refuse un utilisateur qui n\'est pas participant à la conversation', async () => {
      const { intrus, message } = await seedConversation();
      const token = generateAccessToken(intrus);

      const res = await request(app)
        .get(`/api/messaging/messages/${message._id}/attachments/${ATTACHMENT_NAME}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('sert la pièce jointe à un participant via l\'en-tête Authorization', async () => {
      const { bob, message } = await seedConversation();
      const token = generateAccessToken(bob);

      const res = await request(app)
        .get(`/api/messaging/messages/${message._id}/attachments/${ATTACHMENT_NAME}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.toString()).toContain('contenu-prive-de-test');
    });

    it('sert la pièce jointe à un participant via ?token= (cas de la balise <img>)', async () => {
      const { alice, message } = await seedConversation();
      const token = generateAccessToken(alice);

      const res = await request(app).get(
        `/api/messaging/messages/${message._id}/attachments/${ATTACHMENT_NAME}?token=${token}`
      );

      expect(res.status).toBe(200);
      expect(res.body.toString()).toContain('contenu-prive-de-test');
    });

    it('applique le contrôle d\'appartenance aussi avec ?token=', async () => {
      const { intrus, message } = await seedConversation();
      const token = generateAccessToken(intrus);

      const res = await request(app).get(
        `/api/messaging/messages/${message._id}/attachments/${ATTACHMENT_NAME}?token=${token}`
      );

      expect(res.status).toBe(403);
    });

    it('refuse un nom de pièce jointe non rattaché au message', async () => {
      const { alice, message } = await seedConversation();
      const token = generateAccessToken(alice);

      const res = await request(app)
        .get(`/api/messaging/messages/${message._id}/attachments/autre-fichier.jpg`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
