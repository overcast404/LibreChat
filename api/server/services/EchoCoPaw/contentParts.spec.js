const { ContentTypes, ToolCallTypes } = require('librechat-data-provider');
const { formatAgentMessages } = require('../../../app/clients/prompts/formatMessages');
const {
  EchoCoPawContentAccumulator,
  buildContentPartsFromEchoMessages,
  buildLiveContentPartsFromEchoMessages,
  normalizeToolOutputToString,
  parseSSELine,
} = require('./contentParts');

function visibleParts(parts) {
  return parts.filter(
    (part) => !(part.type === ContentTypes.TEXT && part.tool_call_ids != null && !part.text),
  );
}

function toolCallPart(part) {
  return part[ContentTypes.TOOL_CALL];
}

function echoMeta(part) {
  return part.echo_copaw;
}

describe('EchoCoPaw content part adapter', () => {
  it('preserves narrative order and merges a tool call with its result', () => {
    const chartOutput = {
      chart: {
        option: { xAxis: { type: 'category' }, series: [{ type: 'bar', data: [1, 2] }] },
        height: 320,
      },
    };

    const content = buildContentPartsFromEchoMessages([
      {
        id: 'msg-1',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '先看数据。' }],
      },
      {
        id: 'call-row-1',
        role: 'assistant',
        type: 'tool_use',
        metadata: { original_name: 'show_chart' },
        content: [
          {
            type: 'text',
            data: { name: 'show_chart', call_id: 'call-1', arguments: '{"title":"demo"}' },
          },
        ],
      },
      {
        id: 'result-row-1',
        role: 'assistant',
        type: 'tool_result',
        metadata: { original_name: 'show_chart' },
        content: [
          {
            type: 'text',
            data: { name: 'show_chart', output: chartOutput },
          },
        ],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '结论在这里。' }],
      },
    ]);

    expect(visibleParts(content).map((part) => part.type)).toEqual([
      ContentTypes.TEXT,
      ContentTypes.TOOL_CALL,
      ContentTypes.TEXT,
    ]);
    expect(content[1]).toMatchObject({
      type: ContentTypes.TEXT,
      text: '',
      tool_call_ids: ['call-1'],
    });

    const toolCall = toolCallPart(content[2]);
    expect(toolCall).toMatchObject({
      id: 'call-1',
      name: 'show_chart',
      args: '{"title":"demo"}',
      output: JSON.stringify(chartOutput),
      progress: 1,
      type: ToolCallTypes.TOOL_CALL,
    });
    expect(echoMeta(content[0])).toMatchObject({
      source: 'echo-copaw',
      phase: 'narrative',
      kind: 'message',
    });
    expect(echoMeta(content[3])).toMatchObject({
      source: 'echo-copaw',
      phase: 'answer',
      kind: 'message',
    });
  });

  it('keeps thinking parts before following tool calls', () => {
    const content = buildContentPartsFromEchoMessages([
      {
        id: 'think-1',
        role: 'assistant',
        type: 'reasoning',
        content: [{ type: 'thinking', thinking: '需要先查询。' }],
      },
      {
        id: 'call-1',
        role: 'assistant',
        type: 'plugin_call',
        metadata: { original_name: 'lookup' },
        content: [{ type: 'text', data: { name: 'lookup', arguments: { q: 'abc' } } }],
      },
    ]);

    expect(content[0]).toMatchObject({
      type: ContentTypes.THINK,
      think: '需要先查询。',
    });
    expect(echoMeta(content[0])).toMatchObject({
      source: 'echo-copaw',
      phase: 'process',
      kind: 'reasoning',
    });
    expect(visibleParts(content).map((part) => part.type)).toEqual([
      ContentTypes.THINK,
      ContentTypes.TOOL_CALL,
    ]);
    expect(toolCallPart(content[2])).toMatchObject({
      id: 'call-1',
      name: 'lookup',
      args: '{"q":"abc"}',
      progress: 0.1,
    });
  });

  it('accepts top-level Echo fields and delta text chunks', () => {
    const content = buildContentPartsFromEchoMessages([
      {
        id: 'think-1',
        role: 'assistant',
        type: 'thinking',
        content: '需要查询。',
      },
      {
        id: 'call-1',
        role: 'assistant',
        type: 'plugin_call',
        name: 'lookup',
        call_id: 'call-1',
        arguments: { q: 'abc' },
      },
      {
        id: 'result-1',
        role: 'assistant',
        type: 'plugin_call_output',
        call_id: 'call-1',
        output: { ok: true },
      },
      {
        id: 'message-1',
        role: 'assistant',
        type: 'message',
        content: '完成。',
      },
    ]);

    expect(content[0]).toMatchObject({
      type: ContentTypes.THINK,
      think: '需要查询。',
    });
    expect(content[3]).toMatchObject({
      type: ContentTypes.TEXT,
      text: '完成。',
    });
    expect(echoMeta(content[3])).toMatchObject({
      source: 'echo-copaw',
      phase: 'answer',
      kind: 'message',
    });
    expect(toolCallPart(content[2])).toMatchObject({
      id: 'call-1',
      name: 'lookup',
      args: '{"q":"abc"}',
      output: '{"ok":true}',
      progress: 1,
    });

    const acc = new EchoCoPawContentAccumulator();
    acc.appendEvent({ object: 'content', type: 'text', msg_id: 'm1', delta: 'he' });
    const snapshot = acc.appendEvent({
      object: 'content',
      type: 'text',
      msg_id: 'm1',
      content: 'llo',
    });
    expect(snapshot.content[0].text).toBe('hello');
    const replaced = acc.appendEvent({
      object: 'content',
      type: 'text',
      status: 'completed',
      msg_id: 'm1',
      text: 'hello',
    });
    expect(replaced.content[0].text).toBe('hello');
  });

  it('accumulates AgentScope msg_id text deltas around tools', () => {
    const acc = new EchoCoPawContentAccumulator();

    acc.appendEvent({
      object: 'message',
      id: 'm1',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text: '' }],
    });
    acc.appendEvent({ object: 'content', type: 'text', msg_id: 'm1', text: 'Before ' });
    acc.appendEvent({ object: 'content', type: 'text', msg_id: 'm1', text: 'tool.' });
    acc.appendEvent({
      object: 'message',
      id: 'tool-1',
      role: 'assistant',
      type: 'function_call',
      content: [{ type: 'text', data: { name: 'search', call_id: 'call-1', arguments: 'q' } }],
    });
    acc.appendEvent({
      object: 'message',
      id: 'tool-result-1',
      role: 'assistant',
      type: 'function_call_output',
      content: [{ type: 'text', data: { name: 'search', call_id: 'call-1', output: 'found' } }],
    });
    acc.appendEvent({
      object: 'message',
      id: 'm2',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text: '' }],
    });
    const snapshot = acc.appendEvent({
      object: 'content',
      type: 'text',
      msg_id: 'm2',
      text: ' After tool.',
    });

    const visible = visibleParts(snapshot.content);
    expect(visible.map((part) => part.type)).toEqual([
      ContentTypes.TEXT,
      ContentTypes.TOOL_CALL,
      ContentTypes.TEXT,
    ]);
    expect(visible[0].text).toBe('Before tool.');
    expect(toolCallPart(visible[1]).output).toBe('found');
    expect(visible[2].text).toBe(' After tool.');
  });

  it('streams full process parts so the frontend can rotate collapsed steps', () => {
    const messages = [
      {
        id: 'think-1',
        role: 'assistant',
        type: 'reasoning',
        content: [{ type: 'text', text: '需要先读取技能。' }],
      },
      {
        id: 'call-1',
        role: 'assistant',
        type: 'plugin_call',
        content: [
          { type: 'text', data: { name: 'read_file', call_id: 'call-1', arguments: '{}' } },
        ],
      },
      {
        id: 'result-1',
        role: 'tool',
        type: 'plugin_call_output',
        content: [{ type: 'text', data: { name: 'read_file', call_id: 'call-1', output: 'ok' } }],
      },
      {
        id: 'answer-1',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '好的，我来执行。' }],
      },
    ];

    const full = visibleParts(buildContentPartsFromEchoMessages(messages));
    expect(full.map((part) => part.type)).toEqual([
      ContentTypes.THINK,
      ContentTypes.TOOL_CALL,
      ContentTypes.TEXT,
    ]);

    const live = visibleParts(buildLiveContentPartsFromEchoMessages(messages));
    expect(live.map((part) => `${part.type}:${echoMeta(part)?.phase}`)).toEqual([
      'think:process',
      'tool_call:process',
      'text:answer',
    ]);
    expect(toolCallPart(live[1])).toMatchObject({
      name: 'read_file',
      output: 'ok',
      progress: 1,
    });
    expect(live[2]).toMatchObject({
      type: ContentTypes.TEXT,
      text: '好的，我来执行。',
      echo_copaw: {
        phase: 'answer',
      },
    });
  });

  it('keeps narrative text visible between live process groups', () => {
    const messages = [
      {
        id: 'think-1',
        role: 'assistant',
        type: 'reasoning',
        content: [{ type: 'text', text: '先判断任务。' }],
      },
      {
        id: 'message-1',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '让我先加载技能。' }],
      },
      {
        id: 'call-1',
        role: 'assistant',
        type: 'plugin_call',
        content: [
          { type: 'text', data: { name: 'read_file', call_id: 'call-1', arguments: '{}' } },
        ],
      },
      {
        id: 'result-1',
        role: 'tool',
        type: 'plugin_call_output',
        content: [{ type: 'text', data: { name: 'read_file', call_id: 'call-1', output: 'ok' } }],
      },
      {
        id: 'message-2',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '好的，先随机找出 cycle。' }],
      },
      {
        id: 'call-2',
        role: 'assistant',
        type: 'plugin_call',
        content: [
          {
            type: 'text',
            data: { name: 'execute_shell_command', call_id: 'call-2', arguments: '{}' },
          },
        ],
      },
      {
        id: 'message-3',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: '2 月已随机选出。' }],
      },
    ];

    const full = visibleParts(buildContentPartsFromEchoMessages(messages));
    expect(full.map((part) => `${part.type}:${echoMeta(part)?.phase}`)).toEqual([
      'think:process',
      'text:narrative',
      'tool_call:process',
      'text:narrative',
      'tool_call:process',
      'text:answer',
    ]);

    const live = visibleParts(buildLiveContentPartsFromEchoMessages(messages));
    expect(live.map((part) => `${part.type}:${echoMeta(part)?.phase}`)).toEqual([
      'think:process',
      'text:narrative',
      'tool_call:process',
      'text:narrative',
      'tool_call:process',
      'text:answer',
    ]);
    expect(live[1].text).toBe('让我先加载技能。');
    expect(toolCallPart(live[2]).name).toBe('read_file');
    expect(live[3].text).toBe('好的，先随机找出 cycle。');
    expect(toolCallPart(live[4]).name).toBe('execute_shell_command');
    expect(live[5].text).toBe('2 月已随机选出。');
  });

  it('replaces accumulated state when a response.output snapshot arrives', () => {
    const acc = new EchoCoPawContentAccumulator();
    acc.appendEvent({ object: 'content', type: 'text', text: 'legacy text' });
    const snapshot = acc.appendEvent({
      object: 'response',
      output: [
        {
          id: 'final',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'final text' }],
        },
      ],
    });

    expect(snapshot.content).toMatchObject([{ type: ContentTypes.TEXT, text: 'final text' }]);
    expect(echoMeta(snapshot.content[0])).toMatchObject({
      source: 'echo-copaw',
      phase: 'answer',
      kind: 'message',
    });
  });

  it('creates LibreChat history-compatible tool anchors', () => {
    const content = buildContentPartsFromEchoMessages([
      {
        id: 'call-1',
        role: 'assistant',
        type: 'tool_use',
        content: [{ type: 'text', data: { name: 'lookup', call_id: 'call-1', arguments: 'abc' } }],
      },
      {
        id: 'result-1',
        role: 'assistant',
        type: 'tool_result',
        content: [{ type: 'text', data: { name: 'lookup', call_id: 'call-1', output: 'ok' } }],
      },
    ]);

    expect(() => formatAgentMessages([{ role: 'assistant', content }])).not.toThrow();
  });

  it('parses SSE data lines and stringifies non-string tool output', () => {
    expect(parseSSELine('data: {"object":"content","type":"text","text":"hi"}')).toEqual({
      object: 'content',
      type: 'text',
      text: 'hi',
    });
    expect(parseSSELine('data: [DONE]')).toBeNull();
    expect(normalizeToolOutputToString({ ok: true })).toBe('{"ok":true}');
  });

  it('keeps direct string data output from standalone tool results', () => {
    const content = buildContentPartsFromEchoMessages([
      {
        id: 'result-only',
        role: 'assistant',
        type: 'tool_result',
        metadata: { original_name: 'lookup' },
        content: [{ type: 'text', data: 'raw output' }],
      },
    ]);

    expect(toolCallPart(visibleParts(content)[0])).toMatchObject({
      name: 'lookup',
      output: 'raw output',
      progress: 1,
    });
  });
});
