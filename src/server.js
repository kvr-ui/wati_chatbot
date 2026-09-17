import { app } from './app.js';
import { config } from './config.js';
import { ensureIndex } from './kb.js';
import { loadOptIns } from './optin.js';
import { loadOptOuts } from './optout.js';
import { loadCampaignState } from './campaign.js';
import { loadHandovers } from './handover.js';

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
    loadOptOuts().then((count) => console.log(`STOP: ${count} lead(s) opted out and will not be answered`));
    loadHandovers().then((count) => console.log(`Handover: ${count} chat(s) with an agent right now`));
    if (!config.webhookVerifyToken) {
      console.log('WARNING: WEBHOOK_VERIFY_TOKEN is empty - anyone who finds the webhook URL can post fake messages to it.');
    }
    if (!config.bot.handoverOperatorEmail) {
      console.log('WARNING: HANDOVER_OPERATOR_EMAIL is empty - a lead who asks for a person is not assigned to anyone.');
    }

    const phrases = config.whatsappUnlockPhrases;
    if (allowed.length && phrases.length) {
      // Plus any lead that opts itself in by sending the campaign phrase.
      loadOptIns().then((count) =>
        console.log(
          `Campaign opt-in phrase: "${phrases.join('" / "')}" keeps the bot on until the lead is silent for ${config.whatsappOptInHours} hours (${count} lead(s) active now)`
        )
      );
      loadCampaignState().then((count) => console.log(`Campaign question: ${count} lead(s) have named their group`));
    }
  }
  ensureIndex({ log: console.log }).catch(() => console.error('Knowledge indexing failed. Check your AI configuration.'));
});
