declare global {
    namespace NodeJS {
      interface ProcessEnv {
        // Environnement
        NODE_ENV: 'development' | 'test' | 'production';
        PORT: string;
        API_URL: string;
        FRONTEND_URL: string;
        
        // Base de données
        MONGODB_URI: string;
        
        // JWT
        JWT_SECRET: string;
        JWT_EXPIRE: string;
        JWT_REFRESH_EXPIRE: string;
        
        // Email
        EMAIL_SERVICE?: string;
        EMAIL_HOST?: string;
        EMAIL_PORT?: string;
        EMAIL_USER?: string;
        EMAIL_PASS?: string;
        FROM_EMAIL: string;
        
        // SMS
        SMS_ENABLED: string;
        TWILIO_ACCOUNT_SID?: string;
        TWILIO_AUTH_TOKEN?: string;
        TWILIO_PHONE_NUMBER?: string;
        
        // Auth sociale
        GOOGLE_CLIENT_ID?: string;
        GOOGLE_CLIENT_SECRET?: string;
        FACEBOOK_APP_ID?: string;
        FACEBOOK_APP_SECRET?: string;
        DISCORD_CLIENT_ID?: string;
        DISCORD_CLIENT_SECRET?: string;
        
        // Logs
        LOG_LEVEL?: 'error' | 'warn' | 'info' | 'debug';
      }
    }
  }
  
  // Exporter un objet vide est nécessaire pour que ce soit un module
  export {};