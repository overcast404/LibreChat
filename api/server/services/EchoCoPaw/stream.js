const DEFAULT_CHAT_PATHS = ['/api/agent/process', '/api/console/chat'];
const FALLBACK_STATUSES = new Set([404, 405]);

function trimSlashes(value) {
  return String(value ?? '').replace(/^\/+|\/+$/g, '');
}

function joinUrl(baseUrl, path) {
  const cleanBase = String(baseUrl ?? '').replace(/\/+$/g, '');
  const cleanPath = trimSlashes(path);
  return `${cleanBase}/${cleanPath}`;
}

function resolveEchoCoPawBaseURL() {
  return (
    process.env.ECHO_COPAW_BASE_URL ||
    process.env.QWENPAW_BASE_URL ||
    'http://127.0.0.1:39088'
  );
}

function resolveEchoCoPawChatPaths() {
  if (process.env.ECHO_COPAW_CHAT_PATH) {
    return [process.env.ECHO_COPAW_CHAT_PATH];
  }

  const agentId = process.env.ECHO_COPAW_AGENT_ID || process.env.QWENPAW_AGENT_ID;
  if (agentId && agentId !== 'default') {
    return [
      '/api/agent/process',
      `/api/agents/${encodeURIComponent(agentId)}/console/chat`,
      '/api/console/chat',
    ];
  }

  return DEFAULT_CHAT_PATHS;
}

function getEchoCoPawAuthToken() {
  return process.env.ECHO_COPAW_API_TOKEN || process.env.QWENPAW_API_TOKEN || '';
}

function buildEchoCoPawPayload({ text, conversationId, userId, attachments = [] }) {
  return {
    input: [
      {
        role: 'user',
        type: 'message',
        content: [...(text ? [{ type: 'text', text }] : []), ...attachments],
      },
    ],
    session_id: conversationId,
    user_id: userId,
    channel: 'console',
    stream: true,
    metadata: {
      source: 'librechat',
    },
  };
}

async function openEchoCoPawStream({
  baseUrl = resolveEchoCoPawBaseURL(),
  chatPaths = resolveEchoCoPawChatPaths(),
  payload,
  signal,
  headers,
}) {
  let lastError;
  const body = JSON.stringify(payload);

  for (const path of chatPaths) {
    const url = joinUrl(baseUrl, path);
    const requestHeaders = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(headers ?? {}),
    };
    const token = getEchoCoPawAuthToken();
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body,
      signal,
    });

    if (response.ok) {
      return { response, url };
    }

    const responseText = await response.text().catch(() => '');
    lastError = new Error(
      `Echo CoPaw request failed: ${response.status} ${response.statusText} - ${responseText}`,
    );
    lastError.status = response.status;
    lastError.url = url;

    if (!FALLBACK_STATUSES.has(response.status)) {
      throw lastError;
    }
  }

  throw lastError ?? new Error('Echo CoPaw request failed before opening a stream.');
}

async function* iterEchoCoPawEvents(options) {
  const { response, url } = await openEchoCoPawStream(options);
  if (!response.body?.getReader) {
    throw new Error(`Echo CoPaw response has no readable stream: ${url}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const data = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        yield JSON.parse(data);
      } catch (_error) {
        // Ignore non-JSON keep-alive or diagnostic lines.
      }
    }
  }
}

module.exports = {
  buildEchoCoPawPayload,
  iterEchoCoPawEvents,
  joinUrl,
  openEchoCoPawStream,
  resolveEchoCoPawBaseURL,
  resolveEchoCoPawChatPaths,
};
