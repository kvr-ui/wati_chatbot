import { app } from './app.js';
import { config } from './config.js';
import { ensureIndex } from './kb.js';
import { loadOptIns } from './optin.js';
import { loadCampaignState } from './campaign.js';

app.listen(config.port, config.host, () => {
  console.log(`${config.bot.name}: http://${config.host}:${config.port}`);
  console.log(`Model: OpenAI ${config.openai.chatModel}; WhatsApp: ${config.whatsappEnabled ? 'enabled' : 'disabled (test mode)'}`);
  if (config.whatsappEnabled) {
    const allowed = [...config.whatsappAllowedNumbers];
    console.log(
      allowed.length
        ? `Replying ONLY to: ${allowed.join(', ')} (WHATSAPP_ALLOWED_NUMBERS)`
        : 'WARNING: replying to ALL inbound WhatsApp messages, including real customers.'
    );

    const phrases = config.whatsappUnlockPhrases;
    if (allowed.length && phrases.length) {
      // Plus any lead that opts itself in by sending the campaign phrase.
      loadOptIns().then((count) =>
        console.log(`Campaign opt-in phrase: "${phrases.join('" / "')}" (${count} lead(s) opted in so far)`)
      );
      loadCampaignState().then((count) => console.log(`Campaign question: ${count} lead(s) have named their group`));
    }
  }
  ensureIndex({ log: console.log }).catch(() => console.error('Knowledge indexing failed. Check your AI configuration.'));
});
