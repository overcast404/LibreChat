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
const ECHO_COPAW_METADATA_KEY = 'echo_copaw';
const ECHO_COPAW_SOURCE = 'echo-copaw';
const MIN_EXACT_REPEAT_LENGTH = 16;
const ECHO_HIDDEN_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

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

function collapseExactTextRepeats(value) {
  if (typeof value !== 'string' || value.length < MIN_EXACT_REPEAT_LENGTH * 2) {
    return value;
  }

  const comparable = value.replace(ECHO_HIDDEN_COMMENT_PATTERN, '').trim();
  if (comparable.length < MIN_EXACT_REPEAT_LENGTH * 2) {
    return value;
  }

  const anchor = comparable.slice(0, MIN_EXACT_REPEAT_LENGTH);
  let repeatStart = comparable.indexOf(anchor, MIN_EXACT_REPEAT_LENGTH);

  while (repeatStart >= MIN_EXACT_REPEAT_LENGTH) {
    const firstCopy = comparable.slice(0, repeatStart).trimEnd();
    let cursor = repeatStart;
    let repeatCount = 1;

    while (cursor < comparable.length) {
      while (/\s/.test(comparable[cursor] ?? '')) {
        cursor += 1;
      }
      if (!comparable.startsWith(firstCopy, cursor)) {
        break;
      }
      repeatCount += 1;
      cursor += firstCopy.length;
    }

    if (repeatCount > 1 && comparable.slice(cursor).trim().length === 0) {
      return firstCopy;
    }

    repeatStart = comparable.indexOf(anchor, repeatStart + 1);
  }

  return value;
}

function normalizeToolOutputToString(output) {
  if (output == null) {
    return '';
  }
  if (typeof output === 'string') {
    return collapseExactTextRepeats(output);
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
    return collapseExactTextRepeats(args);
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
    return { type: 'text', text: collapseExactTextRepeats(part) };
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
    text: typeof part?.text === 'string' ? collapseExactTextRepeats(part.text) : undefined,
    thinking:
      typeof part?.thinking === 'string' ? collapseExactTextRepeats(part.thinking) : undefined,
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

function collapseRepeatedTextContent(parts) {
  if (!parts.length || parts.some((part) => part.text == null && part.thinking == null)) {
    return parts;
  }

  const text = parts.map((part) => part.text ?? part.thinking ?? '').join('');
  const collapsed = collapseExactTextRepeats(text);
  if (collapsed === text) {
    return parts;
  }

  const first = parts[0];
  return [
    first.thinking != null ? { ...first, thinking: collapsed } : { ...first, text: collapsed },
  ];
}

function normalizeEchoContent(raw) {
  if (Array.isArray(raw?.content)) {
    return collapseRepeatedTextContent(raw.content.map(normalizeEchoContentPart));
  }
  if (typeof raw?.content === 'string') {
    return [{ type: 'text', text: collapseExactTextRepeats(raw.content) }];
  }
  if (asObject(raw?.content)) {
    return [{ type: 'text', data: raw.content }];
  }
  if (typeof raw?.text === 'string') {
    return [{ type: 'text', text: collapseExactTextRepeats(raw.text) }];
  }
  if (typeof raw?.thinking === 'string') {
    return [{ type: 'thinking', thinking: collapseExactTextRepeats(raw.thinking) }];
  }
  return [];
}

function normalizeEchoMessage(raw) {
  return {
    ...(typeof raw?.id === 'string' ? { id: raw.id } : {}),
    role: typeof raw?.role === 'string' ? raw.role : 'assistant',
    type: typeof raw?.type === 'string' ? raw.type : '',
    ...(typeof raw?.status === 'string' ? { status: raw.status } : {}),
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

function makeEchoMetadata({ phase, kind, label, sourceId, sequence }) {
  return {
    source: ECHO_COPAW_SOURCE,
    phase,
    kind,
    ...(label ? { label } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(Number.isInteger(sequence) ? { sequence } : {}),
  };
}

function getLastTextLikeAssistantMessageIndex(messages) {
  let lastIndex = -1;
  messages.forEach((msg, index) => {
    if (!isTextLikeAssistantMessage(msg)) {
      return;
    }
    if (!extractPlainTextFromMsg(msg).trim()) {
      return;
    }
    lastIndex = index;
  });
  return lastIndex;
}

function insertAssistantMessage(acc, msg) {
  return [...acc, msg];
}

function normalizeAssistantMessageOrder(messages) {
  return messages;
}

function upsertMessageById(acc, msg, preserveExistingContent = false) {
  const messageId = msg.id;
  if (!messageId) {
    return normalizeAssistantMessageOrder(insertAssistantMessage(acc, msg));
  }

  const idx = acc.findIndex((item) => item.id === messageId);
  if (idx < 0) {
    return normalizeAssistantMessageOrder(insertAssistantMessage(acc, msg));
  }

  const existing = acc[idx];
  const existingContent = getContentParts(existing);
  const keepText = extractPlainTextFromMsg(existing);
  const incomingText = extractPlainTextFromMsg(msg);
  const next = acc.slice();
  if (preserveExistingContent && existingContent.length > 0) {
    next[idx] = { ...msg, content: existingContent };
  } else if (incomingText.length >= keepText.length) {
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
      const existingById = new Map(acc.filter((msg) => msg.id).map((msg) => [msg.id, msg]));
      return normalizeAssistantMessageOrder(
        output.map((rawMessage) => {
          const incoming = normalizeEchoMessage(rawMessage);
          const existing = incoming.id ? existingById.get(incoming.id) : null;
          const existingContent = getContentParts(existing);
          return existingContent.length > 0 ? { ...incoming, content: existingContent } : incoming;
        }),
      );
    }
    return null;
  }

  if (event?.object === 'message' && typeof event.type === 'string') {
    const type = lower(event.type);
    if (!STREAM_ACCUMULATED_MESSAGE_TYPES.has(type)) {
      return null;
    }
    return upsertMessageById(acc, normalizeEchoMessage(event), event.status === 'completed');
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
  const merged = collapseExactTextRepeats(extractPlainTextFromMsg(current) + delta);
  next[idx] = { ...current, content: [{ type: 'text', text: merged }] };
  return normalizeAssistantMessageOrder(next);
}

function replaceTextInAcc(acc, msgId, text) {
  const idx = acc.findIndex((msg) => msg.id === msgId);
  if (idx < 0) {
    return normalizeAssistantMessageOrder(
      insertAssistantMessage(acc, {
        id: msgId,
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text }],
      }),
    );
  }

  const next = acc.slice();
  const current = next[idx];
  next[idx] = { ...current, content: [{ type: 'text', text }] };
  return normalizeAssistantMessageOrder(next);
}

function extractStreamTextChunk(event) {
  if (event?.object === 'content' && event.type === 'text') {
    let text = '';
    if (typeof event.text === 'string') {
      text = event.text;
    } else if (typeof event.delta === 'string') {
      text = event.delta;
    } else if (typeof event.content === 'string') {
      text = event.content;
    }
    const msgId = typeof event.msg_id === 'string' ? event.msg_id : undefined;
    const mode = event.delta === false || event.status === 'completed' ? 'replace' : 'append';
    return text ? { text: collapseExactTextRepeats(text), msgId, mode } : {};
  }

  if (typeof event?.text === 'string' && event.text.length > 0) {
    return { text: collapseExactTextRepeats(event.text), mode: 'append' };
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

function appendThinkingPart(parts, text, extra = {}) {
  if (!text) {
    return;
  }
  const previous = parts[parts.length - 1];
  if (previous?.type === ContentTypes.THINK && Object.keys(extra).length === 0) {
    previous[ContentTypes.THINK] = [previous[ContentTypes.THINK], text]
      .filter(Boolean)
      .join('\n\n');
    return;
  }
  parts.push({
    type: ContentTypes.THINK,
    [ContentTypes.THINK]: text,
    ...extra,
  });
}

function collectDataObjects(msg) {
  return getContentParts(msg).map(getDataObject).filter(Boolean);
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

function makeToolAnchor(toolCall, extra = {}) {
  return {
    type: ContentTypes.TEXT,
    [ContentTypes.TEXT]: '',
    tool_call_ids: [toolCall.id],
    ...extra,
  };
}

function makeToolPart(toolCall, extra = {}) {
  return {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: toolCall,
    ...extra,
  };
}

function appendToolCall(parts, toolCall, pending, extra = {}) {
  parts.push(makeToolAnchor(toolCall, extra));
  parts.push(makeToolPart(toolCall, extra));

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

function completeToolCall(parts, result, pending, extra = {}) {
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
    parts.push(makeToolAnchor(toolCall, extra));
    parts.push(makeToolPart(toolCall, extra));
    return;
  }

  const existingPart = parts[index] ?? {};
  const existing = parts[index]?.[ContentTypes.TOOL_CALL] ?? {};
  const existingEchoMetadata = existingPart[ECHO_COPAW_METADATA_KEY];
  parts[index] = makeToolPart(
    {
      ...existing,
      id: existing.id ?? result.id,
      name: existing.name ?? result.name,
      output: result.output,
      type: ToolCallTypes.TOOL_CALL,
      progress: 1,
    },
    existingEchoMetadata ? { [ECHO_COPAW_METADATA_KEY]: existingEchoMetadata } : extra,
  );
}

function buildContentPartsFromEchoMessages(rawMessages) {
  const messages = normalizeAssistantMessageOrder(rawMessages.map(normalizeEchoMessage));
  const answerMessageIndex = getLastTextLikeAssistantMessageIndex(messages);
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
      appendThinkingPart(parts, extractPlainTextFromMsg(msg).trim(), {
        [ECHO_COPAW_METADATA_KEY]: makeEchoMetadata({
          phase: 'process',
          kind: 'reasoning',
          label: '推理过程',
          sourceId: msg.id,
          sequence: index,
        }),
      });
      return;
    }

    if (TOOL_CALL_TYPES.has(type)) {
      const toolCall = extractToolCall(msg, index);
      appendToolCall(parts, toolCall, pending, {
        [ECHO_COPAW_METADATA_KEY]: makeEchoMetadata({
          phase: 'process',
          kind: 'tool_call',
          label: toolCall.name,
          sourceId: msg.id,
          sequence: index,
        }),
      });
      return;
    }

    if (TOOL_RESULT_TYPES.has(type)) {
      const result = extractToolResult(msg, index);
      completeToolCall(parts, result, pending, {
        [ECHO_COPAW_METADATA_KEY]: makeEchoMetadata({
          phase: 'process',
          kind: 'tool_call',
          label: result.name,
          sourceId: msg.id,
          sequence: index,
        }),
      });
      return;
    }

    const text = extractPlainTextFromMsg(msg);
    const phase = index === answerMessageIndex ? 'answer' : 'narrative';
    appendTextPart(parts, text, {
      [ECHO_COPAW_METADATA_KEY]: makeEchoMetadata({
        phase,
        kind: 'message',
        label: phase === 'answer' ? '最终回答' : undefined,
        sourceId: msg.id,
        sequence: index,
      }),
    });
  });

  return parts;
}

function buildLiveContentPartsFromEchoMessages(rawMessages) {
  return buildContentPartsFromEchoMessages(rawMessages);
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

    const { text, msgId, mode } = extractStreamTextChunk(event);
    if (text) {
      this.messages =
        mode === 'replace'
          ? replaceTextInAcc(this.messages, msgId ?? LEGACY_TEXT_MESSAGE_ID, text)
          : appendTextDeltaToAcc(this.messages, msgId ?? LEGACY_TEXT_MESSAGE_ID, text);
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

  getLiveContentParts() {
    return buildLiveContentPartsFromEchoMessages(this.messages);
  }

  getSnapshot() {
    return {
      messages: this.getMessages(),
      content: this.getContentParts(),
      liveContent: this.getLiveContentParts(),
    };
  }
}

module.exports = {
  EchoCoPawContentAccumulator,
  ECHO_COPAW_METADATA_KEY,
  appendTextDeltaToAcc,
  buildContentPartsFromEchoMessages,
  buildLiveContentPartsFromEchoMessages,
  extractStreamTextChunk,
  mergeStreamAccumulated,
  normalizeEchoMessage,
  normalizeToolOutputToString,
  parseSSELine,
};
