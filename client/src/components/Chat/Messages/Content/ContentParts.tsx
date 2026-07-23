import { memo, useRef, useMemo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type {
  TMessageContentParts,
  SearchResultData,
  TAttachment,
  Agents,
} from 'librechat-data-provider';
import type { ToolCallGroupExpansionState } from './ToolCallGroup';
import { ParallelContentRenderer, type PartWithIndex } from './ParallelContent';
import { cn, mapAttachments, groupSequentialToolCalls } from '~/utils';
import { MessageContext, SearchContext } from '~/Providers';
import PendingSkillCall from './Parts/PendingSkillCall';
import { EditTextPart, EmptyText } from './Parts';
import MemoryArtifacts from './MemoryArtifacts';
import EchoThoughtBlock, { getEchoCoPawPhase, isEchoCoPawPart } from './EchoThoughtBlock';
import ToolCallGroup from './ToolCallGroup';
import Container from './Container';
import Part from './Part';
import { useExpandCollapse } from '~/hooks';

const getToolCallId = (part: TMessageContentParts): string =>
  (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';

const isToolAnchorPart = (part: TMessageContentParts): boolean =>
  part.type === ContentTypes.TEXT && part.tool_call_ids != null;

const ECHO_HISTORY_TITLE = '过程记录';
const ECHO_HISTORY_SUMMARY_SUFFIX = '段已折叠';
const MIN_ECHO_REPEAT_LENGTH = 16;
const ECHO_HIDDEN_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

const normalizeEchoIdentifier = (value?: string | null): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const isEchoCoPawIdentifier = (value?: string | null): boolean => {
  const normalized = normalizeEchoIdentifier(value);
  return normalized.includes('qwenpaw') || normalized.includes('echocopaw');
};

const isEchoCoPawMessage = (endpoint?: string | null, model?: string | null): boolean =>
  isEchoCoPawIdentifier(endpoint) || isEchoCoPawIdentifier(model);

const isEchoProcessPart = (part: TMessageContentParts, hasEchoContent: boolean): boolean => {
  const phase = getEchoCoPawPhase(part);
  if (phase === 'process') {
    return true;
  }
  if (!hasEchoContent) {
    return false;
  }
  return (
    part.type === ContentTypes.THINK ||
    part.type === ContentTypes.TOOL_CALL ||
    isToolAnchorPart(part)
  );
};

const getToolGroupId = (parts: PartWithIndex[], fallbackScope: number): string => {
  const firstPart = parts[0];
  if (!firstPart) {
    return 'empty';
  }
  const toolCallId = getToolCallId(firstPart.part);
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  return `fallback:${fallbackScope}:${firstPart.idx}`;
};

const isEchoAnswerItem = (item: EchoRenderItem): boolean =>
  item.type === 'part' && getEchoCoPawPhase(item.part) === 'answer';

const getTextPartValue = (part: TMessageContentParts): string | null => {
  if (part.type !== ContentTypes.TEXT) {
    return null;
  }
  return typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
};

const collapseExactEchoTextRepeats = (text: string): string => {
  if (text.length < MIN_ECHO_REPEAT_LENGTH * 2) {
    return text;
  }

  const comparable = text.replace(ECHO_HIDDEN_COMMENT_PATTERN, '').trim();
  if (comparable.length < MIN_ECHO_REPEAT_LENGTH * 2) {
    return text;
  }

  const anchor = comparable.slice(0, MIN_ECHO_REPEAT_LENGTH);
  let repeatStart = comparable.indexOf(anchor, MIN_ECHO_REPEAT_LENGTH);

  while (repeatStart >= MIN_ECHO_REPEAT_LENGTH) {
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

  return text;
};

const normalizePersistedEchoTextPart = (part: TMessageContentParts): TMessageContentParts => {
  if (!isEchoCoPawPart(part) || part.type !== ContentTypes.TEXT || typeof part.text !== 'string') {
    return part;
  }

  const text = collapseExactEchoTextRepeats(part.text);
  return text === part.text ? part : ({ ...part, text } as TMessageContentParts);
};

const isBlankTextPart = (part: TMessageContentParts): boolean => {
  const text = getTextPartValue(part);
  return text != null && text.trim().length === 0;
};

type EchoRenderItem =
  | {
      type: 'process';
      key: string;
      parts: PartWithIndex[];
      hasFollowingContent: boolean;
    }
  | {
      type: 'part';
      key: string;
      part: TMessageContentParts;
      idx: number;
    };

function mergeAdjacentEchoProcessItems(items: EchoRenderItem[]): EchoRenderItem[] {
  const merged: EchoRenderItem[] = [];

  items.forEach((item) => {
    const previous = merged[merged.length - 1];
    if (item.type === 'process' && previous?.type === 'process') {
      previous.parts = [...previous.parts, ...item.parts];
      previous.hasFollowingContent = item.hasFollowingContent;
      return;
    }
    merged.push(item);
  });

  return merged;
}

type PartWithContextProps = {
  part: TMessageContentParts;
  idx: number;
  isLastPart: boolean;
  messageId: string;
  conversationId?: string | null;
  nextType?: string;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  isCreatedByUser: boolean;
  isLast: boolean;
  partAttachments: TAttachment[] | undefined;
  hideAttachments?: boolean;
  onToolExpand?: () => void;
};

function EchoProcessContainer({ children }: { children: ReactNode }) {
  return (
    <div
      className="echo-process-message flex min-h-[20px] w-full flex-col items-start overflow-visible"
      dir="auto"
    >
      {children}
    </div>
  );
}

function EchoHistoryCollapse({ children, itemCount }: { children: ReactNode; itemCount: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { style, ref } = useExpandCollapse(isExpanded);
  const handleToggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  return (
    <div className="w-full">
      <button
        type="button"
        className="flex w-full items-center gap-2 py-1 text-left text-xs text-text-secondary-alt opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        <span className="shrink-0 font-normal">{ECHO_HISTORY_TITLE}</span>
        <span className="min-w-0 flex-1 truncate font-normal text-text-secondary-alt">
          {itemCount}
          {ECHO_HISTORY_SUMMARY_SUFFIX}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-200 ease-out',
            isExpanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      {isExpanded && (
        <div style={style} aria-hidden={false}>
          <div
            className="echo-history-content mt-2 space-y-4 overflow-hidden border-t border-border-light pt-2"
            ref={ref}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

const PartWithContext = memo(function PartWithContext({
  part,
  idx,
  isLastPart,
  messageId,
  conversationId,
  nextType,
  isSubmitting,
  isLatestMessage,
  isCreatedByUser,
  isLast,
  partAttachments,
  hideAttachments,
  onToolExpand,
}: PartWithContextProps) {
  const contextValue = useMemo(
    () => ({
      messageId,
      isExpanded: true as const,
      conversationId,
      partIndex: idx,
      nextType,
      isSubmitting,
      isLatestMessage,
    }),
    [messageId, conversationId, idx, nextType, isSubmitting, isLatestMessage],
  );

  return (
    <MessageContext.Provider value={contextValue}>
      <Part
        part={part}
        attachments={partAttachments}
        isSubmitting={isSubmitting}
        key={`part-${messageId}-${idx}`}
        isCreatedByUser={isCreatedByUser}
        isLast={isLastPart}
        showCursor={isLastPart && isLast}
        hideAttachments={hideAttachments}
        onToolExpand={onToolExpand}
      />
    </MessageContext.Provider>
  );
});

type ContentPartsProps = {
  content: Array<TMessageContentParts | undefined> | undefined;
  messageId: string;
  /**
   * Skill names the user invoked manually via the `$` popover on this turn.
   * `createdHandler` seeds this on the assistant placeholder from
   * `submission.manualSkills`, and `finalHandler`'s server-backed
   * `responseMessage` replacement drops it — so the field is naturally
   * present only for the lifetime of the stream. Scalar string array (not
   * the full message object) so `React.memo` stays shallow-happy.
   */
  manualSkills?: string[];
  endpoint?: string | null;
  model?: string | null;
  /** ISO timestamp of the parent message, surfaced in parallel column headers. */
  createdAt?: string | null;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isCreatedByUser: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?:
    | ((value: number) => void | React.Dispatch<React.SetStateAction<number>>)
    | null
    | undefined;
};

/**
 * ContentParts renders message content parts, handling both sequential and parallel layouts.
 *
 * For 90% of messages (single-agent, no parallel execution), this renders sequentially.
 * For multi-agent parallel execution, it uses ParallelContentRenderer to show columns.
 */
const ContentParts = memo(function ContentParts({
  edit,
  isLast,
  content,
  manualSkills,
  endpoint,
  model,
  messageId,
  enterEdit,
  siblingIdx,
  attachments,
  isSubmitting,
  setSiblingIdx,
  searchResults,
  conversationId,
  isCreatedByUser,
  isLatestMessage,
  createdAt,
}: ContentPartsProps) {
  const attachmentMap = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;
  const toolGroupExpansionRef = useRef(new Map<string, ToolCallGroupExpansionState>());
  const fallbackScopeRef = useRef({ messageId, scope: 0 });
  if (fallbackScopeRef.current.messageId !== messageId) {
    if (!effectiveIsSubmitting) {
      fallbackScopeRef.current.scope += 1;
      toolGroupExpansionRef.current.clear();
    }
    fallbackScopeRef.current.messageId = messageId;
  }
  const fallbackScope = fallbackScopeRef.current.scope;

  const handleGroupExpansionChange = useCallback(
    (groupId: string, state: ToolCallGroupExpansionState) => {
      if (!state.userOverride) {
        toolGroupExpansionRef.current.delete(groupId);
        return;
      }
      toolGroupExpansionRef.current.set(groupId, state);
    },
    [],
  );

  /**
   * Interim skill cards — rendered in a separate slot ABOVE the Parts
   * iteration based purely on the `manualSkills` message field. `content`
   * is only read to determine the "Running → Ran" visual transition
   * (`hasRealContent`), never to gate visibility, so backend deltas /
   * optimistic emissions can't race the pending cards off the screen.
   *
   * Lifecycle:
   *  - `useChatFunctions` seeds `manualSkills` on the assistant placeholder
   *    at construction → cards appear immediately on submit, with the
   *    shimmering "Running X" state (no content yet).
   *  - Through the stream, `useStepHandler` spreads the response on every
   *    update so `manualSkills` rides along; once the first real content
   *    part lands, `hasRealContent` flips true and the cards switch to
   *    the static "Ran X" state — matching what users see for
   *    model-invoked skills as they finish priming.
   *  - At finalize, `finalHandler` replaces the message with the server
   *    response (no `manualSkills` field) → interim cards disappear and
   *    the real `skill` tool_call part in `content` takes over.
   *
   * Skipped on the user side (they get `SkillPills` on the user
   * bubble) and when no skills were invoked on this turn.
   */
  const pendingSkills = useMemo(
    () => (!isCreatedByUser && manualSkills != null ? manualSkills : []),
    [isCreatedByUser, manualSkills],
  );
  const hasPendingSkills = pendingSkills.length > 0;

  /**
   * True once the assistant has started streaming something meaningful —
   * any non-text part, OR a text part with non-empty content. Drives the
   * "Running X → Ran X" transition on pending cards. An empty-text
   * placeholder (some endpoints seed one in `initialResponse.content` on
   * assistant-side) does NOT count as real content, to avoid flipping
   * the transition before the model has actually produced anything.
   */
  const hasRealContent = useMemo(
    () =>
      (content ?? []).some((part) => {
        if (part == null) {
          return false;
        }
        if (part.type !== ContentTypes.TEXT) {
          return true;
        }
        const text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
        return text.length > 0;
      }),
    [content],
  );

  const renderPendingSkills = () =>
    pendingSkills.map((name) => (
      <PendingSkillCall key={`pending-skill-${name}`} skillName={name} loaded={hasRealContent} />
    ));

  const renderPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean) => {
      return (
        <PartWithContext
          key={`provider-${messageId}-${idx}`}
          idx={idx}
          part={part}
          isLast={isLast}
          messageId={messageId}
          isLastPart={isLastPart}
          conversationId={conversationId}
          isLatestMessage={isLatestMessage}
          isCreatedByUser={isCreatedByUser}
          nextType={content?.[idx + 1]?.type}
          isSubmitting={effectiveIsSubmitting}
          partAttachments={attachmentMap[getToolCallId(part)]}
        />
      );
    },
    [
      attachmentMap,
      content,
      conversationId,
      effectiveIsSubmitting,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  const renderGroupedPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean, onToolExpand?: () => void) => {
      return (
        <PartWithContext
          key={`provider-${messageId}-${idx}`}
          idx={idx}
          part={part}
          isLast={isLast}
          messageId={messageId}
          isLastPart={isLastPart}
          conversationId={conversationId}
          isLatestMessage={isLatestMessage}
          isCreatedByUser={isCreatedByUser}
          nextType={content?.[idx + 1]?.type}
          isSubmitting={effectiveIsSubmitting}
          partAttachments={attachmentMap[getToolCallId(part)]}
          hideAttachments
          onToolExpand={onToolExpand}
        />
      );
    },
    [
      attachmentMap,
      content,
      conversationId,
      effectiveIsSubmitting,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  const sequentialParts = useMemo<PartWithIndex[]>(() => {
    if (!content) {
      return [];
    }
    const result: PartWithIndex[] = [];
    content.forEach((part, idx) => {
      if (part) {
        result.push({ part, idx });
      }
    });
    return result;
  }, [content]);

  const groupedParts = useMemo(
    () =>
      groupSequentialToolCalls(sequentialParts).map((group) => {
        if (group.type === 'single') {
          return group;
        }
        const groupId = getToolGroupId(group.parts, fallbackScope);
        const groupAttachments = group.parts.flatMap(
          ({ part }) => attachmentMap[getToolCallId(part)] ?? [],
        );
        return { ...group, groupId, groupAttachments };
      }),
    [sequentialParts, attachmentMap, fallbackScope],
  );

  const safeContent = useMemo(
    () => (content ?? []).map((part) => (part ? normalizePersistedEchoTextPart(part) : part)),
    [content],
  );
  const showEmptyCursor = safeContent.length === 0 && effectiveIsSubmitting;
  const lastContentIdx = safeContent.length - 1;
  const hasEchoContent =
    isEchoCoPawMessage(endpoint, model) || safeContent.some((part) => isEchoCoPawPart(part));
  const echoRenderItems = useMemo<EchoRenderItem[]>(() => {
    const items: EchoRenderItem[] = [];
    let processParts: PartWithIndex[] = [];
    let processGroupCount = 0;

    const flushProcessParts = (hasFollowingContent: boolean) => {
      if (processParts.length === 0) {
        return;
      }
      const firstIdx = processParts[0]?.idx ?? processGroupCount;
      items.push({
        type: 'process',
        key: `echo-process-${processGroupCount}-${firstIdx}`,
        parts: processParts,
        hasFollowingContent,
      });
      processParts = [];
      processGroupCount += 1;
    };

    safeContent.forEach((part, idx) => {
      if (!part) {
        return;
      }
      if (isEchoProcessPart(part, hasEchoContent)) {
        processParts.push({ part, idx });
        return;
      }
      if (isBlankTextPart(part)) {
        return;
      }

      flushProcessParts(true);
      items.push({ type: 'part', key: `echo-part-${idx}`, part, idx });
    });

    flushProcessParts(false);
    return items;
  }, [safeContent, hasEchoContent]);
  const echoVisiblePartIndexes = useMemo(
    () =>
      echoRenderItems.flatMap((item) => {
        if (item.type !== 'part') {
          return [];
        }
        return [item.idx];
      }),
    [echoRenderItems],
  );
  const echoLastVisiblePartIdx =
    echoVisiblePartIndexes[echoVisiblePartIndexes.length - 1] ?? lastContentIdx;

  const hasEchoAnswer = useMemo(
    () => !effectiveIsSubmitting && echoRenderItems.some(isEchoAnswerItem),
    [echoRenderItems, effectiveIsSubmitting],
  );
  const echoHistoryItems = hasEchoAnswer
    ? mergeAdjacentEchoProcessItems(echoRenderItems.filter((item) => !isEchoAnswerItem(item)))
    : [];
  const echoMainItems = hasEchoAnswer
    ? echoRenderItems.filter(isEchoAnswerItem)
    : mergeAdjacentEchoProcessItems(echoRenderItems);
  const shouldCollapseEchoHistory = echoHistoryItems.length > 0;

  const renderEchoItem = useCallback(
    (item: EchoRenderItem) => {
      if (item.type === 'process') {
        const isActiveProcess = !item.hasFollowingContent && effectiveIsSubmitting;
        return (
          <EchoProcessContainer key={item.key}>
            <EchoThoughtBlock parts={item.parts} isSubmitting={isActiveProcess} />
          </EchoProcessContainer>
        );
      }

      return renderPart(item.part, item.idx, item.idx === echoLastVisiblePartIdx);
    },
    [echoLastVisiblePartIdx, effectiveIsSubmitting, renderPart],
  );

  // Early return: no content to render AND no pending skill cards
  if (!content && !hasPendingSkills) {
    return null;
  }

  // Edit mode: render editable text parts. Interim skill cards are a
  // mid-stream concern, not relevant in edit mode.
  if (edit === true && enterEdit && setSiblingIdx) {
    return (
      <>
        {(content ?? []).map((part, idx) => {
          if (!part) {
            return null;
          }
          const isTextPart =
            part?.type === ContentTypes.TEXT ||
            typeof (part as unknown as Agents.MessageContentText)?.text === 'string';
          const isThinkPart =
            part?.type === ContentTypes.THINK ||
            typeof (part as unknown as Agents.ReasoningDeltaUpdate)?.think === 'string';
          if (!isTextPart && !isThinkPart) {
            return null;
          }

          const isToolCall = part.type === ContentTypes.TOOL_CALL || part['tool_call_ids'] != null;
          if (isToolCall) {
            return null;
          }

          return (
            <EditTextPart
              index={idx}
              part={part as Agents.MessageContentText | Agents.ReasoningDeltaUpdate}
              messageId={messageId}
              isSubmitting={isSubmitting}
              enterEdit={enterEdit}
              siblingIdx={siblingIdx ?? null}
              setSiblingIdx={setSiblingIdx}
              key={`edit-${messageId}-${idx}`}
            />
          );
        })}
      </>
    );
  }

  if (hasEchoContent) {
    return (
      <SearchContext.Provider value={{ searchResults }}>
        <MemoryArtifacts attachments={attachments} />
        {renderPendingSkills()}
        {showEmptyCursor && echoRenderItems.length === 0 && (
          <Container>
            <EmptyText />
          </Container>
        )}
        {shouldCollapseEchoHistory && (
          <EchoProcessContainer>
            <EchoHistoryCollapse itemCount={echoHistoryItems.length}>
              {echoHistoryItems.map(renderEchoItem)}
            </EchoHistoryCollapse>
          </EchoProcessContainer>
        )}
        {echoMainItems.map(renderEchoItem)}
      </SearchContext.Provider>
    );
  }

  // Parallel content: use dedicated renderer with columns (TMessageContentParts includes ContentMetadata)
  const hasParallelContent = safeContent.some((part) => part?.groupId != null);
  if (hasParallelContent) {
    return (
      <>
        {renderPendingSkills()}
        <ParallelContentRenderer
          content={content}
          messageId={messageId}
          createdAt={createdAt}
          conversationId={conversationId}
          attachments={attachments}
          searchResults={searchResults}
          isSubmitting={effectiveIsSubmitting}
          renderPart={renderPart}
        />
      </>
    );
  }

  // Sequential content: render parts in order (90% of cases)
  return (
    <SearchContext.Provider value={{ searchResults }}>
      <MemoryArtifacts attachments={attachments} />
      {renderPendingSkills()}
      {showEmptyCursor && (
        <Container>
          <EmptyText />
        </Container>
      )}
      {groupedParts.map((group) => {
        if (group.type === 'single') {
          const { part, idx } = group.part;
          return renderPart(part, idx, idx === lastContentIdx);
        }
        const { groupId } = group;
        return (
          <ToolCallGroup
            key={`tool-group-${groupId}`}
            parts={group.parts}
            isSubmitting={effectiveIsSubmitting}
            isLast={group.parts.some((p) => p.idx === lastContentIdx)}
            renderPart={renderGroupedPart}
            lastContentIdx={lastContentIdx}
            groupAttachments={group.groupAttachments}
            initialExpansionState={toolGroupExpansionRef.current.get(groupId)}
            onExpansionChange={(state) => handleGroupExpansionChange(groupId, state)}
          />
        );
      })}
    </SearchContext.Provider>
  );
});

export default ContentParts;
