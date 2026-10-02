import type { CandidateGuardrails } from '@khalta/engine';
import { LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components';
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
  MarkAreaComponent,
  CanvasRenderer,
]);
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Combined grading against the 0.45-power target and its band. Measurement plot: never mirrored (LTR island). */
export function CombinedChart({ g }: { g: CandidateGuardrails }) {
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
      const rows = [...g.gradingSieves].sort((a, b) => b.sieve_mm - a.sieve_mm);
      chart.setOption({
        animation: false,
        textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: text },
        grid: { left: 48, right: 16, top: 24, bottom: 44 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${Number(v).toFixed(1)}%` },
        xAxis: {
          type: 'log',
          inverse: true,
          min: 0.1,
          max: g.dmaxMm,
          name: t('materials.chart.sieve'),
          nameLocation: 'middle',
          nameGap: 28,
          axisLabel: { color: text, hideOverlap: true },
          axisLine: { lineStyle: { color: line } },
          splitLine: { lineStyle: { color: line } },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          name: t('materials.chart.passing'),
          nameTextStyle: { color: text, align: 'left' },
          axisLabel: { color: text },
          splitLine: { lineStyle: { color: line } },
        },
        series: [
          {
            name: t('studio.inspect.chart.upper'),
            type: 'line',
            symbol: 'none',
            lineStyle: { type: 'dashed', color: line },
            data: rows.map((r) => [r.sieve_mm, Math.min(100, r.target_pct + r.band_pct)]),
          },
          {
            name: t('studio.inspect.chart.lower'),
            type: 'line',
            symbol: 'none',
            lineStyle: { type: 'dashed', color: line },
            data: rows.map((r) => [r.sieve_mm, Math.max(0, r.target_pct - r.band_pct)]),
          },
          {
            name: t('studio.inspect.chart.target'),
            type: 'line',
            symbol: 'none',
            lineStyle: { color: text, width: 1 },
            data: rows.map((r) => [r.sieve_mm, r.target_pct]),
          },
          {
            name: t('studio.inspect.chart.combined'),
            type: 'line',
            symbolSize: 7,
            lineStyle: { width: 2, color: primary },
            itemStyle: { color: primary },
            data: rows.map((r) => [r.sieve_mm, r.passing_pct]),
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
  }, [g, t, theme]);
  return (
    <div
      ref={el}
      dir="ltr"
      role="img"
      aria-label={t('studio.inspect.chart.aria', { count: g.gradingSieves.length })}
      className="h-64 w-full"
      data-testid="combined-chart"
    />
  );
}

/** Shilstone coarseness/workability chart: the mix against the engineering target box. */
export function ShilstoneChart({ g }: { g: CandidateGuardrails }) {
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
      const { cf, wf } = g.limits;
      chart.setOption({
        animation: false,
        textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', color: text },
        grid: { left: 48, right: 16, top: 24, bottom: 44 },
        tooltip: { trigger: 'item' },
        xAxis: {
          type: 'value',
          inverse: true,
          min: 0,
          max: 100,
          name: t('studio.inspect.chart.cf'),
          nameLocation: 'middle',
          nameGap: 28,
          axisLabel: { color: text },
          splitLine: { lineStyle: { color: line } },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 60,
          name: t('studio.inspect.chart.wf'),
          nameTextStyle: { color: text, align: 'left' },
          axisLabel: { color: text },
          splitLine: { lineStyle: { color: line } },
        },
        series: [
          {
            type: 'scatter',
            symbolSize: 12,
            itemStyle: { color: primary },
            data: [[g.coarsenessFactor, g.workabilityFactorAdjusted]],
            markArea: {
              silent: true,
              itemStyle: {
                color: 'transparent',
                borderColor: text,
                borderWidth: 1,
                borderType: 'dashed',
              },
              data: [
                [
                  { xAxis: cf.max ?? 100, yAxis: wf.max ?? 60 },
                  { xAxis: cf.min ?? 0, yAxis: wf.min ?? 0 },
                ],
              ],
            },
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
  }, [g, t, theme]);
  return (
    <div
      ref={el}
      dir="ltr"
      role="img"
      aria-label={t('studio.inspect.chart.shilstoneAria', {
        cf: g.coarsenessFactor.toFixed(1),
        wf: g.workabilityFactorAdjusted.toFixed(1),
      })}
      className="h-64 w-full"
      data-testid="shilstone-chart"
    />
  );
}
