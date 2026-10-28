import { Request, Response } from 'express';
import env from '../../../config/env';
import { buildRobotsTxt, buildSitemapXml } from '../services/seoService';

const FRONTEND_URL = env.FRONTEND_URL.replace(/\/$/, '');

/** Sitemap dynamique, en cache 1h pour limiter la charge DB. */
export const sitemapXml = async (_req: Request, res: Response) => {
  const xml = await buildSitemapXml(FRONTEND_URL);
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(xml);
};

export const robotsTxt = (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(buildRobotsTxt(FRONTEND_URL));
};
