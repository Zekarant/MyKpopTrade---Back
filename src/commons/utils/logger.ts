import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import type { Request } from 'express';
import env from '../../config/env';
import { getRequestId } from './requestContext';

// Créer le répertoire des logs s'il n'existe pas
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Format personnalisé pour les logs
const customFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
});

// Configuration des transports en fonction de l'environnement.
// Fichier avec rotation dans tous les environnements : des fichiers sans
// rotation (anciens combined.log / error.log) grossissent jusqu'à remplir le
// disque. L'import de 'winston-daily-rotate-file' enregistre le transport.
const transports: winston.transport[] = [
  new winston.transports.DailyRotateFile({
    filename: path.join(logDir, '%DATE%-app.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
  })
];

if (env.NODE_ENV !== 'production') {
  // En développement, console lisible et colorée.
  transports.push(
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat
      )
    })
  );
} else {
  // En production (conteneurs), stdout est le canal collecté par la plateforme :
  // une ligne JSON par événement, telle que produite par le format du logger.
  transports.push(new winston.transports.Console());
}

// Configuration pour ne pas enregistrer d'informations sensibles
//
// Le masquage raisonne par MOTIF et non par nom exact : une liste exacte laissait
// passer toutes les variantes (`newPayPalEmail`, `passwordResetToken`,
// `shippingAddress`, `ipAddress`…). Un motif couvre la famille entière.
const SENSITIVE_PATTERNS = [
  /pass(word|phrase)/i,
  /token/i,
  /secret/i,
  /api-?key/i,
  /credential/i,
  /authorization/i,
  /e-?mail/i,
  /phone/i,
  /address/i
];

/**
 * Champs personnels dont le nom ne suit aucun motif générique. Volontairement
 * limité : `albumName`, `artistName`, `groupName` ou `memberName` sont des
 * métadonnées K-pop publiques et doivent rester lisibles pour le diagnostic.
 */
const SENSITIVE_EXACT_FIELDS = new Set([
  'fullName',
  'legalName',
  'recipientName',
  'firstName',
  'lastName',
  'streetLine1',
  'streetLine2',
  'postalCode',
  'city',
  'content',
  'iban',
  'bic',
  'cvv'
]);

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_EXACT_FIELDS.has(key) || SENSITIVE_PATTERNS.some(pattern => pattern.test(key));

/**
 * Jetons transportés dans une URL : ils apparaissent dans `url` et dans le texte
 * des logs, pas seulement sous une clé nommée « token ».
 */
const maskUrlSecrets = (value: string): string =>
  value
    .replace(/(\/(?:reset-password|verify-email)\/)[^/?\s"]+/g, '$1******')
    .replace(/([?&](?:token|accessToken|refreshToken|twoFactorToken)=)[^&\s"]+/g, '$1******');

/**
 * IP tronquée (dernier octet / fin d'IPv6) : assez pour repérer un abus depuis
 * un même réseau, sans conserver l'adresse exacte d'une personne.
 */
const truncateIp = (value: string): string => {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.replace(/\.\d{1,3}$/, '.0');
  if (value.includes(':')) return `${value.split(':').slice(0, 3).join(':')}::`;
  return '******';
};

/** Pseudonymise un email en conservant de quoi diagnostiquer sans l'exposer. */
const maskEmail = (value: string): string => {
  const [localPart, domain] = value.split('@');
  const tld = domain.substring(domain.lastIndexOf('.'));
  return `${localPart.substring(0, 3)}***@***${tld}`;
};

const logsSanitizer = winston.format((info) => {
  // Fonction récursive pour masquer les données sensibles
  const sanitizeObject = (obj: object): object => {
    // Les tableaux doivent être parcourus, sinon un tableau d'objets contenant
    // des données personnelles échappait entièrement au masquage.
    if (Array.isArray(obj)) {
      return obj.map((item: unknown) =>
        typeof item === 'object' && item !== null ? sanitizeObject(item) : item
      );
    }

    const newObj: Record<string, unknown> = { ...obj };
    sanitizeEntries(newObj);
    return newObj;
  };

  const sanitizeEntries = (newObj: Record<string, unknown>): void => {
    Object.keys(newObj).forEach(key => {
      const value = newObj[key];

      if (key === 'ip' && typeof value === 'string') {
        newObj[key] = truncateIp(value);
      } else if (typeof value === 'string' && isSensitiveKey(key)) {
        // Un email garde ses 3 premiers caractères et son TLD : assez pour
        // rapprocher deux événements, pas assez pour identifier la personne.
        newObj[key] = /e-?mail/i.test(key) && value.includes('@')
          ? maskEmail(value)
          : '******';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && isSensitiveKey(key)) {
        // Objet sensible entier (`shippingAddress: { streetLine1, city… }`) :
        // ses sous-champs n'ont pas des noms reconnaissables, on masque le bloc.
        newObj[key] = '******';
      } else if (typeof value === 'object' && value !== null) {
        newObj[key] = sanitizeObject(value);
      } else if (typeof value === 'string') {
        newObj[key] = maskUrlSecrets(value);
      }
    });
  };

  // Appliquer la sanitisation aux données du log
  const sanitizedInfo: winston.Logform.TransformableInfo = { ...info };
  sanitizeEntries(sanitizedInfo);
  return sanitizedInfo;
});

/** Ajoute l'identifiant de la requête HTTP en cours (cf. requestIdMiddleware). */
const requestIdFormat = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) info.requestId = requestId;
  return info;
});

// Création du logger
const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    requestIdFormat(),
    // ⚠️ ORDRE CRITIQUE : logsSanitizer() doit passer AVANT json(). json() fige
    // la ligne finale dans info[MESSAGE] ; tout format placé après n'a plus aucun
    // effet sur ce qui est écrit dans les fichiers de log (les mots de passe et
    // tokens repartaient donc en clair dans logs/error.log).
    logsSanitizer(),
    winston.format.json()
  ),
  defaultMeta: { service: 'mykpoptrade-api' },
  transports
});

export default logger;

export const logAPIRequest = (req: Request, responseTime?: number) => {
  logger.debug(`API Request: ${req.method} ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId: req.user?.id || 'anonymous',
    userAgent: req.headers['user-agent'],
    responseTime: responseTime ? `${responseTime}ms` : undefined
  });
};