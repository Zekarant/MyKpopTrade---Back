import { Request, Response } from 'express';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';
import Product from '../../models/productModel';
import KpopGroup from '../../models/kpopGroupModel';
import KpopAlbum from '../../models/albumModel';
import env from '../../config/env';

const FRONTEND_URL = env.FRONTEND_URL.replace(/\/$/, '');
const SITEMAP_PRODUCT_LIMIT = 5000;
// Bornes des pages catalogue : le sitemap reste sous la limite de 50 000 URLs
// d'un seul fichier, annonces comprises.
const SITEMAP_GROUP_LIMIT = 2000;
const SITEMAP_ALBUM_LIMIT = 5000;

/**
 * Échappe une valeur pour XML. Les URLs peuvent contenir des `&` (params)
 * et il ne faut surtout pas les laisser dans un sitemap.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface SitemapEntry {
  loc: string;
  lastmod?: Date;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts = [`<loc>${xmlEscape(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`<lastmod>${entry.lastmod.toISOString()}</lastmod>`);
    if (entry.changefreq) parts.push(`<changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined) parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
    return `  <url>${parts.join('')}</url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/**
 * Sitemap dynamique. On y inclut :
 *   - les pages publiques statiques
 *   - les produits encore disponibles (limite SITEMAP_PRODUCT_LIMIT)
 *   - les pages /groups/:id des groupes actifs et /albums/:id de leurs albums
 *     (un groupe désactivé n'a plus de page à faire indexer)
 *
 * Renvoyé en cache 1h pour limiter la charge DB.
 */
export const sitemapXml = asyncHandler(async (_req: Request, res: Response) => {
  const staticPages: SitemapEntry[] = [
    { loc: `${FRONTEND_URL}/`, changefreq: 'daily', priority: 1.0 },
    { loc: `${FRONTEND_URL}/login`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${FRONTEND_URL}/register`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${FRONTEND_URL}/contact`, changefreq: 'monthly', priority: 0.4 }
  ];

  const products = await Product.find({ isAvailable: true, isSold: { $ne: true } })
    .sort('-updatedAt')
    .limit(SITEMAP_PRODUCT_LIMIT)
    .select('_id updatedAt')
    .lean();

  const productEntries: SitemapEntry[] = products.map((p) => ({
    loc: `${FRONTEND_URL}/products/${p._id}`,
    lastmod: p.updatedAt,
    changefreq: 'daily',
    priority: 0.7
  }));

  const groups = await KpopGroup.find({ isActive: true })
    .sort('-updatedAt')
    .limit(SITEMAP_GROUP_LIMIT)
    .select('_id updatedAt')
    .lean();
  const albums = await KpopAlbum.find({ artistId: { $in: groups.map((g) => g._id) } })
    .sort('-updatedAt')
    .limit(SITEMAP_ALBUM_LIMIT)
    .select('_id updatedAt')
    .lean();

  const catalogEntries: SitemapEntry[] = [
    ...groups.map((g): SitemapEntry => ({
      loc: `${FRONTEND_URL}/groups/${g._id}`,
      lastmod: g.updatedAt,
      changefreq: 'weekly',
      priority: 0.6
    })),
    ...albums.map((a): SitemapEntry => ({
      loc: `${FRONTEND_URL}/albums/${a._id}`,
      lastmod: a.updatedAt,
      changefreq: 'weekly',
      priority: 0.5
    }))
  ];

  const xml = renderSitemap([...staticPages, ...productEntries, ...catalogEntries]);

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(xml);
});

/**
 * robots.txt minimal : autorise le crawl public, bloque les routes privées
 * (chemins réels du routeur front) et expose le sitemap. Les profils publics
 * /adherents/profile/:id restent indexables.
 */
export const robotsTxt = asyncHandler(async (_req: Request, res: Response) => {
  const body = `User-agent: *
Allow: /
Disallow: /adherents/admin
Disallow: /adherents/payments
Disallow: /adherents/messages
Disallow: /adherents/settings
Disallow: /adherents/new
Disallow: /adherents/modify
Disallow: /adherents/review
Disallow: /cart
Disallow: /disputes
Disallow: /negotiate
Disallow: /payment/
Disallow: /api/

Sitemap: ${FRONTEND_URL}/sitemap.xml
`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(body);
});
