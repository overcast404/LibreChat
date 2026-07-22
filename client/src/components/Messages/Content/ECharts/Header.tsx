import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import copy from 'copy-to-clipboard';
import { ChevronDown, ChevronUp } from 'lucide-react';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';

interface HeaderProps {
  code: string;
  showCode: boolean;
  onToggleCode: () => void;
}

const actionClass =
  'flex items-center justify-center rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy';

const Header = memo(function Header({ code, showCode, onToggleCode }: HeaderProps) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  const handleCopy = useCallback(() => {
    copy(code.trim(), { format: 'text/plain' });
    setIsCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setIsCopied(false), 3000);
  }, [code]);

  return (
    <div className="flex min-h-9 items-center justify-between gap-1 border-b border-border-light bg-surface-secondary px-2 py-1">
      <span className="rounded px-1 text-xs font-medium text-text-secondary">
        {localize('com_ui_echarts')}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={showCode ? localize('com_ui_hide_code') : localize('com_ui_show_code')}
          className={actionClass}
          onClick={onToggleCode}
        >
          {showCode ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <CopyButton isCopied={isCopied} iconOnly onClick={handleCopy} />
      </div>
    </div>
  );
});

Header.displayName = 'EChartsHeader';

export default Header;
