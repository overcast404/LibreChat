const { logger } = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  checkAndIncrementPendingRequest,
  decrementPendingRequest,
  getViolationInfo,
  isUnpersistedPreliminaryParent,
  sanitizeMessageForTransmit,
  sanitizeTitle,
  validateEndpointURL,
} = require('@librechat/api');
const {
  Constants,
  ContentTypes,
  ViolationTypes,
  parseTextParts,
} = require('librechat-data-provider');
const { logViolation } = require('~/cache');
const { saveMessage, saveConvo, getMessages } = require('~/models');
const {
  EchoCoPawContentAccumulator,
  ECHO_COPAW_METADATA_KEY,
  buildEchoCoPawPayload,
  iterEchoCoPawEvents,
  resolveEchoCoPawBaseURL,
} = require('~/server/services/EchoCoPaw');

const DEFAULT_ECHO_ENDPOINTS = ['qwenpaw', 'echocopaw', 'echo-copaw'];

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function getEchoEndpointNames() {
  const configured = process.env.ECHO_COPAW_ENDPOINTS;
  if (!configured) {
    return DEFAULT_ECHO_ENDPOINTS;
  }
  return configured.split(',').map(normalizeName).filter(Boolean);
}

function isEchoCoPawRequest(req) {
  if (process.env.ECHO_COPAW_DIRECT_ENABLED === 'false') {
    return false;
  }

  const endpoint = normalizeName(req.params?.endpoint || req.body?.endpointOption?.endpoint);
  return getEchoEndpointNames().includes(endpoint);
}

function buildUserMessage({ req, conversationId, userMessageId, parentMessageId }) {
  const message = {
    messageId: userMessageId,
    parentMessageId,
    conversationId,
    sender: 'User',
    text: req.body.text ?? '',
    isCreatedByUser: true,
    error: false,
    user: req.user.id,
  };

  if (Array.isArray(req.body.manualSkills) && req.body.manualSkills.length > 0) {
    message.manualSkills = req.body.manualSkills.filter(
      (skill) => typeof skill === 'string' && skill.length > 0,
    );
  }

  if (Array.isArray(req.body.quotes) && req.body.quotes.length > 0) {
    message.quotes = req.body.quotes.filter(
      (quote) => typeof quote === 'string' && quote.length > 0,
    );
  }

  return message;
}

function getResponseMessageId(req, userMessageId) {
  if (typeof req.body.responseMessageId === 'string' && req.body.responseMessageId) {
    return req.body.responseMessageId;
  }
  return `${userMessageId.replace(/_+$/g, '')}_`;
}

function getUserMessageId(req) {
  return (
    req.body.overrideParentMessageId ||
    req.body.overrideUserMessageId ||
    req.body.messageId ||
    crypto.randomUUID()
  );
}

function getConversationTitle(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return 'New Chat';
  }
  return sanitizeTitle(trimmed.slice(0, 60));
}

function buildRequestContext(req) {
  return {
    userId: req?.user?.id,
    isTemporary: req?.body?.isTemporary,
    interfaceConfig: req?.config?.interfaceConfig,
  };
}

function toContentEvent({ part, index, conversationId, messageId }) {
  return {
    ...part,
    index,
    conversationId,
    messageId,
  };
}

function shouldEmitLivePart(part) {
  return !(part?.type === ContentTypes.TEXT && part.tool_call_ids != null && !part.text);
}

function getEchoEventError(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const error = event.error;
  if (error) {
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return JSON.stringify(error);
  }

  if (event.object === 'response' && event.status === 'failed') {
    return 'Echo CoPaw response failed';
  }

  return null;
}

function getEchoContentPhase(part) {
  const metadata = part?.[ECHO_COPAW_METADATA_KEY];
  return metadata?.source === 'echo-copaw' ? metadata.phase : null;
}

function getEchoAnswerContent(contentParts) {
  const nonErrorParts = contentParts.filter((part) => part?.type !== ContentTypes.ERROR);
  const hasEchoAnswer = nonErrorParts.some((part) => getEchoContentPhase(part) === 'answer');
  if (!hasEchoAnswer) {
    return nonErrorParts;
  }
  return nonErrorParts.filter((part) => getEchoContentPhase(part) === 'answer');
}

function getGenerationErrorMessage(error) {
  if (typeof error?.message === 'string' && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  return 'Echo CoPaw request failed';
}

async function emitContentSnapshot({
  streamId,
  conversationId,
  messageId,
  contentParts,
  emittedParts,
}) {
  for (let index = 0; index < contentParts.length; index++) {
    const part = contentParts[index];
    if (!part || !shouldEmitLivePart(part)) {
      continue;
    }

    const serialized = JSON.stringify(part);
    if (emittedParts.get(index) === serialized) {
      continue;
    }
    emittedParts.set(index, serialized);

    await GenerationJobManager.emitChunk(
      streamId,
      toContentEvent({ part, index, conversationId, messageId }),
    );
  }
}

async function persistEchoMessages({
  req,
  conversationId,
  endpointOption,
  userMessage,
  responseMessage,
  isNewConvo,
}) {
  const reqCtx = buildRequestContext(req);
  await saveMessage(reqCtx, userMessage, {
    context: 'api/server/controllers/agents/echoCoPaw.js - user message',
  });
  await saveMessage(reqCtx, responseMessage, {
    context: 'api/server/controllers/agents/echoCoPaw.js - response message',
  });

  const conversationFields = {
    conversationId,
    endpoint: endpointOption.endpoint,
    endpointType: endpointOption.endpointType,
    model: endpointOption.model_parameters?.model,
    spec: endpointOption.spec,
    iconURL: endpointOption.iconURL,
    chatProjectId: endpointOption.chatProjectId,
    ...(isNewConvo ? { title: getConversationTitle(userMessage.text) } : {}),
  };

  const conversation = await saveConvo(reqCtx, conversationFields, {
    context: 'api/server/controllers/agents/echoCoPaw.js - saveConvo',
  });
  return conversation;
}

async function runEchoCoPawGeneration({
  req,
  streamId,
  job,
  userId,
  conversationId,
  endpointOption,
  userMessage,
  responseMessageId,
  isNewConvo,
}) {
  const contentParts = [];
  const emittedParts = new Map();
  const accumulator = new EchoCoPawContentAccumulator();
  const model = endpointOption.model_parameters?.model;

  GenerationJobManager.setContentParts(streamId, contentParts);
  await GenerationJobManager.emitChunk(streamId, {
    created: true,
    message: userMessage,
    streamId,
  });

  const baseUrl = resolveEchoCoPawBaseURL();
  await validateEndpointURL(baseUrl, 'Echo CoPaw', req.config?.endpoints?.allowedAddresses);

  const payload = buildEchoCoPawPayload({
    text: req.body.text ?? '',
    conversationId,
    userId: req.user?.email || userId,
  });

  let generationError = null;
  try {
    for await (const event of iterEchoCoPawEvents({
      baseUrl,
      payload,
      signal: job.abortController.signal,
    })) {
      const eventError = getEchoEventError(event);
      if (eventError) {
        throw new Error(eventError);
      }

      const snapshot = accumulator.appendEvent(event);
      if (!snapshot) {
        continue;
      }

      contentParts.splice(0, contentParts.length, ...snapshot.content);
      await emitContentSnapshot({
        streamId,
        conversationId,
        messageId: responseMessageId,
        contentParts: snapshot.liveContent ?? snapshot.content,
        emittedParts,
      });
    }
  } catch (error) {
    if (job.abortController.signal.aborted) {
      throw error;
    }

    generationError = getGenerationErrorMessage(error);
    logger.warn(
      `[EchoCoPawController] Generation ended after partial output for ${streamId}: ${generationError}`,
    );
    contentParts.push({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]: generationError,
    });
    await emitContentSnapshot({
      streamId,
      conversationId,
      messageId: responseMessageId,
      contentParts,
      emittedParts,
    });
  }

  const finalContent = contentParts.filter(Boolean);
  const answerContent = getEchoAnswerContent(finalContent);
  const responseMessage = {
    messageId: responseMessageId,
    conversationId,
    parentMessageId: userMessage.messageId,
    sender: 'AI',
    endpoint: endpointOption.endpoint,
    model,
    iconURL: endpointOption.iconURL,
    text: parseTextParts(answerContent, true),
    content: finalContent,
    unfinished: generationError != null,
    error: false,
    isCreatedByUser: false,
    user: userId,
  };

  const conversation = await persistEchoMessages({
    req,
    conversationId,
    endpointOption,
    userMessage,
    responseMessage,
    isNewConvo,
  });
  const normalizedConversation = { ...conversation };
  normalizedConversation.title =
    normalizedConversation && !normalizedConversation.title
      ? null
      : normalizedConversation?.title || 'New Chat';

  await GenerationJobManager.emitDone(streamId, {
    final: true,
    conversation: normalizedConversation,
    title: normalizedConversation.title,
    requestMessage: sanitizeMessageForTransmit(userMessage),
    responseMessage,
  });
  await GenerationJobManager.completeJob(streamId);
}

async function EchoCoPawController(req, res) {
  const { endpointOption, conversationId: reqConversationId, parentMessageId = null } = req.body;
  const userId = req.user.id;
  let pendingIncremented = false;
  let streamId;

  if (
    await isUnpersistedPreliminaryParent({
      userId,
      conversationId: reqConversationId,
      parentMessageId,
      getMessages,
    })
  ) {
    return res.status(409).json({
      error:
        'Cannot submit a follow-up while the selected parent response is still being saved. ' +
        'Please wait and try again.',
    });
  }

  const { allowed, pendingRequests, limit } = await checkAndIncrementPendingRequest(userId);
  if (!allowed) {
    const violationInfo = getViolationInfo(pendingRequests, limit);
    await logViolation(req, res, ViolationTypes.CONCURRENT, violationInfo, violationInfo.score);
    return res.status(429).json(violationInfo);
  }
  pendingIncremented = true;

  const isNewConvo =
    !reqConversationId || reqConversationId === 'new' || reqConversationId === Constants.NEW_CONVO;
  const conversationId = isNewConvo ? crypto.randomUUID() : reqConversationId;
  streamId = conversationId;
  req.body.conversationId = conversationId;

  const userMessageId = getUserMessageId(req);
  const responseMessageId = getResponseMessageId(req, userMessageId);
  const userMessage = buildUserMessage({
    req,
    conversationId,
    userMessageId,
    parentMessageId: parentMessageId ?? Constants.NO_PARENT,
  });

  try {
    const job = await GenerationJobManager.createJob(streamId, userId, conversationId);
    await GenerationJobManager.updateMetadata(streamId, {
      conversationId,
      endpoint: endpointOption.endpoint,
      iconURL: endpointOption.iconURL,
      model: endpointOption.model_parameters?.model,
      responseMessageId,
      userMessage: {
        messageId: userMessage.messageId,
        parentMessageId: userMessage.parentMessageId,
        conversationId,
        text: userMessage.text,
        quotes: userMessage.quotes,
      },
      sender: 'AI',
    });

    res.json({ streamId, conversationId, status: 'started' });

    runEchoCoPawGeneration({
      req,
      streamId,
      job,
      userId,
      conversationId,
      endpointOption,
      userMessage,
      responseMessageId,
      isNewConvo,
    })
      .catch(async (error) => {
        if (job.abortController.signal.aborted) {
          logger.debug(`[EchoCoPawController] Generation aborted for ${streamId}`);
          return;
        }
        logger.error(`[EchoCoPawController] Generation error for ${streamId}:`, error);
        await GenerationJobManager.emitError(
          streamId,
          error.message || 'Echo CoPaw request failed',
        );
        await GenerationJobManager.completeJob(streamId, error.message);
      })
      .finally(async () => {
        await decrementPendingRequest(userId);
      });
  } catch (error) {
    logger.error('[EchoCoPawController] Initialization error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to start Echo CoPaw generation' });
    } else if (streamId) {
      await GenerationJobManager.emitError(
        streamId,
        error.message || 'Failed to start Echo CoPaw generation',
      );
      await GenerationJobManager.completeJob(streamId, error.message);
    }
    if (pendingIncremented) {
      await decrementPendingRequest(userId);
    }
  }
}

module.exports = {
  EchoCoPawController,
  isEchoCoPawRequest,
};
