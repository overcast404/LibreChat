import { parseEChartsCode } from './parse';

describe('parseEChartsCode', () => {
  it('parses a direct ECharts option object', () => {
    const definition = parseEChartsCode(
      JSON.stringify({
        title: { text: '夜班节拍达标分布' },
        tooltip: { trigger: 'item' },
        series: [{ type: 'pie', data: [{ value: 46, name: '达标周期' }] }],
      }),
    );

    expect(definition).toMatchObject({
      height: 320,
      title: '夜班节拍达标分布',
      option: {
        tooltip: { trigger: 'item' },
        series: [{ type: 'pie' }],
      },
    });
  });

  it('parses the wrapped and double-encoded shapes used by echo-fn-demo', () => {
    const option = { xAxis: { type: 'category' }, series: [{ type: 'bar', data: [1, 2] }] };
    const definition = parseEChartsCode(
      JSON.stringify({ chart: { option: JSON.stringify(option), height: 1200 } }),
    );

    expect(definition).toEqual({ option, height: 800, title: undefined });
  });

  it('supports a flat option wrapper and clamps short chart heights', () => {
    const definition = parseEChartsCode(
      JSON.stringify({ option: { series: [{ type: 'line', data: [1, 2] }] }, height: 100 }),
    );

    expect(definition).toMatchObject({ height: 240, option: { series: [{ type: 'line' }] } });
  });

  it.each(['', '{"series":', '[]', '{"chart":{}}'])('rejects invalid chart source: %s', (code) => {
    expect(parseEChartsCode(code)).toBeNull();
  });
});
