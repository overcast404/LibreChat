const { ContentTypes } = require('librechat-data-provider');

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockGenerationJobManager = {
  createJob: jest.fn(),
  updateMetadata: jest.fn(),
  setContentParts: jest.fn(),
  emitChunk: jest.fn(),
  emitDone: jest.fn(),
  emitError: jest.fn(),
  completeJob: jest.fn(),
};

const mockCheckAndIncrementPendingRequest = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockIsUnpersistedPreliminaryParent = jest.fn();
const mockSaveMessage = jest.fn();
const mockSaveConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockIterEchoCoPawEvents = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: mockGenerationJobManager,
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  getViolationInfo: jest.fn(),
  isUnpersistedPreliminaryParent: (...args) => mockIsUnpersistedPreliminaryParent(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  sanitizeTitle: jest.fn((title) => title),
  validateEndpointURL: jest.fn(),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));

jest.mock('~/server/services/EchoCoPaw', () => ({
  ECHO_COPAW_METADATA_KEY: 'echo_copaw',
  EchoCoPawContentAccumulator: class MockEchoCoPawContentAccumulator {
    appendEvent(event) {
      if (event?.kind !== 'partial') {
        return null;
      }
      const content = [{ type: 'text', text: event.text }];
      return { content, liveContent: content };
    }
  },
  buildEchoCoPawPayload: jest.fn((payload) => payload),
  iterEchoCoPawEvents: (...args) => mockIterEchoCoPawEvents(...args),
  resolveEchoCoPawBaseURL: jest.fn(() => 'http://echo-copaw.test'),
}));

const { EchoCoPawController } = require('../echoCoPaw');

describe('EchoCoPawController partial error persistence', () => {
  let generationCompleted;
  let resolveGenerationCompleted;

  beforeEach(() => {
    jest.clearAllMocks();
    generationCompleted = new Promise((resolve) => {
      resolveGenerationCompleted = resolve;
    });

    mockIsUnpersistedPreliminaryParent.mockResolvedValue(false);
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGenerationJobManager.createJob.mockResolvedValue({
      abortController: new AbortController(),
    });
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockImplementation(async () => {
      resolveGenerationCompleted();
    });
    mockSaveMessage.mockResolvedValue(undefined);
    mockSaveConvo.mockResolvedValue({ conversationId: 'conversation-1', title: 'Question' });
    mockIterEchoCoPawEvents.mockImplementation(async function* () {
      yield { kind: 'partial', text: 'Already streamed' };
      yield { error: 'Model timed out after 60s' };
    });
  });

  it('persists and finalizes partial output with an appended error part', async () => {
    const req = {
      user: { id: 'user-1', email: 'user@example.com' },
      config: { endpoints: { allowedAddresses: ['echo-copaw.test'] } },
      body: {
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
        messageId: 'user-message-1',
        text: 'Question',
        endpointOption: {
          endpoint: 'qwenpaw',
          endpointType: 'custom',
          model_parameters: { model: 'qwenpaw-default' },
        },
      },
    };
    const res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await EchoCoPawController(req, res);
    await generationCompleted;

    expect(res.json).toHaveBeenCalledWith({
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      status: 'started',
    });
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('conversation-1');

    const responseMessage = mockSaveMessage.mock.calls[1][1];
    expect(responseMessage).toMatchObject({
      messageId: 'user-message-1_',
      conversationId: 'conversation-1',
      parentMessageId: 'user-message-1',
      text: 'Already streamed',
      unfinished: true,
      error: false,
    });
    expect(responseMessage.content).toEqual([
      { type: ContentTypes.TEXT, text: 'Already streamed' },
      { type: ContentTypes.ERROR, error: 'Model timed out after 60s' },
    ]);
    expect(mockGenerationJobManager.emitDone).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        final: true,
        responseMessage,
      }),
    );
    expect(mockGenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        type: ContentTypes.ERROR,
        error: 'Model timed out after 60s',
      }),
    );
  });
});
