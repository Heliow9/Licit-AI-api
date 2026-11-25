const options = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

module.exports = [
  `CREATE TABLE IF NOT EXISTS companies (
    id CHAR(24) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    cnpj VARCHAR(14) UNIQUE,
    contact JSON NOT NULL,
    address JSON NOT NULL,
    plan VARCHAR(40) NOT NULL,
    createdBy CHAR(24),
    complianceChecklist JSON,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL
  ) ${options}`,
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(24) PRIMARY KEY,
    email VARCHAR(254) COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
    passwordHash VARCHAR(100) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(30) NOT NULL,
    companyId CHAR(24),
    status VARCHAR(30) NOT NULL,
    settings JSON NOT NULL,
    lastLoginAt DATETIME(3),
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    KEY users_company (companyId),
    FOREIGN KEY (companyId) REFERENCES companies(id)
  ) ${options}`,
  `CREATE TABLE IF NOT EXISTS cats (
    id CHAR(24) PRIMARY KEY,
    companyId CHAR(24) NOT NULL,
    source VARCHAR(600) COLLATE utf8mb4_bin NOT NULL,
    fileName VARCHAR(255) NOT NULL,
    gestor VARCHAR(255) NOT NULL,
    fullText LONGTEXT NOT NULL,
    docType VARCHAR(60),
    meta JSON NOT NULL,
    linkKeys JSON,
    domain VARCHAR(100),
    keywords JSON NOT NULL,
    chunkCount INT UNSIGNED NOT NULL,
    processedAt DATETIME(3) NOT NULL,
    UNIQUE KEY cats_company_source (companyId, source),
    KEY cats_company_processed (companyId, processedAt, id),
    FOREIGN KEY (companyId) REFERENCES companies(id)
  ) ${options}`,
  `CREATE TABLE IF NOT EXISTS chunks (
    companyId CHAR(24) NOT NULL,
    source VARCHAR(600) COLLATE utf8mb4_bin NOT NULL,
    chunkIndex INT UNSIGNED NOT NULL,
    text LONGTEXT NOT NULL,
    embedding JSON,
    PRIMARY KEY (companyId, source, chunkIndex),
    FULLTEXT KEY chunks_text (text),
    FOREIGN KEY (companyId, source) REFERENCES cats(companyId, source) ON DELETE CASCADE
  ) ${options}`,
  `CREATE TABLE IF NOT EXISTS app_bootstrap (
    id TINYINT PRIMARY KEY,
    completed BOOLEAN NOT NULL
  ) ${options}`,
];
