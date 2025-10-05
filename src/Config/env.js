require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3001,

  // Mongo
  MONGO_URI: process.env.MONGO_URI,

  // Azure OpenAI
  AZ_ENDPOINT: (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/,''),
  AZ_VER: process.env.AZURE_OPENAI_API_VERSION || '2024-06-01',
  AZ_KEY: process.env.AZURE_OPENAI_API_KEY || '',
  CHAT_DEPLOY: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o-mini',
  EMBED_DEPLOY: process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'text-embedding-3-small',

  // OCR / ingestão
  OCR_ENABLED: String(process.env.OCR_ENABLED || 'false').toLowerCase() === 'true',
  OCR_MAX_PAGES: parseInt(process.env.OCR_MAX_PAGES || '2', 10),
  CATS_ROOT: process.env.CATS_ROOT || require('path').join(__dirname, '..', '..', 'data', 'cats_poc'),
  MAX_EDITALTEXT_CHARS: parseInt(process.env.MAX_EDITALTEXT_CHARS || '50000', 10),
  MAX_CHUNKS_PER_FILE: parseInt(process.env.MAX_CHUNKS_PER_FILE || '1200', 10),

  // Auth
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
  JWT_EXPIRES: process.env.JWT_EXPIRES || '7d',
  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  ALLOW_OPEN_REG: String(process.env.ALLOW_OPEN_REG || '1') === '1',
};
