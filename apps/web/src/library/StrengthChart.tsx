import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  CanvasRenderer,
]);
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Results at the test age against f′c and f′cr, with the running average of 3. A measurement plot: never mirrored. */
export function StrengthChart({
  values,
  fc,
  fcr,
}: {
  values: number[];
  fc: number | null;
  fcr: number | null;
}) {
  const { t } = useTranslation();
  const { theme } = usePrefs();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const node = el.current;
    let chart: echarts.ECharts | undefined;
    const frame = requestAnimationFrame(() => {
      chart = echarts.init(node, undefined, { renderer: 'canvas' });
      const text = css('--color-body') || '#222';
      const line = css('--color-line') || '#ccc';
      const primary = css('--color-primary') || '#14663d';
      const avg3 = values.map((_, i) => {
        if (i < 2) return null;
        return (values[i]! + values[i - 1]! + values[i - 2]!) / 3;
      });
      const marks = [
        ...(fc !== null
          ? [{ yAxis: fc, name: 'f′c', lineStyle: { color: text, type: 'dashed' as const } }]
          : []),
        ...(fcr !== null
          ? [{ yAxis: fcr, name: 'f′cr', lineStyle: { color: '#b42318', type: 'solid' as const } }]
          : []),
      ];
      chart.setOption({
        animation: false,
        textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: text },
        grid: { left: 44, right: 56, top: 20, bottom: 30 },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'category',
          data: values.map((_, i) => i + 1),
          name: t('lab.chart.specimen'),
          nameLocation: 'middle',
          nameGap: 20,
          axisLine: { lineStyle: { color: line } },
        },
        yAxis: {
          type: 'value',
          scale: true,
          name: 'MPa',
          axisLine: { lineStyle: { color: line } },
          splitLine: { lineStyle: { color: line } },
        },
        series: [
          {
            name: t('lab.chart.results'),
            type: 'scatter',
            data: values,
            itemStyle: { color: primary },
            markLine: {
              symbol: 'none',
              silent: true,
              label: { formatter: '{b}', color: text },
              data: marks,
            },
          },
          {
            name: t('lab.chart.avg3'),
            type: 'line',
            data: avg3,
            itemStyle: { color: text },
            lineStyle: { color: text, width: 1.5 },
            connectNulls: false,
          },
        ],
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      chart?.dispose();
    };
  }, [values, fc, fcr, theme, t]);
  return (
    <div
      ref={el}
      dir="ltr"
      className="h-56 w-full"
      role="img"
      aria-label={t('lab.chart.title')}
      data-testid="strength-chart"
    />
  );
}
