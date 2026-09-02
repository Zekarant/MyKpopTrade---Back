import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// Créer le répertoire des logs s'il n'existe pas
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Format personnalisé pour les logs
const customFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
  return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaStr}`;
});

// Configuration des transports en fonction de l'environnement
const transports: winston.transport[] = [
  // Log tout dans un fichier combiné
  new winston.transports.File({
    filename: path.join(logDir, 'combined.log'),
    level: 'info'
  }),
  
  // Log les erreurs dans un fichier séparé
  new winston.transports.File({
    filename: path.join(logDir, 'error.log'),
    level: 'error'
  })
];

// En développement, log aussi dans la console
if (process.env.NODE_ENV !== 'production') {
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
  // En production, rotation des logs
  // Nécessite winston-daily-rotate-file
  const { DailyRotateFile } = require('winston-daily-rotate-file');
  
  transports.push(
    new DailyRotateFile({
      filename: path.join(logDir, '%DATE%-app.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    })
  );
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
  'iban',
  'bic',
  'cvv'
]);

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_EXACT_FIELDS.has(key) || SENSITIVE_PATTERNS.some(pattern => pattern.test(key));

/** Pseudonymise un email en conservant de quoi diagnostiquer sans l'exposer. */
const maskEmail = (value: string): string => {
  const [localPart, domain] = value.split('@');
  const tld = domain.substring(domain.lastIndexOf('.'));
  return `${localPart.substring(0, 3)}***@***${tld}`;
};

const logsSanitizer = winston.format((info) => {
  // Fonction récursive pour masquer les données sensibles
  const sanitizeObject = (obj: any): any => {
    if (!obj) return obj;

    // Les tableaux doivent être parcourus, sinon un tableau d'objets contenant
    // des données personnelles échappait entièrement au masquage.
    if (Array.isArray(obj)) {
      return obj.map(item =>
        typeof item === 'object' && item !== null ? sanitizeObject(item) : item
      );
    }

    const newObj = { ...obj };

    Object.keys(newObj).forEach(key => {
      const value = newObj[key];

      if (typeof value === 'string' && isSensitiveKey(key)) {
        // Un email garde ses 3 premiers caractères et son TLD : assez pour
        // rapprocher deux événements, pas assez pour identifier la personne.
        newObj[key] = /e-?mail/i.test(key) && value.includes('@')
          ? maskEmail(value)
          : '******';
      } else if (typeof value === 'object' && value !== null) {
        newObj[key] = sanitizeObject(value);
      }
    });
    
    return newObj;
  };
  
  // Appliquer la sanitisation aux données du log
  return sanitizeObject(info);
});

// Création du logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
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

// Fonctions utilitaires pour les logs métier
export const logAuthEvent = (userId: string, event: string, details?: any) => {
  logger.info(`AUTH [${event}] - User ID: ${userId}`, { details });
};

export const logUserAction = (userId: string, action: string, details?: any) => {
  logger.info(`USER [${action}] - User ID: ${userId}`, { details });
};

export const logAPIRequest = (req: any, responseTime?: number) => {
  logger.debug(`API Request: ${req.method} ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId: (req.user as any)?.id || 'anonymous',
    userAgent: req.headers['user-agent'],
    responseTime: responseTime ? `${responseTime}ms` : undefined
  });
};