import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';

echarts.use([LineChart, ScatterChart, GridComponent, TooltipComponent, CanvasRenderer]);
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The fitted curve with its data and the 1.64 s lower band, over the model's own w/cm domain only. A measurement plot: never mirrored. */
export function ModelChart({
  a,
  b,
  s,
  wcmMin,
  wcmMax,
  points,
}: {
  a: number;
  b: number;
  s: number;
  wcmMin: number;
  wcmMax: number;
  points: { wcm: number; mpa: number }[];
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
      const steps = 24;
      const xs = Array.from(
        { length: steps + 1 },
        (_, i) => wcmMin + ((wcmMax - wcmMin) * i) / steps,
      );
      chart.setOption({
        animation: false,
        textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: text },
        grid: { left: 48, right: 24, top: 20, bottom: 36 },
        tooltip: { trigger: 'item' },
        xAxis: {
          type: 'value',
          min: Math.floor(wcmMin * 100) / 100 - 0.01,
          max: Math.ceil(wcmMax * 100) / 100 + 0.01,
          name: 'w/cm',
          nameLocation: 'middle',
          nameGap: 24,
          axisLine: { lineStyle: { color: line } },
          splitLine: { show: false },
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
            name: t('strength.chart.results'),
            type: 'scatter',
            data: points.map((p) => [p.wcm, p.mpa]),
            symbolSize: 6,
            itemStyle: { color: primary, opacity: 0.7 },
          },
          {
            name: t('strength.chart.curve'),
            type: 'line',
            showSymbol: false,
            data: xs.map((x) => [x, Math.exp(a - b * x)]),
            lineStyle: { color: text, width: 2 },
          },
          {
            name: t('strength.chart.band'),
            type: 'line',
            showSymbol: false,
            data: xs.map((x) => [x, Math.exp(a - b * x) - 1.64 * s]),
            lineStyle: { color: '#b42318', width: 1.5, type: 'dashed' },
          },
        ],
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      chart?.dispose();
    };
  }, [a, b, s, wcmMin, wcmMax, points, theme, t]);
  return (
    <div
      ref={el}
      dir="ltr"
      className="h-64 w-full"
      role="img"
      aria-label={t('strength.chart.title')}
      data-testid="model-chart"
    />
  );
}
