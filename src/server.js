import { app } from './app.js';
import { config } from './config.js';
import { ensureIndex } from './kb.js';

app.listen(config.port, config.host, () => {
  console.log(`${config.bot.name}: http://${config.host}:${config.port}`);
  console.log(`Provider: ${config.ai.provider}; WhatsApp: ${config.whatsappEnabled ? 'enabled' : 'disabled (test mode)'}`);
  if (config.whatsappEnabled) {
    const allowed = [...config.whatsappAllowedNumbers];
    console.log(
      allowed.length
        ? `Replying ONLY to: ${allowed.join(', ')} (WHATSAPP_ALLOWED_NUMBERS)`
        : 'WARNING: replying to ALL inbound WhatsApp messages, including real customers.'
    );
  }
  ensureIndex({ log: console.log }).catch(() => console.error('Knowledge indexing failed. Check your AI configuration.'));
});
