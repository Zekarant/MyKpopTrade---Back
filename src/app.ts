import express from 'express';
import cors from 'cors';
import passport from 'passport';
import path from 'path';
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
import { logAPIRequest } from './commons/utils/logger';
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

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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
  app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
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

  // Note: path-to-regexp v8+ (Express 5) n'accepte plus le wildcard '*' nu.
  // `app.use(handler)` sans path matche toutes les requêtes non traitées ci-dessus.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// App par défaut pour les cas simples (compat ascendante avec import app from './app')
export default createApp();
