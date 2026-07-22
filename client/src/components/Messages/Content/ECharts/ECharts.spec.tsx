import React from 'react';
import { act, render, screen } from '@testing-library/react';
import * as echarts from 'echarts';
import ECharts from './ECharts';

const mockSetOption = jest.fn();
const mockResize = jest.fn();
const mockDispose = jest.fn();

jest.mock('echarts', () => ({
  init: jest.fn(() => ({
    setOption: mockSetOption,
    resize: mockResize,
    dispose: mockDispose,
  })),
}));

jest.mock('@librechat/client', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    ThemeContext: ReactModule.createContext({ theme: 'light' }),
    isDark: () => false,
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('./Header', () => ({
  __esModule: true,
  default: () => <div data-testid="echarts-header" />,
}));

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ lang }: { lang: string }) => <div data-testid="code-fallback">{lang}</div>,
}));

class MockResizeObserver {
  static latest: MockResizeObserver | null = null;
  readonly callback: ResizeObserverCallback;
  observe = jest.fn();
  disconnect = jest.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.latest = this;
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe('ECharts', () => {
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(() => {
    jest.clearAllMocks();
    MockResizeObserver.latest = null;
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver;
  });

  it('renders a chart, resizes it with its container, and disposes it on unmount', () => {
    const code = JSON.stringify({
      title: { text: '夜班节拍达标分布' },
      series: [{ type: 'pie', data: [{ value: 46, name: '达标周期' }] }],
    });
    const { unmount } = render(<ECharts code={code} />);

    expect(screen.getByRole('img', { name: 'com_ui_echarts: 夜班节拍达标分布' })).toBeVisible();
    expect(echarts.init).toHaveBeenCalledTimes(1);
    expect(mockSetOption).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: 'transparent',
        series: [expect.objectContaining({ type: 'pie' })],
      }),
      true,
    );

    act(() => MockResizeObserver.latest?.trigger());
    expect(mockResize).toHaveBeenCalledTimes(1);

    unmount();
    expect(MockResizeObserver.latest?.disconnect).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('keeps an invalid or incomplete echart fence as source code', () => {
    render(<ECharts code={'{"series":'} />);

    expect(screen.getByTestId('code-fallback')).toHaveTextContent('echart');
    expect(echarts.init).not.toHaveBeenCalled();
  });
});
