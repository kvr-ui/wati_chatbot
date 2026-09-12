const $ = (id) => document.getElementById(id);
let sessionId = crypto.randomUUID();
let busy = false;
let messages = 0;

function reviewTime(timestamp) {
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function reviewCard(review) {
  const card = document.createElement('article');
  card.className = 'review-card';
  const name = document.createElement('strong');
  name.textContent = review.reviewer;
  const time = document.createElement('time');
  time.dateTime = review.createdAt;
  time.textContent = reviewTime(review.createdAt);
  const content = document.createElement('p');
  content.textContent = review.content;
  card.append(name, time, content);
  return card;
}

function renderReviews(reviews) {
  const list = $('reviews');
  list.replaceChildren();
  if (!reviews.length) {
    const empty = document.createElement('p');
    empty.className = 'no-reviews';
    empty.textContent = 'No reviews saved yet.';
    list.append(empty);
    return;
  }
  reviews.forEach((review) => list.append(reviewCard(review)));
}

async function loadReviews() {
  try {
    const response = await fetch('/api/feedback');
    const result = await response.json();
    if (!response.ok) throw new Error();
    renderReviews(result.reviews);
  } catch {
    $('reviews').textContent = 'Could not load saved reviews.';
  }
}

function setBusy(value) {
  busy = value;
  $('send').disabled = value || !$('message').value.trim();
  $('new-chat').disabled = value;
}

function addMessage(role, text, typing = false) {
  const row = document.createElement('div');
  row.className = `message ${role}${typing ? ' typing' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.append(bubble);
  $('conversation').append(row);
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return row;
}

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
}

async function send() {
  const text = $('message').value.trim();
  if (!text || busy) return;

  $('error').hidden = true;
  $('empty-state').hidden = true;
  addMessage('user', text);
  messages++;
  $('message').value = '';
  resize();
  setBusy(true);
  const waiting = addMessage('assistant', 'Thinking…', true);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
      signal: AbortSignal.timeout(90_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not get an answer.');
    waiting.remove();
    const replies = result.replies.length ? result.replies : ['This chat is paused. Type “bot” to continue.'];
    replies.forEach((reply) => addMessage('assistant', reply));
  } catch (error) {
    waiting.remove();
    showError(error.name === 'TimeoutError' ? 'The reply took too long. Please try again.' : error.message);
  } finally {
    setBusy(false);
    $('message').focus();
  }
}

function resize() {
  const input = $('message');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  $('send').disabled = busy || !input.value.trim();
}

$('chat-form').addEventListener('submit', (event) => { event.preventDefault(); send(); });
$('message').addEventListener('input', resize);
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});
$('new-chat').addEventListener('click', async () => {
  if (busy) return;
  try {
    if (messages) await fetch(`/api/chat/${sessionId}`, { method: 'DELETE' });
    sessionId = crypto.randomUUID();
    messages = 0;
    $('conversation').querySelectorAll('.message').forEach((node) => node.remove());
    $('empty-state').hidden = false;
    $('error').hidden = true;
    $('message').focus();
  } catch {
    showError('Could not start a new chat. Please refresh the page.');
  }
});

$('feedback-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reviewer = $('reviewer').value.trim() || 'Test team';
  const content = $('review').value.trim();
  if (!content) return;

  const button = $('save-review');
  const status = $('review-status');
  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reviewer, content }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save the review.');
    $('review').value = '';
    status.textContent = 'Review saved.';
    const first = $('reviews').firstElementChild;
    if (first?.classList.contains('no-reviews')) $('reviews').replaceChildren();
    $('reviews').prepend(reviewCard(result.review));
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

fetch('/health')
  .then((response) => response.json())
  .then((health) => { $('status').textContent = health.aiConfigured ? `Ready · ${health.model}` : 'OpenAI API key is missing'; })
  .catch(() => { $('status').textContent = 'Server unavailable'; });

loadReviews();
