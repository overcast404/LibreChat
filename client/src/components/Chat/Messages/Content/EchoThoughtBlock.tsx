import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { PartWithIndex } from './ParallelContent';
import { useExpandCollapse, useLocalize } from '~/hooks';
import { cn, getToolDisplayLabel } from '~/utils';

const ECHO_COPAW_METADATA_KEY = 'echo_copaw';
const ECHO_COPAW_SOURCE = 'echo-copaw';
const WAITING_FOR_TOOL_OUTPUT = '等待工具返回。';

type EchoContentPhase = 'process' | 'narrative' | 'answer';

type EchoContentMetadata = {
  source?: string;
  phase?: EchoContentPhase;
  kind?: 'message' | 'reasoning' | 'tool_call';
  label?: string;
  sourceId?: string;
  sequence?: number;
};

type EchoPart = TMessageContentParts & {
  [ECHO_COPAW_METADATA_KEY]?: EchoContentMetadata;
};

type EchoToolCall = {
  id?: string;
  name?: string;
  args?: unknown;
  output?: string | null;
  progress?: number;
};

type EchoProcessStep = {
  id: string;
  title: string;
  status: 'running' | 'completed';
  kind: 'message' | 'reasoning' | 'tool';
  part: TMessageContentParts;
};

export function getEchoCoPawMetadata(part?: TMessageContentParts): EchoContentMetadata | null {
  const metadata = (part as EchoPart | undefined)?.[ECHO_COPAW_METADATA_KEY];
  return metadata?.source === ECHO_COPAW_SOURCE ? metadata : null;
}

export function isEchoCoPawPart(part?: TMessageContentParts): boolean {
  return getEchoCoPawMetadata(part) != null;
}

export function getEchoCoPawPhase(part?: TMessageContentParts): EchoContentPhase | null {
  const phase = getEchoCoPawMetadata(part)?.phase;
  return phase === 'process' || phase === 'narrative' || phase === 'answer' ? phase : null;
}

function getPartText(part: TMessageContentParts): string {
  if (part.type === ContentTypes.TEXT) {
    return typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
  }
  if (part.type === ContentTypes.THINK) {
    return typeof part.think === 'string' ? part.think : (part.think?.value ?? '');
  }
  return '';
}

function getToolCall(part: TMessageContentParts): EchoToolCall | null {
  if (part.type !== ContentTypes.TOOL_CALL) {
    return null;
  }

  const toolCall = part[ContentTypes.TOOL_CALL] as EchoToolCall | undefined;
  if (!toolCall || typeof toolCall !== 'object') {
    return null;
  }
  return toolCall;
}

function cleanTitle(text: string, fallback: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`|[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}...` : cleaned;
}

function formatDetailValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (_error) {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function buildProcessSteps(
  parts: PartWithIndex[],
  localize: ReturnType<typeof useLocalize>,
  isSubmitting: boolean,
): EchoProcessStep[] {
  const steps: EchoProcessStep[] = [];
  parts.forEach(({ part, idx }) => {
    const metadata = getEchoCoPawMetadata(part);
    const toolCall = getToolCall(part);
    if (toolCall) {
      const toolName = toolCall.name || metadata?.label || 'tool';
      const completed = toolCall.progress === 1 || !!toolCall.output || !isSubmitting;
      steps.push({
        id: toolCall.id || metadata?.sourceId || `tool-${idx}`,
        title: `调用 ${getToolDisplayLabel(toolName, localize)}`,
        status: completed ? 'completed' : 'running',
        kind: 'tool',
        part,
      });
      return;
    }

    const text = getPartText(part);
    if (!text.trim()) {
      return;
    }

    const kind = part.type === ContentTypes.THINK ? 'reasoning' : 'message';
    const isCurrentPart = isSubmitting && idx === parts[parts.length - 1]?.idx;
    let title = cleanTitle(text, '过程说明');
    if (kind === 'reasoning') {
      title = isCurrentPart ? '思考中...' : '思考...';
    }

    steps.push({
      id: metadata?.sourceId || `${kind}-${idx}`,
      title,
      status: isCurrentPart ? 'running' : 'completed',
      kind,
      part,
    });
  });
  return steps;
}

function DetailSection({ label, value }: { label: string; value: string }) {
  if (!value) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-normal text-text-secondary-alt">{label}</div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border-light bg-transparent px-2 py-1.5 text-[11px] leading-5 text-text-secondary">
        {value}
      </pre>
    </div>
  );
}

function StepDetail({ step }: { step: EchoProcessStep }) {
  const toolCall = getToolCall(step.part);
  if (toolCall) {
    const input = formatDetailValue(toolCall.args);
    const output = formatDetailValue(toolCall.output);
    return (
      <div className="space-y-2 py-1.5 pr-2">
        <DetailSection label="输入" value={input} />
        <DetailSection label="输出" value={output} />
        {!input && !output && (
          <div className="text-[11px] text-text-secondary-alt">{WAITING_FOR_TOOL_OUTPUT}</div>
        )}
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap break-words py-1.5 pr-2 text-xs leading-5 text-text-secondary-alt">
      {getPartText(step.part)}
    </div>
  );
}

function EchoProcessStepRow({ step }: { step: EchoProcessStep }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { style, ref } = useExpandCollapse(isExpanded);
  const handleToggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-xs text-text-secondary-alt opacity-80 transition-opacity hover:bg-surface-hover hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        <span className={cn('min-w-0 flex-1 truncate', step.status === 'running' && 'shimmer')}>
          {step.title}
        </span>
        <span className="shrink-0 text-[11px]">
          {step.status === 'running' ? '运行中' : '完成'}
        </span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform duration-200 ease-out',
            isExpanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      {isExpanded && (
        <div style={style} aria-hidden={false}>
          <div className="overflow-hidden" ref={ref}>
            <StepDetail step={step} />
          </div>
        </div>
      )}
    </li>
  );
}

type EchoThoughtBlockProps = {
  parts: PartWithIndex[];
  isSubmitting: boolean;
};

const EchoThoughtBlock = memo(function EchoThoughtBlock({
  parts,
  isSubmitting,
}: EchoThoughtBlockProps) {
  const localize = useLocalize();
  const [isExpanded, setIsExpanded] = useState(false);
  const { style, ref } = useExpandCollapse(isExpanded);
  const steps = useMemo(
    () => buildProcessSteps(parts, localize, isSubmitting),
    [parts, localize, isSubmitting],
  );
  const currentStep = steps[steps.length - 1];
  const label = isSubmitting ? (currentStep?.title ?? '思考中...') : '推理完成';
  const summary = isSubmitting ? undefined : `${steps.length} 个步骤`;

  const handleToggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-xs text-text-secondary-alt opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        <span
          className={cn(
            'min-w-0 truncate font-normal',
            !isSubmitting && 'shrink-0',
            isSubmitting && 'shimmer',
          )}
        >
          {label}
        </span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-normal text-text-secondary-alt">
            {summary}
          </span>
        )}
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
          <div className="mt-1 overflow-hidden border-t border-border-light pt-1" ref={ref}>
            <ol className="py-0.5">
              {steps.map((step) => (
                <EchoProcessStepRow key={step.id} step={step} />
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
});

export default EchoThoughtBlock;
