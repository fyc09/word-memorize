import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, AUTH_REQUIRED_EVENT, authApi, type AuthSession } from '../api';
import { App } from '../App';
import { Spinner } from './Spinner';

export function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    try {
      const current = await authApi.session(signal);
      if (!signal?.aborted) {
        setSession(current);
        setError('');
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ApiError && err.status === 401) {
        setSession(null);
        setError('');
      } else {
        setError(err instanceof Error ? err.message : '无法检查登录状态');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    const expired = () => { setSession(null); setError(''); };
    const focused = () => { void checkSession(controller.signal); };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    window.addEventListener('focus', focused);
    return () => {
      controller.abort();
      window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
      window.removeEventListener('focus', focused);
    };
  }, [checkSession]);

  const logout = useCallback(async () => {
    await authApi.logout();
    setSession(null);
  }, []);

  if (loading) return <div className="boot"><Spinner />载入中…</div>;
  if (session) return <App username={session.username} onLogout={logout} />;
  if (error) return (
    <div className="boot" role="alert">
      {error}
      <button className="btn" onClick={() => void checkSession()}>重试</button>
    </div>
  );
  return <LoginView onLogin={setSession} />;
}

function LoginView({ onLogin }: { onLogin: (session: AuthSession) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onLogin(await authApi.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <h1>语境背单词</h1>
        <label htmlFor="login-user">用户名</label>
        <input id="login-user" name="username" autoComplete="username" autoCapitalize="none"
          required maxLength={80} value={username} onChange={(e) => setUsername(e.target.value)} />
        <label htmlFor="login-password">密码</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password"
          required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary" disabled={busy || !username.trim() || !password}>
          {busy ? '登录中…' : '登录'}
        </button>
        {error && <p className="login-error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
