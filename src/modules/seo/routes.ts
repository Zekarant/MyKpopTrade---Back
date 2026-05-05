import express from 'express';
import { sitemapXml, robotsTxt } from './seoController';

/**
 * Routes SEO publiques (pas d'auth). Montées à la racine pour exposer
 * /sitemap.xml et /robots.txt aux crawlers.
 */
const router = express.Router();

router.get('/sitemap.xml', sitemapXml);
router.get('/robots.txt', robotsTxt);

export default router;
