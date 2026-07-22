import type { EChartsOption } from 'echarts';

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONObject | JSONValue[];
type JSONObject = { [key: string]: JSONValue };

export interface EChartsDefinition {
  option: EChartsOption;
  height: number;
  title?: string;
}

const DEFAULT_CHART_HEIGHT = 320;
const MIN_CHART_HEIGHT = 240;
const MAX_CHART_HEIGHT = 800;

const asObject = (value: JSONValue | undefined): JSONObject | null => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
};

const parseObject = (value: JSONValue | undefined): JSONObject | null => {
  if (typeof value !== 'string') {
    return asObject(value);
  }

  try {
    return asObject(JSON.parse(value) as JSONValue);
  } catch {
    return null;
  }
};

const clampHeight = (value: JSONValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CHART_HEIGHT;
  }
  return Math.max(MIN_CHART_HEIGHT, Math.min(value, MAX_CHART_HEIGHT));
};

const getTitle = (option: JSONObject): string | undefined => {
  const titleValue = Array.isArray(option.title) ? option.title[0] : option.title;
  const title = asObject(titleValue);
  return typeof title?.text === 'string' ? title.text : undefined;
};

export const parseEChartsCode = (code: string): EChartsDefinition | null => {
  if (!code.trim()) {
    return null;
  }

  let parsed: JSONValue;
  try {
    parsed = JSON.parse(code) as JSONValue;
  } catch {
    return null;
  }

  const root = asObject(parsed);
  if (!root) {
    return null;
  }

  const chart = asObject(root.chart);
  const wrappedOption = parseObject(chart?.option ?? root.option);
  const option = wrappedOption ?? (chart == null && root.option == null ? root : null);
  if (!option) {
    return null;
  }

  return {
    option: option as EChartsOption,
    height: clampHeight(chart?.height ?? (wrappedOption ? root.height : undefined)),
    title: getTitle(option),
  };
};
