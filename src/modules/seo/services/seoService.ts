import Product from '../../../models/productModel';
import KpopGroup from '../../../models/kpopGroupModel';
import KpopAlbum from '../../../models/albumModel';

const SITEMAP_PRODUCT_LIMIT = 5000;
// Bornes des pages catalogue : le sitemap reste sous la limite de 50 000 URLs
// d'un seul fichier, annonces comprises.
const SITEMAP_GROUP_LIMIT = 2000;
const SITEMAP_ALBUM_LIMIT = 5000;

interface SitemapEntry {
  loc: string;
  lastmod?: Date;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

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

/** Annonces encore en vente, les plus récemment modifiées d'abord. */
async function listProductEntries(frontendUrl: string): Promise<SitemapEntry[]> {
  const products = await Product.find({ isAvailable: true, isSold: { $ne: true } })
    .sort('-updatedAt')
    .limit(SITEMAP_PRODUCT_LIMIT)
    .select('_id updatedAt')
    .lean();

  return products.map((p) => ({
    loc: `${frontendUrl}/products/${p._id}`,
    lastmod: p.updatedAt,
    changefreq: 'daily',
    priority: 0.7
  }));
}

/** Pages des groupes actifs et de leurs albums (un groupe désactivé n'a plus de page à indexer). */
async function listCatalogEntries(frontendUrl: string): Promise<SitemapEntry[]> {
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

  return [
    ...groups.map((g): SitemapEntry => ({
      loc: `${frontendUrl}/groups/${g._id}`,
      lastmod: g.updatedAt,
      changefreq: 'weekly',
      priority: 0.6
    })),
    ...albums.map((a): SitemapEntry => ({
      loc: `${frontendUrl}/albums/${a._id}`,
      lastmod: a.updatedAt,
      changefreq: 'weekly',
      priority: 0.5
    }))
  ];
}

/**
 * Sitemap XML : pages publiques statiques, annonces en vente
 * (SITEMAP_PRODUCT_LIMIT au plus), pages des groupes actifs et de leurs albums.
 */
export async function buildSitemapXml(frontendUrl: string): Promise<string> {
  const staticPages: SitemapEntry[] = [
    { loc: `${frontendUrl}/`, changefreq: 'daily', priority: 1.0 },
    { loc: `${frontendUrl}/login`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${frontendUrl}/register`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${frontendUrl}/contact`, changefreq: 'monthly', priority: 0.4 }
  ];
  const [productEntries, catalogEntries] = await Promise.all([
    listProductEntries(frontendUrl),
    listCatalogEntries(frontendUrl)
  ]);
  return renderSitemap([...staticPages, ...productEntries, ...catalogEntries]);
}

/**
 * robots.txt minimal : autorise le crawl public, bloque les routes privées
 * (chemins réels du routeur front) et expose le sitemap. Les profils publics
 * /adherents/profile/:id restent indexables.
 */
export function buildRobotsTxt(frontendUrl: string): string {
  return `User-agent: *
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

Sitemap: ${frontendUrl}/sitemap.xml
`;
}
