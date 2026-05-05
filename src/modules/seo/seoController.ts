import { Request, Response } from 'express';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';
import Product from '../../models/productModel';
import KpopGroup from '../../models/kpopGroupModel';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://www.mykpoptrade.com').replace(/\/$/, '');
const SITEMAP_PRODUCT_LIMIT = 5000;
const SITEMAP_GROUP_LIMIT = 1000;

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
 *   - les groupes K-Pop indexés
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

  const [products, groups] = await Promise.all([
    Product.find({ isAvailable: true, isSold: { $ne: true } })
      .sort('-updatedAt')
      .limit(SITEMAP_PRODUCT_LIMIT)
      .select('_id updatedAt')
      .lean(),
    KpopGroup.find({})
      .limit(SITEMAP_GROUP_LIMIT)
      .select('_id updatedAt')
      .lean()
  ]);

  const productEntries: SitemapEntry[] = products.map((p: any) => ({
    loc: `${FRONTEND_URL}/products/${p._id}`,
    lastmod: p.updatedAt,
    changefreq: 'daily',
    priority: 0.7
  }));

  const groupEntries: SitemapEntry[] = groups.map((g: any) => ({
    loc: `${FRONTEND_URL}/groups/${g._id}`,
    lastmod: g.updatedAt,
    changefreq: 'weekly',
    priority: 0.6
  }));

  const xml = renderSitemap([...staticPages, ...productEntries, ...groupEntries]);

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(xml);
});

/**
 * robots.txt minimal : autorise le crawl public, bloque les routes privées
 * et expose le sitemap.
 */
export const robotsTxt = asyncHandler(async (_req: Request, res: Response) => {
  const body = `User-agent: *
Allow: /
Disallow: /account
Disallow: /admin
Disallow: /payments
Disallow: /messages
Disallow: /api/

Sitemap: ${FRONTEND_URL}/sitemap.xml
`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(body);
});
