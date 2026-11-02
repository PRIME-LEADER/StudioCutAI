import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  cloudConfigurationStatus,
  listCloudProjects,
  listCloudProjectVersions,
  restoreCloudProject,
  supabaseClient,
  testCloudConnection,
} from './cloudSync'
import type { CloudProjectSummary } from './cloudSync'

export type LocalProjectSummary = { id: number; name: string; updated: string }

type Props = {
  localProjects: LocalProjectSummary[]
  cloudSyncEnabled: boolean
  mediaSyncEnabled: boolean
  syncMessage: string
  onCloudSyncEnabledChange: (enabled: boolean) => void
  onMediaSyncEnabledChange: (enabled: boolean) => void
  onUserChange: (user: User | null) => void
  onSyncLocalProjects: () => Promise<void>
  onRestoreProject: (project: Awaited<ReturnType<typeof restoreCloudProject>>) => Promise<void>
}

export default function CloudWorkspace({
  localProjects,
  cloudSyncEnabled,
  mediaSyncEnabled,
  syncMessage,
  onCloudSyncEnabledChange,
  onMediaSyncEnabledChange,
  onUserChange,
  onSyncLocalProjects,
  onRestoreProject,
}: Props) {
  const [user, setUser] = useState<User | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [versions, setVersions] = useState<Record<string, Array<{
    revision: number
    name: string
    created_at: string
  }>>>({})
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastCloudTest, setLastCloudTest] = useState('')
  const cloudConfig = cloudConfigurationStatus()
  const configured = cloudConfig.configured

  useEffect(() => {
    if (!supabaseClient) return
    let active = true
    void supabaseClient.auth.getUser().then(({ data, error }) => {
      if (!active) return
      if (error) setMessage(error.message)
      setUser(data.user)
      onUserChange(data.user)
    })
    const { data: { subscription } } = supabaseClient.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null)
      onUserChange(session?.user || null)
      setMessage('')
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [onUserChange])

  async function refreshProjects() {
    setLoading(true)
    setMessage('')
    try {
      setProjects(await listCloudProjects())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cloud projects could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (user && cloudSyncEnabled) {
      void onSyncLocalProjects()
        .then(async () => setProjects(await listCloudProjects()))
        .catch(error => {
          setMessage(error instanceof Error ? error.message : 'Automatic cloud sync failed.')
        })
    }
  }, [user, cloudSyncEnabled, onSyncLocalProjects])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabaseClient) return
    setLoading(true)
    setMessage('')
    try {
      const result = isSignUp
        ? await supabaseClient.auth.signUp({ email, password })
        : await supabaseClient.auth.signInWithPassword({ email, password })
      if (result.error) throw result.error
      if (isSignUp && !result.data.session) {
        setMessage('Check your email to confirm the account, then sign in.')
      } else {
        setMessage(isSignUp ? 'Account created.' : 'Signed in securely.')
      }
      setPassword('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  async function signOut() {
    if (!supabaseClient) return
    const { error } = await supabaseClient.auth.signOut()
    setMessage(error?.message || 'Signed out.')
  }

  async function testConnection() {
    setLoading(true)
    setMessage('Testing Supabase Auth, Postgres and private Storage…')
    try {
      const result = await testCloudConnection()
      setLastCloudTest(new Date().toLocaleTimeString())
      setMessage(`Cloud connected for ${result.user}; Auth, Postgres and private Storage are reachable.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cloud connection test failed.')
    } finally {
      setLoading(false)
    }
  }

  async function restore(clientId: string, revision?: number) {
    setLoading(true)
    setMessage('')
    try {
      await onRestoreProject(await restoreCloudProject(clientId, revision))
      setMessage(`Cloud revision ${revision ?? 'latest'} restored to this device.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cloud project could not be restored.')
    } finally {
      setLoading(false)
    }
  }

  async function showHistory(clientId: string) {
    if (versions[clientId]) {
      setVersions(current => {
        const next = { ...current }
        delete next[clientId]
        return next
      })
      return
    }
    setLoading(true)
    setMessage('')
    try {
      const history = await listCloudProjectVersions(clientId)
      setVersions(current => ({ ...current, [clientId]: history }))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Project history could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  async function syncLocal() {
    setLoading(true)
    setMessage('')
    try {
      await onSyncLocalProjects()
      await refreshProjects()
      setMessage('Local projects synced. No cloud data was deleted.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Local projects could not be synced.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="dashboard-section cloud-workspace">
      <div className="section-title">
        <div>
          <span className="eyebrow">CLOUD &amp; DEVICE SYNC</span>
          <h2>Keep projects in sync.</h2>
        </div>
        <span className="section-note">
          {configured ? (user ? `Signed in · ${user.email}` : 'Cloud not connected') : 'Cloud not configured'}
        </span>
      </div>
      {!configured ? (
        <p className="assistant-note">
          {cloudConfig.error || 'Cloud sync is unavailable until the hosted app is configured with a Supabase project URL and publishable key.'} Local projects remain available.
        </p>
      ) : (
        <>
          {user ? (
            <div className="cloud-auth-row">
              <span>{user.email}</span>
              <button className="outline-button" type="button" disabled={loading} onClick={() => void testConnection()}>
                Test cloud connection
              </button>
              <button className="outline-button" type="button" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          ) : (
            <form className="cloud-auth-form" onSubmit={event => void submitAuth(event)}>
              <label>
                Email
                <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
              </label>
              <label>
                Password
                <input type="password" autoComplete={isSignUp ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={event => setPassword(event.target.value)} />
              </label>
              <button className="gold-button" type="submit" disabled={loading}>
                {loading ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
              </button>
              <button className="text-button" type="button" onClick={() => setIsSignUp(value => !value)}>
                {isSignUp ? 'Already have an account? Sign in' : 'Create an account'}
              </button>
            </form>
          )}
          {lastCloudTest && <p className="assistant-note">Last successful test: {lastCloudTest}</p>}
          {user && (
            <div className="cloud-sync-options">
              <label className="cloud-checkbox">
                <input type="checkbox" checked={cloudSyncEnabled} onChange={event => onCloudSyncEnabledChange(event.target.checked)} />
                <span>Automatically sync project edits and timeline metadata</span>
              </label>
              <label className="cloud-checkbox">
                <input type="checkbox" checked={mediaSyncEnabled} onChange={event => onMediaSyncEnabledChange(event.target.checked)} />
                <span>Allow private video and audio files to upload to my cloud storage</span>
              </label>
              <p className="assistant-note">
                Media upload is off by default. When enabled, uploads use resumable chunks and private per-user storage. Cloud projects are versioned; newer revisions are never overwritten by stale edits.
              </p>
              <div className="cloud-auth-row">
                <span>{localProjects.length} local project{localProjects.length === 1 ? '' : 's'}</span>
                <button className="outline-button" type="button" disabled={loading || !cloudSyncEnabled} onClick={() => void syncLocal()}>
                  {loading ? 'Syncing…' : 'Sync local projects'}
                </button>
              </div>
              {projects.length > 0 && (
                <div className="cloud-project-list">
                  {projects.map(project => (
                    <article className="cloud-project-row" key={project.client_id}>
                      <div>
                        <strong>{project.name}</strong>
                        <small>Revision {project.revision} · {new Date(project.updated_at).toLocaleString()}</small>
                      </div>
                      <button className="outline-button" type="button" disabled={loading} onClick={() => void restore(project.client_id)}>
                        Restore
                      </button>
                      <button className="outline-button" type="button" disabled={loading} onClick={() => void showHistory(project.client_id)}>
                        {versions[project.client_id] ? 'Hide history' : 'History'}
                      </button>
                    </article>
                  ))}
                  {projects.flatMap(project =>
                    (versions[project.client_id] || []).map(version => (
                      <article className="cloud-project-row cloud-version-row" key={`${project.client_id}-${version.revision}`}>
                        <div>
                          <strong>{project.name} · revision {version.revision}</strong>
                          <small>{new Date(version.created_at).toLocaleString()}</small>
                        </div>
                        <button className="outline-button" type="button" disabled={loading} onClick={() => void restore(project.client_id, version.revision)}>
                          Restore version
                        </button>
                      </article>
                    )),
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {(message || syncMessage) && (
        <p className="connection-test-message" role="status">{message || syncMessage}</p>
      )}
    </section>
  )
}
