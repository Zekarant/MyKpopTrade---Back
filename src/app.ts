import express from 'express';
import cors from 'cors';
import passport from 'passport';
import path from 'path';
import mongoose from 'mongoose';
import env from './config/env';
import { authRoutes } from './modules/auth';
import { userRoute } from './modules/users';
import { profileRoutes } from './modules/profiles';
import { productRoutes } from './modules/products';
import { messagingRoutes } from './modules/messaging';
import notificationRoutes from './modules/notifications/routes';
import paymentRoutes from './modules/payments/routes';
import accountsRoutes from './modules/accounts/routes';
import groupRoutes from './modules/groups/routes';
import albumRoutes from './modules/albums/routes';
import searchRoutes from './modules/search/routes';
import addressRoutes from './modules/addresses/routes';
import { errorHandler, notFoundHandler } from './commons/middlewares/errorMiddleware';
import { initializePassport } from './config/passport';
import logger, { logAPIRequest } from './commons/utils/logger';
import { verificationRoutes } from './modules/verification';
import { reportRoutes } from './modules/reports';
import followRoutes from './modules/follows/routes';
import postRoutes from './modules/posts/routes';
import seoRoutes from './modules/seo/routes';
import disputeRoutes from './modules/disputes/routes';
import cartRoutes from './modules/cart/routes';

/**
 * Crée l'application Express configurée (middlewares + routes + handlers).
 * N'établit PAS la connexion MongoDB ni n'écoute sur un port.
 *
 * Utiliser directement en tests avec supertest ; voir index.ts pour le démarrage
 * en production (connexion DB + listen).
 */
export function createApp(): express.Express {
  const app = express();

  // req.ip doit refléter l'IP réelle du client : le rate limiting par IP en dépend.
  // 0 en local, 1 derrière un unique reverse proxy (nginx, Heroku, Render...).
  app.set('trust proxy', env.TRUST_PROXY);

  // CORS restreint : seules les origines déclarées peuvent appeler l'API avec
  // des credentials. Les appels sans en-tête Origin (webhooks PayPal,
  // scripts serveur, health checks) restent autorisés.
  const allowedOrigins = new Set(
    [env.FRONTEND_URL, ...env.CORS_ORIGINS.split(',')]
      .map(origin => origin.trim())
      .filter(Boolean)
  );

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      logger.warn('Origine CORS refusée', { origin });
      callback(null, false);
    },
    credentials: true
  }));

  // Plafonner la taille des corps de requête : sans limite, un seul POST peut
  // saturer la mémoire du process. Les images passent par multer (multipart),
  // qui a ses propres limites et n'est pas concerné.
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));

  app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      logAPIRequest(req, responseTime);
    });
    next();
  });

  initializePassport();
  app.use(passport.initialize());

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoute);
  app.use('/api/profiles', profileRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/verification', verificationRoutes);
  app.use('/api/messaging', messagingRoutes);
  // ⚠️ NE PAS servir tout `uploads/` en statique : il contient
  // `chat_attachments/`, des pièces jointes de conversations privées. Les
  // exposer sans authentification contournait entièrement le contrôle
  // d'appartenance à la conversation fait par
  // GET /api/messaging/messages/:messageId/attachments/:attachment.
  //
  // Seuls les dossiers dont le contenu est public par nature sont servis ici.
  const PUBLIC_UPLOAD_DIRS = ['products', 'profiles', 'banners', 'ratings'];
  for (const dir of PUBLIC_UPLOAD_DIRS) {
    app.use(`/uploads/${dir}`, express.static(path.join(__dirname, '../uploads', dir)));
  }
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/accounts', accountsRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/albums', albumRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/addresses', addressRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/follows', followRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/disputes', disputeRoutes);
  app.use('/api/cart', cartRoutes);

  // Routes SEO publiques (sitemap, robots) servies à la racine pour les crawlers
  app.use('/', seoRoutes);

  app.get('/', (req, res) => {
    res.send('API MyKpopTrade v1.0.0');
  });

  // Liveness : le process répond. Ne teste aucune dépendance, pour qu'un
  // orchestrateur ne redémarre pas l'API parce que Mongo est momentanément down.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  // Readiness : l'API est capable de servir du trafic (Mongo joignable).
  // 1 = connected dans l'énumération mongoose.ConnectionStates.
  app.get('/ready', (req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;
    res.status(isDbConnected ? 200 : 503).json({
      status: isDbConnected ? 'ready' : 'unavailable',
      database: isDbConnected ? 'connected' : 'disconnected'
    });
  });

  // Note: path-to-regexp v8+ (Express 5) n'accepte plus le wildcard '*' nu.
  // `app.use(handler)` sans path matche toutes les requêtes non traitées ci-dessus.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// App par défaut pour les cas simples (compat ascendante avec import app from './app')
export default createApp();
