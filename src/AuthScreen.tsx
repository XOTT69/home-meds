import { ArrowLeft, CheckCircle2, KeyRound, LockKeyhole, Mail, Pill, ShieldCheck } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { supabase } from './lib/supabase';

type Mode = 'sign-in' | 'sign-up' | 'recover' | 'new-password';

export function AuthScreen({ recovery, onRecoveryComplete }: { recovery?: boolean; onRecoveryComplete?: () => void }) {
  const [mode, setMode] = useState<Mode>(recovery ? 'new-password' : 'sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();

  const changeMode = (next: Mode) => { setMode(next); setError(''); setMessage(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');
    if (mode === 'new-password' && password !== confirmPassword) {
      setError('Паролі не збігаються.');
      return;
    }
    setBusy(true);
    const client = supabase!;
    try {
      if (mode === 'sign-in') {
        const { error: authError } = await client.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
      }
      if (mode === 'sign-up') {
        const { error: authError } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: appUrl },
        });
        if (authError) throw authError;
        setMessage('Майже готово: перевірте пошту й підтвердьте адресу, щоб увійти.');
      }
      if (mode === 'recover') {
        const { error: authError } = await client.auth.resetPasswordForEmail(email, { redirectTo: appUrl });
        if (authError) throw authError;
        setMessage('Якщо акаунт існує, ми надіслали лист для безпечного відновлення доступу.');
      }
      if (mode === 'new-password') {
        const { error: authError } = await client.auth.updateUser({ password });
        if (authError) throw authError;
        setMessage('Пароль оновлено. Тепер доступ до аптечки відновлено.');
        window.history.replaceState({}, document.title, window.location.pathname);
        onRecoveryComplete?.();
      }
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Щось пішло не так. Спробуйте ще раз.');
    } finally {
      setBusy(false);
    }
  };

  const recoveryMode = mode === 'recover';
  const passwordMode = mode === 'new-password';
  const isSignUp = mode === 'sign-up';

  return <main className="auth-shell">
    <section className="auth-aside"><div className="auth-brand"><span className="auth-brand-icon">+</span>home <b>meds</b></div><div className="auth-copy"><span className="auth-star">✦</span><p className="eyebrow">ВАША СІМЕЙНА АПТЕЧКА</p><h1>Турбота, яка завжди поруч.</h1><p>Безпечно зберігайте домашню аптечку, списки покупок і плани подорожей.</p></div><div className="auth-features"><span><ShieldCheck size={17} /> Лише ваші дані</span><span><Pill size={17} /> Усе під рукою</span></div></section>
    <section className="auth-card-wrap"><form className="auth-card" onSubmit={submit}>
      {(recoveryMode || passwordMode) && <button type="button" className="back-link" onClick={() => changeMode('sign-in')}><ArrowLeft size={16} /> Назад до входу</button>}
      <div className="auth-icon">{passwordMode ? <KeyRound size={22} /> : recoveryMode ? <Mail size={22} /> : <LockKeyhole size={22} />}</div>
      <h2>{passwordMode ? 'Новий пароль' : recoveryMode ? 'Відновити доступ' : isSignUp ? 'Створіть акаунт' : 'З поверненням'}</h2>
      <p className="auth-subtitle">{passwordMode ? 'Створіть новий надійний пароль для своєї аптечки.' : recoveryMode ? 'Ми надішлемо захищене посилання на вашу пошту.' : isSignUp ? 'Збережіть аптечку та відкривайте її з будь-якого пристрою.' : 'Увійдіть, щоб побачити свою аптечку.'}</p>
      {!passwordMode && <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>}
      {!recoveryMode && <label>Пароль<input type="password" required minLength={8} autoComplete={passwordMode ? 'new-password' : isSignUp ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Щонайменше 8 символів" /></label>}
      {passwordMode && <label>Повторіть пароль<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Повторіть новий пароль" /></label>}
      {error && <p className="auth-message error">{error}</p>}{message && <p className="auth-message success"><CheckCircle2 size={16} />{message}</p>}
      <button className="primary-button full auth-submit" disabled={busy}>{busy ? 'Зачекайте…' : passwordMode ? 'Зберегти новий пароль' : recoveryMode ? 'Надіслати посилання' : isSignUp ? 'Створити акаунт' : 'Увійти'}</button>
      {mode === 'sign-in' && <button type="button" className="auth-text-button" onClick={() => changeMode('recover')}>Забули пароль?</button>}
      {!recoveryMode && !passwordMode && <p className="auth-switch">{isSignUp ? 'Вже маєте акаунт?' : 'Ще не маєте акаунта?'} <button type="button" onClick={() => changeMode(isSignUp ? 'sign-in' : 'sign-up')}>{isSignUp ? 'Увійти' : 'Зареєструватися'}</button></p>}
      <p className="auth-privacy">Продовжуючи, ви погоджуєтесь з приватним зберіганням своїх даних. Не зберігайте тут призначення замість консультації лікаря.</p>
    </form></section>
  </main>;
}
