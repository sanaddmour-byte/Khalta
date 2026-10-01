import {
  Button,
  Card,
  Checkbox,
  CODE_SOURCES,
  CodeBadge,
  DirectionProvider,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  EVIDENCE_STATUSES,
  EvidenceChip,
  Input,
  Label,
  Ltr,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SAVING_STATES,
  SavingStateLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  STATUSES,
  StatusChip,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  toast,
  Toaster,
  Tooltip,
  type Dir,
} from '@khalta/ui';
import { FlaskConical } from 'lucide-react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { usePrefs } from '../lib/prefs';
import { LanguageToggle, ThemeToggle } from '../shell/Controls';
import { useMemo } from 'react';

// Technical tokens (product codes, strength classes, units) are not translatable copy.
const SAMPLE = {
  cement1: 'CEM I 42.5N',
  cement2: 'CEM II/A-P 42.5N',
  cement3: 'CEM I 42.5N-SR3',
  grade: 'C30/37',
  quantity: '360 kg/m³',
  ratio: 'w/cm 0.45',
};

// Static class names so Tailwind can see them (utilities are generated from the token theme).
const TOKENS: [string, string][] = [
  ['app', 'bg-app'],
  ['surface', 'bg-surface'],
  ['line', 'bg-line'],
  ['muted', 'bg-muted'],
  ['heading', 'bg-heading'],
  ['body', 'bg-body'],
  ['primary', 'bg-primary'],
  ['primary-tint', 'bg-primary-tint'],
  ['olive', 'bg-olive'],
  ['olive-tint', 'bg-olive-tint'],
  ['pass', 'bg-pass'],
  ['pass-bg', 'bg-pass-bg'],
  ['fail', 'bg-fail'],
  ['fail-bg', 'bg-fail-bg'],
  ['warn', 'bg-warn'],
  ['warn-bg', 'bg-warn-bg'],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`dev-${id}`} className="flex flex-col gap-3">
      <h3 id={`dev-${id}`} className="text-sm font-semibold text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Gallery() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-8">
      <Section id="buttons" title={t('dev.buttons')}>
        <div className="flex flex-wrap gap-2">
          <Button>{t('dev.primary')}</Button>
          <Button variant="secondary">{t('dev.secondary')}</Button>
          <Button variant="ghost">{t('dev.ghost')}</Button>
          <Button variant="danger">{t('dev.danger')}</Button>
          <Button disabled>{t('dev.disabled')}</Button>
        </div>
      </Section>

      <Section id="forms" title={t('dev.forms')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="d-slump">{t('dev.inputLabel')}</Label>
            <div className="flex items-center gap-2">
              <Input id="d-slump" inputMode="numeric" placeholder={t('dev.inputPlaceholder')} />
              <Ltr className="text-muted">{t('dev.inputUnit')}</Ltr>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('dev.select')}</Label>
            <Select>
              <SelectTrigger aria-label={t('dev.select')}>
                <SelectValue placeholder={t('dev.selectPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="c1">
                  <Ltr mono>{SAMPLE.cement1}</Ltr>
                </SelectItem>
                <SelectItem value="c2">
                  <Ltr mono>{SAMPLE.cement2}</Ltr>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox defaultChecked /> {t('dev.checkbox')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch defaultChecked /> {t('dev.switch')}
          </label>
        </div>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">{t('dev.tabOne')}</TabsTrigger>
            <TabsTrigger value="b">{t('dev.tabTwo')}</TabsTrigger>
          </TabsList>
          <TabsContent value="a" className="pt-3 text-sm">
            {t('dev.tabOneBody')}
          </TabsContent>
          <TabsContent value="b" className="pt-3 text-sm">
            {t('dev.tabTwoBody')}
          </TabsContent>
        </Tabs>
      </Section>

      <Section id="overlays" title={t('dev.overlays')}>
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">{t('dev.openDialog')}</Button>
            </DialogTrigger>
            <DialogContent closeLabel={t('ui.close')}>
              <DialogTitle className="mb-2 text-lg font-semibold">
                {t('dev.dialogTitle')}
              </DialogTitle>
              <DialogDescription className="mb-4 text-sm text-muted">
                {t('dev.dialogBody')}
              </DialogDescription>
              <DialogClose asChild>
                <Button>{t('ui.close')}</Button>
              </DialogClose>
            </DialogContent>
          </Dialog>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary">{t('dev.openPopover')}</Button>
            </PopoverTrigger>
            <PopoverContent className="text-sm">{t('dev.popoverBody')}</PopoverContent>
          </Popover>
          <Tooltip label={t('dev.tooltip')}>
            <Button variant="ghost">{t('dev.hover')}</Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">{t('dev.menu')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>{t('dev.menuItem')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="secondary" onClick={() => toast(t('dev.toastBody'))}>
            {t('dev.toast')}
          </Button>
        </div>
      </Section>

      <Section id="chips" title={t('dev.chips')}>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <StatusChip key={s} status={s} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {CODE_SOURCES.map((s) => (
            <CodeBadge key={s} source={s} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {EVIDENCE_STATUSES.map((s) => (
            <EvidenceChip key={s} status={s} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {SAVING_STATES.map((s) => (
            <SavingStateLabel key={s} state={s} />
          ))}
        </div>
      </Section>

      <Section id="data" title={t('dev.data')}>
        <Table>
          <thead>
            <tr>
              <Th>{t('dev.material')}</Th>
              <Th numeric>{t('dev.quantity')}</Th>
              <Th numeric>{t('dev.cost')}</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>
                <Ltr mono>{t('dev_materials.cement')}</Ltr>
              </Td>
              <Td numeric>360.0</Td>
              <Td numeric>27.000</Td>
            </tr>
            <tr>
              <Td>{t('dev_materials.coarse')}</Td>
              <Td numeric>1,085.0</Td>
              <Td numeric>7.595</Td>
            </tr>
          </tbody>
        </Table>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <p className="mb-2 text-sm text-muted">{t('dev.loading')}</p>
            <div className="flex flex-col gap-2">
              <Skeleton className="w-2/3" />
              <Skeleton />
              <Skeleton className="w-1/2" />
            </div>
          </Card>
          <EmptyState
            icon={<FlaskConical className="size-6" aria-hidden />}
            title={t('dev.emptyTitle')}
            description={t('dev.emptyBody')}
            action={<Button size="sm">{t('dev.emptyAction')}</Button>}
          />
        </div>
      </Section>

      <Section id="bidi" title={t('dev.bidi')}>
        <p className="text-sm">
          {t('dev.sample')}: <Ltr>{SAMPLE.grade}</Ltr> · <Ltr mono>{SAMPLE.cement3}</Ltr> ·{' '}
          <Ltr>{SAMPLE.quantity}</Ltr> · <Ltr>{SAMPLE.ratio}</Ltr>
        </p>
        <p className="text-sm text-muted">{t('dev.sampleLine')}</p>
      </Section>

      <Section id="palette" title={t('dev.palette')}>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {TOKENS.map(([name, cls]) => (
            <div key={name} className="flex flex-col items-center gap-1 text-xs text-muted">
              <div className={`size-10 rounded-md border border-line ${cls}`} />
              <Ltr>{name}</Ltr>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** One panel per direction: its own language, `dir` and Radix DirectionProvider. */
function Panel({ dir, label }: { dir: Dir; label: string }) {
  const lng = dir === 'rtl' ? 'ar' : 'en';
  const instance = useMemo(() => i18n.cloneInstance({ lng }), [lng]);
  return (
    <I18nextProvider i18n={instance}>
      <DirectionProvider dir={dir}>
        <div
          dir={dir}
          lang={lng}
          data-panel={dir}
          className="rounded-lg border border-line bg-app p-4"
          style={{ fontFamily: dir === 'rtl' ? 'var(--font-sans-ar)' : 'var(--font-sans)' }}
        >
          <h2 className="mb-4 text-lg font-semibold text-heading">{label}</h2>
          <Gallery />
        </div>
      </DirectionProvider>
    </I18nextProvider>
  );
}

export function DevComponentsPage() {
  const { t } = useTranslation();
  const { theme } = usePrefs();
  return (
    <>
      <main id="main" className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-heading">{t('dev.title')}</h1>
            <p className="text-sm text-muted">{t('dev.intro')}</p>
          </div>
          <div className="flex gap-1">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>
        <Separator />
        <div className="grid gap-6 xl:grid-cols-2">
          <Panel dir="ltr" label={t('dev.ltr')} />
          <Panel dir="rtl" label={t('dev.rtl')} />
        </div>
        <Toaster theme={theme} />
      </main>
    </>
  );
}
