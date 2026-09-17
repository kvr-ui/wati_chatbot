import { config } from './config.js';
import { matchTrigger } from './keywords.js';
import { answer, renderTemplate } from './ai.js';
import { getSession, remember } from './sessions.js';
import { logTurn } from './conversations.js';
import { campaignStep } from './campaign.js';
import { isOptedOut, isOptOutRequest, optOut } from './optout.js';
import { pauseForHandover, isPaused, resume } from './handover.js';

/**
 * Core bot brain. Transport-agnostic so both the WATI webhook and the
 * local CLI (npm run chat) go through exactly the same path.
 *
 * Wraps {@link route} so every exchange is recorded exactly once, whichever
 * branch answers it - a turn that failed included, so the lead's message is
 * not missing from their history when the model or a service was down.
 *
 * @returns {{ replies: string[], meta: object }}
 */
export async function handleMessage(event) {
  const started = Date.now();
  const waId = String(event.waId ?? '');
  const record = (replies, meta) =>
    logTurn({
      waId,
      name: event.name,
      channel: waId.startsWith('preview:') ? 'preview' : 'whatsapp',
      text: String(event.text ?? ''),
      replies,
      meta,
      elapsedMs: Date.now() - started,
    });

  let result;
  try {
    result = await route(event);
  } catch (err) {
    await record([], { reason: 'error' });
    throw err;
  }
  await record(result.replies, result.meta);
  return result;
}

/** Media a person sends on purpose. Reactions, stickers and system notices get no reply. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'location', 'contacts', 'contact']);
const MEDIA_NOTICE = "Thanks, we've got it 🙏 I can't open photos, voice notes or files here, so please type your question and I'll help right away.";
/** Five photos in a row get one notice, not five. */
const MEDIA_NOTICE_EVERY_MS = 10 * 60_000;

async function route({ waId, name, text, type = 'text' }) {
  const session = getSession(waId, name);
  const vars = { name: session.name || 'there', bot: config.bot.name };
  const isText = type === 'text' && Boolean(text?.trim());

  // A lead who replied STOP is never answered again, whatever they send.
  if (await isOptedOut(waId)) return { replies: [], meta: { reason: 'opted_out' } };

  const trigger = isText ? matchTrigger(text) : null;

  // STOP itself gets no reply either. Checked before the pause and the campaign
  // script, which would otherwise read it as an unclear group answer and re-ask.
  if (isText && (trigger?.action === 'optout' || isOptOutRequest(text))) {
    await optOut(waId, { name: session.name, text });
    return { replies: [], meta: { trigger: trigger?.action === 'optout' ? trigger.id : 'stop', reason: 'opted_out' } };
  }

  // A human agent has taken over: stay silent unless explicitly asked to resume.
  // Photos and voice notes included - those are for the agent.
  if (await isPaused(waId)) {
    if (trigger?.action === 'resume') {
      await resume(waId);
      const reply = renderTemplate(trigger.reply || 'The bot is back. How can I help?', vars);
      return finish(session, text, { replies: [reply], meta: { trigger: trigger.id, reason: 'resumed' } });
    }
    return { replies: [], meta: { reason: 'paused_for_agent' } };
  }

  if (!isText) {
    if (!MEDIA_TYPES.has(String(type)) || Date.now() - (session.mediaNoticeAt ?? 0) < MEDIA_NOTICE_EVERY_MS) {
      return { replies: [], meta: { reason: 'non_text_ignored', type: type ?? null } };
    }
    session.mediaNoticeAt = Date.now();
    return { replies: [MEDIA_NOTICE], meta: { reason: 'non_text', type } };
  }

  // Asking for a person always wins, even halfway through the campaign question.
  if (trigger?.action === 'handover') {
    await pauseForHandover(waId);
    const reply = renderTemplate(trigger.reply || config.bot.handoverMessage, vars);
    return finish(session, text, {
      replies: [reply],
      meta: { trigger: trigger.id, reason: 'handover', handover: true },
    });
  }

  // The January 2027 campaign script. It runs ahead of keyword matching so a
  // bare "2" is read as the group the lead picked and not as some other
  // trigger; it returns null for every message that is not part of the script.
  const campaign = await campaignStep({ waId, name: session.name, text, hasTopic: trigger?.action === 'ai' });
  if (campaign && !campaign.answer) return finish(session, text, campaign);

  // Not scripted, or scripted and carrying a question of its own.
  const normal = await respond({ session, text, trigger, vars });
  if (!campaign) return finish(session, text, normal);

  const replies = campaign.answer === 'before'
    ? [...normal.replies, ...campaign.replies]
    : [...campaign.replies, ...normal.replies];
  // The campaign's reason and trigger describe the turn; the answer adds its sources.
  return finish(session, text, { replies, meta: { ...normal.meta, ...campaign.meta } });
}

/** Remembers a completed exchange, so a failed one never enters the history. */
function finish(session, text, result) {
  if (result.replies.length) {
    remember(session, 'user', text);
    remember(session, 'assistant', result.replies.join('\n'));
  }
  return result;
}

/** A static trigger reply, a knowledge-base answer, or the fallback. */
async function respond({ session, text, trigger, vars }) {
  if (trigger?.action === 'reply' && trigger.reply) {
    const replies = (Array.isArray(trigger.reply) ? trigger.reply : [trigger.reply]).map((r) =>
      renderTemplate(r, vars)
    );
    return {
      replies,
      meta: { trigger: trigger.id, matchedKeyword: trigger.matchedKeyword, reason: 'static_reply' },
    };
  }

  if (trigger && trigger.action !== 'resume') {
    // trigger routed to the knowledge base, optionally scoped to one topic
    const ai = await answer(text, {
      history: session.history,
      extraInstruction: trigger.prompt,
      kbFilter: trigger.kbFilters?.length ? trigger.kbFilters : trigger.kbFilter,
    });
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
    return { replies: [renderTemplate(config.bot.fallbackMessage, vars)], meta: { reason: 'static_fallback' } };
  }

  const ai = await answer(text, { history: session.history });
  return {
    replies: [ai.text],
    meta: { reason: 'ai_fallback', provider: ai.provider, model: ai.model, sources: ai.sources },
  };
}
