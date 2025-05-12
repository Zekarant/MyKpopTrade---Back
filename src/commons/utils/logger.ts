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
const logsSanitizer = winston.format((info) => {
  // Liste des champs sensibles à masquer dans les logs
  const sensitiveFields = ['password', 'token', 'email', 'paypalEmail', 'address', 'phoneNumber', 'fullName'];
  
  // Fonction récursive pour masquer les données sensibles
  const sanitizeObject = (obj: any): any => {
    if (!obj) return obj;
    
    const newObj = { ...obj };
    
    Object.keys(newObj).forEach(key => {
      // Si c'est un champ sensible et une chaîne
      if (sensitiveFields.includes(key) && typeof newObj[key] === 'string') {
        // Masquer l'email en ne gardant que les 3 premiers caractères
        if (key.includes('email') && newObj[key].includes('@')) {
          const [localPart, domain] = newObj[key].split('@');
          newObj[key] = `${localPart.substring(0, 3)}***@***${domain.substring(domain.lastIndexOf('.'))}`;
        } else {
          // Masquer complètement les autres données sensibles
          newObj[key] = '******';
        }
      } 
      // Traiter les objets imbriqués
      else if (typeof newObj[key] === 'object' && newObj[key] !== null) {
        newObj[key] = sanitizeObject(newObj[key]);
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
    winston.format.json(),
    logsSanitizer()
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