import { config } from './config.js';
import { matchTrigger } from './keywords.js';
import { answer, renderTemplate } from './ai.js';
import { getSession, remember, pauseForHandover, isPaused, resume } from './sessions.js';
import { logTurn } from './conversations.js';
import { campaignStep } from './campaign.js';

/**
 * Core bot brain. Transport-agnostic so both the WATI webhook and the
 * local CLI (npm run chat) go through exactly the same path.
 *
 * Wraps {@link route} so every exchange is recorded exactly once, whichever
 * branch answers it.
 *
 * @returns {{ replies: string[], meta: object }}
 */
export async function handleMessage(event) {
  const started = Date.now();
  const result = await route(event);

  const waId = String(event.waId ?? '');
  await logTurn({
    waId,
    name: event.name,
    channel: waId.startsWith('preview:') ? 'preview' : 'whatsapp',
    text: String(event.text ?? ''),
    replies: result.replies,
    meta: result.meta,
    elapsedMs: Date.now() - started,
  });

  return result;
}

async function route({ waId, name, text, type = 'text' }) {
  const session = getSession(waId, name);
  const vars = { name: session.name || 'there', bot: config.bot.name };

  if (type !== 'text' || !text?.trim()) {
    return {
      replies: ['I can only read text messages right now. Please type your question.'],
      meta: { reason: 'non_text' },
    };
  }

  const trigger = matchTrigger(text);

  // A human agent has taken over: stay silent unless explicitly asked to resume.
  if (isPaused(session)) {
    if (trigger?.action === 'resume') {
      resume(session);
      const reply = renderTemplate(trigger.reply || 'The bot is back. How can I help?', vars);
      return { replies: [reply], meta: { trigger: trigger.id, reason: 'resumed' } };
    }
    return { replies: [], meta: { reason: 'paused_for_agent' } };
  }

  // The January 2027 campaign script. It runs ahead of keyword matching so a
  // bare "2" is read as the group the lead picked and not as some other
  // trigger; it returns null for every message that is not part of the script.
  const campaign = await campaignStep({ waId, name: session.name, text });
  if (campaign) {
    remember(session, 'user', text);
    remember(session, 'assistant', campaign.replies.join('\n'));
    return campaign;
  }

  if (trigger) {
    if (trigger.action === 'handover') {
      pauseForHandover(session);
      const reply = renderTemplate(trigger.reply || config.bot.handoverMessage, vars);
      remember(session, 'user', text);
      remember(session, 'assistant', reply);
      return { replies: [reply], meta: { trigger: trigger.id, reason: 'handover', handover: true } };
    }

    if (trigger.action === 'reply' && trigger.reply) {
      const replies = (Array.isArray(trigger.reply) ? trigger.reply : [trigger.reply]).map((r) =>
        renderTemplate(r, vars)
      );
      remember(session, 'user', text);
      remember(session, 'assistant', replies.join('\n'));
      return {
        replies,
        meta: { trigger: trigger.id, matchedKeyword: trigger.matchedKeyword, reason: 'static_reply' },
      };
    }

    // trigger routed to the knowledge base, optionally scoped to one topic
    const ai = await answer(text, {
      history: session.history,
      extraInstruction: trigger.prompt,
      kbFilter: trigger.kbFilters?.length ? trigger.kbFilters : trigger.kbFilter,
    });
    remember(session, 'user', text);
    remember(session, 'assistant', ai.text);
    return {
      replies: [ai.text],
      meta: {
        trigger: trigger.id,
        matchedKeyword: trigger.matchedKeyword,
        reason: 'trigger_ai',
        provider: ai.provider,
        model: ai.model,
        sources: ai.sources,
      },
    };
  }

  if (!config.bot.aiFallbackEnabled) {
    const reply = renderTemplate(config.bot.fallbackMessage, vars);
    remember(session, 'user', text);
    remember(session, 'assistant', reply);
    return { replies: [reply], meta: { reason: 'static_fallback' } };
  }

  const ai = await answer(text, { history: session.history });
  remember(session, 'user', text);
  remember(session, 'assistant', ai.text);
  return {
    replies: [ai.text],
    meta: { reason: 'ai_fallback', provider: ai.provider, model: ai.model, sources: ai.sources },
  };
}
