import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getToolDisplayLabel: (name: string) => name,
  mapAttachments: () => ({}),
  groupSequentialToolCalls: (parts: Array<{ part: unknown; idx: number }>) =>
    parts.map((p) => ({ type: 'single' as const, part: p })),
}));

jest.mock('~/hooks', () => ({
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: jest.fn(),
  }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  MessageContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
  SearchContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

jest.mock('../Parts', () => ({
  EditTextPart: () => <div data-testid="edit-text-part" />,
  EmptyText: () => <div data-testid="empty-text" />,
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="memory-artifacts" />,
}));

jest.mock('../Parts/PendingSkillCall', () => ({
  __esModule: true,
  default: ({ skillName, loaded }: { skillName: string; loaded: boolean }) => (
    <div data-testid="pending-skill-call" data-skill={skillName} data-loaded={String(loaded)} />
  ),
}));

jest.mock('../ToolCallGroup', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-group" />,
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="container">{children}</div>
  ),
}));

jest.mock('../Part', () => ({
  __esModule: true,
  default: ({ part }: { part: TMessageContentParts }) => {
    let text = '';
    if (part.type === 'text') {
      text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
    }
    return <div data-testid={`real-part-${part.type}`}>{text}</div>;
  },
}));

jest.mock('../ParallelContent', () => ({
  ParallelContentRenderer: () => <div data-testid="parallel-renderer" />,
}));

import ContentParts from '../ContentParts';

const baseProps = {
  messageId: 'msg-1',
  isLast: false,
  isSubmitting: false,
  isLatestMessage: false,
  isCreatedByUser: false,
  content: [],
};

describe('ContentParts — interim skill cards', () => {
  it('renders a PendingSkillCall per manual skill on assistant messages', () => {
    render(<ContentParts {...baseProps} manualSkills={['brand-guidelines', 'pptx']} />);
    const cards = screen.getAllByTestId('pending-skill-call');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-skill', 'brand-guidelines');
    expect(cards[1]).toHaveAttribute('data-skill', 'pptx');
  });

  it('starts pending skill cards in the not-loaded state (no real content yet)', () => {
    render(<ContentParts {...baseProps} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'false');
  });

  it('flips pending cards to loaded once any real content part arrives', () => {
    const content: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={content} manualSkills={['pptx']} />);
    expect(screen.getByTestId('pending-skill-call')).toHaveAttribute('data-loaded', 'true');
  });

  it('does NOT render skill cards on user messages', () => {
    render(<ContentParts {...baseProps} isCreatedByUser manualSkills={['pptx']} />);
    expect(screen.queryByTestId('pending-skill-call')).toBeNull();
  });

  it('renders nothing when manualSkills is empty and content is undefined', () => {
    const { container } = render(
      <ContentParts {...baseProps} content={undefined} manualSkills={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders pending skill cards even when content is undefined', () => {
    render(<ContentParts {...baseProps} content={undefined} manualSkills={['pptx']} />);
    expect(screen.getAllByTestId('pending-skill-call')).toHaveLength(1);
  });

  it('renders pending skill cards above parallel content', () => {
    const parallelContent: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'parallel',
        groupId: 'group-1',
      } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={parallelContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const parallelRenderer = screen.getByTestId('parallel-renderer');
    expect(skillCard).toBeTruthy();
    expect(parallelRenderer).toBeTruthy();
    expect(skillCard.compareDocumentPosition(parallelRenderer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders pending skill cards above sequential content', () => {
    const sequentialContent: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'streamed' } as unknown as TMessageContentParts,
    ];
    render(<ContentParts {...baseProps} content={sequentialContent} manualSkills={['pptx']} />);
    const skillCard = screen.getByTestId('pending-skill-call');
    const textPart = screen.getByTestId(`real-part-${ContentTypes.TEXT}`);
    expect(skillCard).toBeTruthy();
    expect(textPart).toBeTruthy();
    expect(skillCard.compareDocumentPosition(textPart)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ContentParts — Echo process activity', () => {
  const echoMetadata = (phase: 'process' | 'narrative' | 'answer', kind = 'message') => ({
    echo_copaw: {
      source: 'echo-copaw',
      phase,
      kind,
    },
  });

  const echoProcessContent: TMessageContentParts[] = [
    {
      type: ContentTypes.THINK,
      think: 'I need to inspect the available skills first.',
    } as unknown as TMessageContentParts,
    {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'call-1',
        name: 'read_file',
        args: '{"path":"SKILL.md"}',
      },
    } as unknown as TMessageContentParts,
  ];

  it('renders untagged QwenPaw process parts as one live activity row', () => {
    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting
        isLatestMessage
        content={echoProcessContent}
      />,
    );

    expect(screen.getByRole('button', { name: /调用 read_file/ })).toBeTruthy();
    expect(screen.queryByTestId(`real-part-${ContentTypes.THINK}`)).toBeNull();
    expect(screen.queryByTestId(`real-part-${ContentTypes.TOOL_CALL}`)).toBeNull();
    expect(screen.queryByTestId('empty-text')).toBeNull();
  });

  it('collapses completed QwenPaw process parts before body text', () => {
    const { container } = render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting
        isLatestMessage
        content={[
          ...echoProcessContent,
          { type: ContentTypes.TEXT, text: '好的，先随机选择 cycle。' } as TMessageContentParts,
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: /推理完成.*2 个步骤/ })).toBeTruthy();
    expect(screen.getByTestId(`real-part-${ContentTypes.TEXT}`)).toBeTruthy();
    expect(screen.queryByTestId(`real-part-${ContentTypes.THINK}`)).toBeNull();
    expect(screen.queryByTestId(`real-part-${ContentTypes.TOOL_CALL}`)).toBeNull();
    expect(container.querySelector('[style*="grid-template-rows: 0fr"]')).toBeNull();
  });

  it('merges consecutive Echo process blocks separated only by blank text', () => {
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'call-1',
          name: 'lookup_first',
          args: '{}',
          output: '{}',
          progress: 1,
        },
        ...echoMetadata('process', 'tool_call'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TEXT,
        text: '   ',
        ...echoMetadata('answer'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'call-2',
          name: 'lookup_second',
          args: '{}',
          output: '{}',
          progress: 1,
        },
        ...echoMetadata('process', 'tool_call'),
      } as unknown as TMessageContentParts,
    ];

    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting={false}
        isLatestMessage={false}
        content={content}
      />,
    );

    expect(screen.getByRole('button', { name: /推理完成.*2 个步骤/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /推理完成.*1 个步骤/ })).toBeNull();
    expect(screen.queryByTestId(`real-part-${ContentTypes.TEXT}`)).toBeNull();
  });

  it('keeps untagged process parts on non-Echo endpoints in the default renderer', () => {
    render(<ContentParts {...baseProps} endpoint="openAI" content={echoProcessContent} />);

    expect(screen.getByTestId(`real-part-${ContentTypes.THINK}`)).toBeTruthy();
    expect(screen.getByTestId(`real-part-${ContentTypes.TOOL_CALL}`)).toBeTruthy();
  });

  it('keeps completed Echo thinking and tool output folded before the final answer', () => {
    const completedEchoContent: TMessageContentParts[] = [
      {
        type: ContentTypes.THINK,
        think: 'Need to inspect data before answering.',
        ...echoMetadata('process', 'reasoning'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'call-1',
          name: 'lookup',
          args: '{"line":"A"}',
          output: '{"ok":true}',
          progress: 1,
        },
        ...echoMetadata('process', 'tool_call'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TEXT,
        text: 'Final answer.',
        ...echoMetadata('answer'),
      } as unknown as TMessageContentParts,
    ];

    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting={false}
        isLatestMessage={false}
        content={completedEchoContent}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /过程记录.*1段已折叠/ }));
    fireEvent.click(screen.getByRole('button', { name: /推理完成.*2 个步骤/ }));
    expect(screen.getByRole('button', { name: /调用 lookup.*完成/ })).toBeTruthy();
    expect(screen.getByTestId(`real-part-${ContentTypes.TEXT}`)).toBeTruthy();
    expect(screen.queryByTestId(`real-part-${ContentTypes.THINK}`)).toBeNull();
    expect(screen.queryByTestId(`real-part-${ContentTypes.TOOL_CALL}`)).toBeNull();
  });

  it('normalizes repeated text in persisted Echo answers', () => {
    const answer = '嗨！我是齐小光😊，产线运营专家，专精生产时序数据解读。有什么可以帮你的吗？';
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: answer + answer + answer,
        ...echoMetadata('answer'),
      } as unknown as TMessageContentParts,
    ];

    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting={false}
        isLatestMessage={false}
        content={content}
      />,
    );

    expect(screen.getByTestId(`real-part-${ContentTypes.TEXT}`).textContent).toBe(answer);
  });

  it('normalizes persisted Echo answers separated by a hidden summary comment', () => {
    const answer =
      '太好了！现在数据全部齐了！这是完整的产线节拍分析报告，包含白班、夜班和最终达标结论。';
    const content: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: `${answer}\n\n<!-- ⟦ 节拍分析摘要 ⟧ -->${answer}${answer}`,
        ...echoMetadata('answer'),
      } as unknown as TMessageContentParts,
    ];

    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting={false}
        isLatestMessage={false}
        content={content}
      />,
    );

    expect(screen.getByTestId(`real-part-${ContentTypes.TEXT}`).textContent).toBe(answer);
  });

  it('folds all non-answer Echo parts even when process parts arrive after the answer', () => {
    const completedEchoContent: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Preparing data.',
        ...echoMetadata('narrative'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TEXT,
        text: 'Final answer.',
        ...echoMetadata('answer'),
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'call-1',
          name: 'lookup',
          args: '{"line":"A"}',
          output: '{"ok":true}',
          progress: 1,
        },
        ...echoMetadata('process', 'tool_call'),
      } as unknown as TMessageContentParts,
    ];

    render(
      <ContentParts
        {...baseProps}
        endpoint="QwenPaw"
        isSubmitting={false}
        isLatestMessage={false}
        content={completedEchoContent}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /过程记录.*2段已折叠/ }));
    fireEvent.click(screen.getByRole('button', { name: /推理完成.*1 个步骤/ }));
    expect(screen.getByRole('button', { name: /调用 lookup.*完成/ })).toBeTruthy();
  });
});
