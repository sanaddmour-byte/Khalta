import { Button, Card, Input, Label } from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, signIn } from '../lib/api';
import { LanguageToggle, ThemeToggle } from '../shell/Controls';
import { Wordmark } from '../shell/Wordmark';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => signIn(email.trim(), password),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });
  const message =
    login.error instanceof ApiError && login.error.status < 500
      ? t('auth.invalid')
      : t('auth.failed');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex justify-end gap-1 p-3">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <main id="main" className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-sm p-6">
          <Wordmark className="mb-1 text-2xl" />
          <p className="mb-6 text-sm text-muted">{t('app.tagline')}</p>
          <h1 className="mb-1 text-lg font-semibold text-heading">{t('auth.title')}</h1>
          <p className="mb-4 text-sm text-muted">{t('auth.subtitle')}</p>
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                aria-invalid={login.isError}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                aria-invalid={login.isError}
              />
            </div>
            {login.isError && (
              <p role="alert" className="text-sm text-fail-text" data-testid="login-error">
                {message}
              </p>
            )}
            <Button type="submit" disabled={login.isPending || !email || !password}>
              {login.isPending ? t('auth.submitting') : t('auth.submit')}
            </Button>
          </form>
        </Card>
      </main>
    </div>
  );
}
