const { ContentTypes, ToolCallTypes } = require('librechat-data-provider');

const STREAM_ACCUMULATED_MESSAGE_TYPES = new Set([
  'message',
  'reasoning',
  'thinking',
  'plugin_call',
  'plugin_call_output',
  'function_call',
  'function_call_output',
  'tool_use',
  'tool_result',
  'mcp_call',
  'mcp_call_output',
]);

const THINKING_TYPES = new Set(['reasoning', 'thinking']);
const TOOL_CALL_TYPES = new Set(['plugin_call', 'function_call', 'tool_use', 'mcp_call']);
const TOOL_RESULT_TYPES = new Set([
  'plugin_call_output',
  'function_call_output',
  'tool_result',
  'mcp_call_output',
]);
const NON_TEXT_ASSISTANT_TYPES = new Set([
  ...THINKING_TYPES,
  ...TOOL_CALL_TYPES,
  ...TOOL_RESULT_TYPES,
]);

const DEFAULT_TOOL_NAME = 'Tool';
const LEGACY_TEXT_MESSAGE_ID = '__echo_copaw_text_delta__';

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
}

function parseJsonObject(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return asObject(parsed);
  } catch (_error) {
    return null;
  }
}

function normalizeToolOutputToString(output) {
  if (output == null) {
    return '';
  }
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output);
  } catch (_error) {
    return String(output);
  }
}

function normalizeToolArgs(args) {
  if (args == null) {
    return '';
  }
  if (typeof args === 'string') {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch (_error) {
    return String(args);
  }
}

function getContentParts(raw) {
  if (Array.isArray(raw?.content)) {
    return raw.content;
  }
  return [];
}

function normalizeEchoContentPart(part) {
  if (typeof part === 'string') {
    return { type: 'text', text: part };
  }

  const data = part?.data;
  const imageUrl = part?.image_url;
  const url =
    part?.url ??
    (typeof imageUrl === 'string' ? imageUrl : imageUrl?.url) ??
    part?.video_url ??
    part?.file_url ??
    part?.file_id ??
    (typeof data === 'string' ? data : undefined);

  return {
    type: typeof part?.type === 'string' ? part.type : 'text',
    text: typeof part?.text === 'string' ? part.text : undefined,
    thinking: typeof part?.thinking === 'string' ? part.thinking : undefined,
    data,
    url,
    image_url: imageUrl,
    video_url: part?.video_url,
    file_url: part?.file_url,
    file_id: part?.file_id,
    filename: part?.filename ?? part?.file_name ?? part?.name,
    file_name: part?.file_name,
    mime_type: part?.mime_type ?? part?.mimeType,
    content_type: part?.content_type ?? part?.contentType,
    size: typeof part?.size === 'number' ? part.size : undefined,
    thumbnail_url: part?.thumbnail_url ?? part?.thumbnailUrl,
    alt: part?.alt,
    title: part?.title,
    format: part?.format,
  };
}

function normalizeEchoContent(raw) {
  if (Array.isArray(raw?.content)) {
    return raw.content.map(normalizeEchoContentPart);
  }
  if (typeof raw?.content === 'string') {
    return [{ type: 'text', text: raw.content }];
  }
  if (asObject(raw?.content)) {
    return [{ type: 'text', data: raw.content }];
  }
  if (typeof raw?.text === 'string') {
    return [{ type: 'text', text: raw.text }];
  }
  if (typeof raw?.thinking === 'string') {
    return [{ type: 'thinking', thinking: raw.thinking }];
  }
  return [];
}

function normalizeEchoMessage(raw) {
  return {
    ...(typeof raw?.id === 'string' ? { id: raw.id } : {}),
    role: typeof raw?.role === 'string' ? raw.role : 'assistant',
    type: typeof raw?.type === 'string' ? raw.type : '',
    content: normalizeEchoContent(raw),
    metadata: asObject(raw?.metadata) ?? undefined,
    call_id: raw?.call_id,
    tool_call_id: raw?.tool_call_id,
    name: raw?.name ?? raw?.tool_name,
    arguments: raw?.arguments,
    args: raw?.args,
    input: raw?.input,
    output: raw?.output,
    result: raw?.result,
  };
}

function getDataObject(part) {
  const direct = asObject(part?.data);
  if (direct) {
    return direct;
  }
  return parseJsonObject(part?.data);
}

function extractPlainTextFromMsg(msg) {
  return getContentParts(msg)
    .map((part) => part?.text ?? part?.thinking ?? '')
    .join('');
}

function isTextLikeAssistantMessage(msg) {
  return msg.role !== 'user' && !NON_TEXT_ASSISTANT_TYPES.has(lower(msg.type));
}

function insertAssistantMessage(acc, msg) {
  if (!isTextLikeAssistantMessage(msg)) {
    return [...acc, msg];
  }
  const hasAssistantText = acc.some(isTextLikeAssistantMessage);
  if (!hasAssistantText) {
    return [msg, ...acc];
  }
  return [...acc, msg];
}

function normalizeAssistantMessageOrder(messages) {
  if (messages.length < 2) {
    return messages;
  }
  const firstTextIdx = messages.findIndex(isTextLikeAssistantMessage);
  if (firstTextIdx <= 0) {
    return messages;
  }
  const firstText = messages[firstTextIdx];
  return [firstText, ...messages.slice(0, firstTextIdx), ...messages.slice(firstTextIdx + 1)];
}

function upsertMessageById(acc, msg) {
  const messageId = msg.id;
  if (!messageId) {
    return normalizeAssistantMessageOrder(insertAssistantMessage(acc, msg));
  }

  const idx = acc.findIndex((item) => item.id === messageId);
  if (idx < 0) {
    return normalizeAssistantMessageOrder(insertAssistantMessage(acc, msg));
  }

  const existing = acc[idx];
  const keepText = extractPlainTextFromMsg(existing);
  const incomingText = extractPlainTextFromMsg(msg);
  const next = acc.slice();
  if (incomingText.length >= keepText.length) {
    next[idx] = msg;
  } else {
    next[idx] = { ...msg, content: [{ type: 'text', text: keepText }] };
  }
  return normalizeAssistantMessageOrder(next);
}

function mergeStreamAccumulated(acc, event) {
  if (event?.object === 'response') {
    const output = Array.isArray(event.output) ? event.output : null;
    if (output?.length) {
      return normalizeAssistantMessageOrder(output.map(normalizeEchoMessage));
    }
    return null;
  }

  if (event?.object === 'message' && typeof event.type === 'string') {
    const type = lower(event.type);
    if (!STREAM_ACCUMULATED_MESSAGE_TYPES.has(type)) {
      return null;
    }
    return upsertMessageById(acc, normalizeEchoMessage(event));
  }

  return null;
}

function appendTextDeltaToAcc(acc, msgId, delta) {
  const idx = acc.findIndex((msg) => msg.id === msgId);
  if (idx < 0) {
    return normalizeAssistantMessageOrder(
      insertAssistantMessage(acc, {
        id: msgId,
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: delta }],
      }),
    );
  }

  const next = acc.slice();
  const current = next[idx];
  const merged = extractPlainTextFromMsg(current) + delta;
  next[idx] = { ...current, content: [{ type: 'text', text: merged }] };
  return normalizeAssistantMessageOrder(next);
}

function extractStreamTextChunk(event) {
  if (event?.object === 'content' && event.type === 'text') {
    const text =
      typeof event.text === 'string'
        ? event.text
        : typeof event.delta === 'string'
          ? event.delta
          : typeof event.content === 'string'
            ? event.content
            : '';
    const msgId = typeof event.msg_id === 'string' ? event.msg_id : undefined;
    return text ? { text, msgId } : {};
  }

  if (typeof event?.text === 'string' && event.text.length > 0) {
    return { text: event.text };
  }

  return {};
}

function appendTextPart(parts, text, extra = {}) {
  if (!text) {
    return;
  }
  const previous = parts[parts.length - 1];
  if (
    previous?.type === ContentTypes.TEXT &&
    previous.tool_call_ids == null &&
    Object.keys(extra).length === 0
  ) {
    previous[ContentTypes.TEXT] += text;
    return;
  }

  parts.push({
    type: ContentTypes.TEXT,
    [ContentTypes.TEXT]: text,
    ...extra,
  });
}

function appendThinkingPart(parts, text) {
  if (!text) {
    return;
  }
  const previous = parts[parts.length - 1];
  if (previous?.type === ContentTypes.THINK) {
    previous[ContentTypes.THINK] = [previous[ContentTypes.THINK], text]
      .filter(Boolean)
      .join('\n\n');
    return;
  }
  parts.push({
    type: ContentTypes.THINK,
    [ContentTypes.THINK]: text,
  });
}

function collectDataObjects(msg) {
  return getContentParts(msg)
    .map(getDataObject)
    .filter(Boolean);
}

function extractToolCall(msg, index) {
  const data = collectDataObjects(msg)[0] ?? {};
  const metadataName = msg.metadata?.original_name;
  const fallbackId = `${lower(msg.type) || 'tool'}_${index}`;
  const id = data.call_id ?? data.id ?? msg.call_id ?? msg.id ?? fallbackId;
  const name = data.name ?? data.tool_name ?? msg.name ?? metadataName ?? DEFAULT_TOOL_NAME;
  const args =
    data.arguments ?? data.args ?? data.input ?? msg.arguments ?? msg.args ?? msg.input ?? '';

  return {
    id: String(id),
    name: String(name || DEFAULT_TOOL_NAME),
    args: normalizeToolArgs(args),
    type: ToolCallTypes.TOOL_CALL,
    progress: 0.1,
  };
}

function extractToolResult(msg, index) {
  const dataObjects = collectDataObjects(msg);
  const data = dataObjects.find((item) => item.output != null) ?? dataObjects[0] ?? {};
  const metadataName = msg.metadata?.original_name;
  const textOutput = extractPlainTextFromMsg(msg).trim();
  const dataStringOutput = getContentParts(msg).find(
    (part) => typeof part?.data === 'string',
  )?.data;
  const dataOutput = data.output ?? data.result ?? data.content ?? msg.output ?? msg.result;
  const id = data.call_id ?? data.id ?? msg.call_id ?? msg.tool_call_id ?? msg.id;
  const name = data.name ?? data.tool_name ?? msg.name ?? metadataName ?? DEFAULT_TOOL_NAME;
  const output = dataOutput != null ? dataOutput : textOutput || dataStringOutput || '';

  return {
    id: id != null ? String(id) : `${lower(msg.type) || 'tool_result'}_${index}`,
    name: String(name || DEFAULT_TOOL_NAME),
    output: normalizeToolOutputToString(output),
  };
}

function makeToolAnchor(toolCall) {
  return {
    type: ContentTypes.TEXT,
    [ContentTypes.TEXT]: '',
    tool_call_ids: [toolCall.id],
  };
}

function makeToolPart(toolCall) {
  return {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: toolCall,
  };
}

function appendToolCall(parts, toolCall, pending) {
  parts.push(makeToolAnchor(toolCall));
  parts.push(makeToolPart(toolCall));

  const toolPartIndex = parts.length - 1;
  pending.byId.set(toolCall.id, toolPartIndex);
  if (!pending.byName.has(toolCall.name)) {
    pending.byName.set(toolCall.name, []);
  }
  pending.byName.get(toolCall.name).push(toolPartIndex);
  pending.order.push(toolPartIndex);
}

function takePendingToolIndex(result, pending) {
  if (result.id && pending.byId.has(result.id)) {
    const index = pending.byId.get(result.id);
    pending.byId.delete(result.id);
    const toolCall = pending.parts[index]?.[ContentTypes.TOOL_CALL];
    if (toolCall && toolCall.progress !== 1) {
      return index;
    }
  }

  const sameNameIndexes = pending.byName.get(result.name);
  if (sameNameIndexes?.length) {
    while (sameNameIndexes.length) {
      const index = sameNameIndexes.shift();
      const toolCall = pending.parts[index]?.[ContentTypes.TOOL_CALL];
      if (toolCall && toolCall.progress !== 1) {
        return index;
      }
    }
  }

  while (pending.order.length) {
    const index = pending.order.pop();
    const toolCall = pending.parts[index]?.[ContentTypes.TOOL_CALL];
    if (toolCall && toolCall.progress !== 1) {
      return index;
    }
  }

  return null;
}

function completeToolCall(parts, result, pending) {
  const index = takePendingToolIndex(result, { ...pending, parts });
  if (index == null) {
    const toolCall = {
      id: result.id,
      name: result.name,
      args: '',
      output: result.output,
      type: ToolCallTypes.TOOL_CALL,
      progress: 1,
    };
    parts.push(makeToolAnchor(toolCall));
    parts.push(makeToolPart(toolCall));
    return;
  }

  const existing = parts[index]?.[ContentTypes.TOOL_CALL] ?? {};
  parts[index] = makeToolPart({
    ...existing,
    id: existing.id ?? result.id,
    name: existing.name ?? result.name,
    output: result.output,
    type: ToolCallTypes.TOOL_CALL,
    progress: 1,
  });
}

function buildContentPartsFromEchoMessages(rawMessages) {
  const messages = normalizeAssistantMessageOrder(rawMessages.map(normalizeEchoMessage));
  const parts = [];
  const pending = {
    byId: new Map(),
    byName: new Map(),
    order: [],
  };

  messages.forEach((msg, index) => {
    if (msg.role === 'user') {
      return;
    }

    const type = lower(msg.type);
    if (THINKING_TYPES.has(type)) {
      appendThinkingPart(parts, extractPlainTextFromMsg(msg).trim());
      return;
    }

    if (TOOL_CALL_TYPES.has(type)) {
      appendToolCall(parts, extractToolCall(msg, index), pending);
      return;
    }

    if (TOOL_RESULT_TYPES.has(type)) {
      completeToolCall(parts, extractToolResult(msg, index), pending);
      return;
    }

    appendTextPart(parts, extractPlainTextFromMsg(msg));
  });

  return parts;
}

function parseSSELine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) {
    return null;
  }

  const data = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed;
  if (!data || data === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch (_error) {
    return null;
  }
}

class EchoCoPawContentAccumulator {
  constructor(messages = []) {
    this.messages = normalizeAssistantMessageOrder(messages.map(normalizeEchoMessage));
  }

  appendEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    let changed = false;
    const merged = mergeStreamAccumulated(this.messages, event);
    if (merged) {
      this.messages = merged;
      changed = true;
    }

    const { text, msgId } = extractStreamTextChunk(event);
    if (text) {
      this.messages = appendTextDeltaToAcc(this.messages, msgId ?? LEGACY_TEXT_MESSAGE_ID, text);
      changed = true;
    }

    return changed ? this.getSnapshot() : null;
  }

  appendSSELine(line) {
    return this.appendEvent(parseSSELine(line));
  }

  getMessages() {
    return this.messages.map((message) => ({ ...message, content: [...getContentParts(message)] }));
  }

  getContentParts() {
    return buildContentPartsFromEchoMessages(this.messages);
  }

  getSnapshot() {
    return {
      messages: this.getMessages(),
      content: this.getContentParts(),
    };
  }
}

module.exports = {
  EchoCoPawContentAccumulator,
  appendTextDeltaToAcc,
  buildContentPartsFromEchoMessages,
  extractStreamTextChunk,
  mergeStreamAccumulated,
  normalizeEchoMessage,
  normalizeToolOutputToString,
  parseSSELine,
};
