import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { ThemeContext, isDark } from '@librechat/client';
import type { EChartsType } from 'echarts';
import Header from './Header';
import { parseEChartsCode } from './parse';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import { useLocalize } from '~/hooks';

interface EChartsProps {
  code: string;
}

const ECharts = memo(function ECharts({ code }: EChartsProps) {
  const localize = useLocalize();
  const { theme } = useContext(ThemeContext);
  const isDarkMode = isDark(theme);
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<EChartsType | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [hasRenderError, setHasRenderError] = useState(false);
  const definition = useMemo(() => parseEChartsCode(code), [code]);

  const toggleCode = useCallback(() => setShowCode((current) => !current), []);

  useEffect(() => {
    setHasRenderError(false);
  }, [code]);

  useEffect(() => {
    const element = chartRef.current;
    if (!element || !definition || hasRenderError) {
      return;
    }

    try {
      const instance = echarts.init(element, isDarkMode ? 'dark' : undefined);
      instanceRef.current = instance;
      instance.setOption({ ...definition.option, backgroundColor: 'transparent' }, true);

      const resizeObserver =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => instanceRef.current?.resize());
      resizeObserver?.observe(element);

      return () => {
        resizeObserver?.disconnect();
        instance.dispose();
        if (instanceRef.current === instance) {
          instanceRef.current = null;
        }
      };
    } catch (error) {
      console.error('ECharts rendering error:', error);
      instanceRef.current?.dispose();
      instanceRef.current = null;
      setHasRenderError(true);
    }
  }, [definition, hasRenderError, isDarkMode]);

  if (!definition || hasRenderError) {
    return <CodeBlock lang="echart" codeChildren={code} allowExecution={false} />;
  }

  const chartLabel = definition.title
    ? `${localize('com_ui_echarts')}: ${definition.title}`
    : localize('com_ui_echarts');

  return (
    <div className="w-full overflow-hidden rounded-xl border border-border-light bg-surface-chat dark:bg-surface-primary-alt">
      <Header code={code} showCode={showCode} onToggleCode={toggleCode} />
      {showCode && (
        <pre className="max-h-64 overflow-auto border-b border-border-light bg-surface-chat p-4 font-mono text-xs text-text-primary dark:bg-surface-primary-alt">
          <code className="whitespace-pre">{code}</code>
        </pre>
      )}
      <div className="w-full p-2 sm:p-3">
        <div
          ref={chartRef}
          role="img"
          aria-label={chartLabel}
          className="w-full min-w-0"
          style={{ height: definition.height }}
        />
      </div>
    </div>
  );
});

ECharts.displayName = 'ECharts';

export default ECharts;
