import type { GradationPoint } from '@khalta/engine';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Gradation curve: % passing against sieve size on a log axis, coarse sieves on the left. The chart is a
 * measurement plot, so it is never mirrored in Arabic (it lives in an LTR island) and has a table alongside.
 */
export default function GradationChart({
  points,
  name,
}: {
  points: GradationPoint[];
  name: string;
}) {
  const { t } = useTranslation();
  const { theme } = usePrefs();
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const node = el.current;
    let chart: echarts.ECharts | undefined;
    // wait a frame so the theme's CSS variables are applied before they are read
    const frame = requestAnimationFrame(() => {
      chart = echarts.init(node, undefined, { renderer: 'canvas' });
      const sorted = [...points].sort((a, b) => b.sieve_mm - a.sieve_mm);
      const text = css('--color-body') || '#222';
      const line = css('--color-line') || '#ccc';
      chart.setOption({
        animation: false,
        textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: text },
        grid: { left: 48, right: 16, top: 16, bottom: 44 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}%` },
        xAxis: {
          type: 'log',
          inverse: true,
          name: t('materials.chart.sieve'),
          nameLocation: 'middle',
          nameGap: 28,
          min: 0.075,
          max: 150,
          axisLabel: { color: text, hideOverlap: true, formatter: (v: number) => String(v) },
          axisLine: { lineStyle: { color: line } },
          splitLine: { lineStyle: { color: line } },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          name: t('materials.chart.passing'),
          nameTextStyle: { color: text, align: 'left' },
          axisLabel: { color: text, formatter: '{value}' },
          splitLine: { lineStyle: { color: line } },
        },
        series: [
          {
            name,
            type: 'line',
            symbolSize: 7,
            lineStyle: { width: 2, color: css('--color-primary') || '#14663d' },
            itemStyle: { color: css('--color-primary') || '#14663d' },
            data: sorted.map((p) => [p.sieve_mm, p.passing_pct]),
          },
        ],
      });
    });
    const onResize = () => chart?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      chart?.dispose();
    };
  }, [points, name, t, theme]);

  return (
    <div
      ref={el}
      dir="ltr"
      role="img"
      aria-label={t('materials.chart.aria', { name, count: points.length })}
      className="h-64 w-full"
      data-testid="gradation-chart"
    />
  );
}
