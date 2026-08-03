const path = require('path');
const fs = require('fs');

// Load custom config from config.json if present
let customConfig = {
  port: 6300,
  secretKey: 'THISISMYSECURETOKEN'
};

const customConfigPath = path.join(__dirname, 'config.json');
if (fs.existsSync(customConfigPath)) {
  try {
    const fileContent = fs.readFileSync(customConfigPath, 'utf8');
    const parsed = JSON.parse(fileContent);
    Object.assign(customConfig, parsed);
  } catch (e) {
    console.error('[start.js] Error reading config.json:', e);
  }
}

if (process.env.PORT) {
  customConfig.port = parseInt(process.env.PORT, 10);
}
if (process.env.AUTHENTICATION_API_KEY) {
  customConfig.secretKey = process.env.AUTHENTICATION_API_KEY;
}

// Export resolved config for server modules
process.env.PORT = String(customConfig.port);
process.env.AUTHENTICATION_API_KEY = customConfig.secretKey;

const distServerPath = path.join(__dirname, 'dist', 'server.js');
if (fs.existsSync(distServerPath)) {
  console.log('[start.js] Launching WinZapp Baileys Gateway Server from dist/server.js...');
  require(distServerPath);
} else {
  console.log('[start.js] Compiled server.js not found in dist/. Registering ts-node...');
  try {
    require('ts-node/register');
    require(path.join(__dirname, 'src', 'server.ts'));
  } catch (err) {
    console.error('[start.js] Failed to launch server:', err);
    process.exit(1);
  }
}
